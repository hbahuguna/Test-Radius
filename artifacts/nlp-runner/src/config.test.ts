import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultDataDir,
  initConfig,
  loadConfig,
  resolveChromePath,
  resolveGoogleChromePath,
  validateConfig,
} from "./config.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qf-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("applies sane defaults when no env is set", () => {
    const config = loadConfig({});
    expect(config.llm.provider).toBe("openai-compatible");
    expect(config.llm.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.llm.apiKey).toBe("");
    expect(config.llm.model).toBe("gpt-4o-mini");
    expect(config.chromePath).toBe("auto");
    expect(config.dataDir).toBe(defaultDataDir());
  });

  it("overrides defaults from QF_* env vars", () => {
    const config = loadConfig({
      QF_LLM_MODEL: "custom-model",
      QF_LLM_BASE_URL: "https://llm.example.com/v1",
      QF_LLM_API_KEY: "sk-test",
      QF_CHROME_PATH: "/custom/chrome",
      QF_DATA_DIR: "/custom/data",
    });
    expect(config.llm.model).toBe("custom-model");
    expect(config.llm.baseUrl).toBe("https://llm.example.com/v1");
    expect(config.llm.apiKey).toBe("sk-test");
    expect(config.chromePath).toBe("/custom/chrome");
    expect(config.dataDir).toBe("/custom/data");
  });
});

describe("resolveChromePath", () => {
  it("returns the explicit path unchanged when not 'auto'", () => {
    expect(resolveChromePath("/some/path")).toBe("/some/path");
  });

  it("treats 'auto' and empty as auto-detect (never returns the literal value)", () => {
    expect(resolveChromePath("auto")).not.toBe("auto");
    expect(resolveChromePath("")).not.toBe("");
  });
});

describe("resolveGoogleChromePath", () => {
  it("returns the explicit path unchanged when not 'auto'", () => {
    expect(resolveGoogleChromePath("/some/chrome")).toBe("/some/chrome");
  });

  it("honors the QF_GOOGLE_CHROME_PATH env override", () => {
    const prev = process.env.QF_GOOGLE_CHROME_PATH;
    process.env.QF_GOOGLE_CHROME_PATH = "/via/env/chrome";
    try {
      expect(resolveGoogleChromePath("auto", makeTempDir())).toBe("/via/env/chrome");
    } finally {
      if (prev === undefined) {
        delete process.env.QF_GOOGLE_CHROME_PATH;
      } else {
        process.env.QF_GOOGLE_CHROME_PATH = prev;
      }
    }
  });

  it.runIf(process.platform === "darwin")(
    "prefers a Chrome for Testing build from the Playwright cache",
    () => {
      const home = makeTempDir();
      const exe = join(
        home,
        "Library",
        "Caches",
        "ms-playwright",
        "chromium-1217",
        "chrome-mac-x64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
      );
      mkdirSync(exe, { recursive: true });
      writeFileSync(
        join(exe, "Google Chrome for Testing"),
        "fake-cft",
      );
      expect(resolveGoogleChromePath("auto", home)).toBe(
        join(exe, "Google Chrome for Testing"),
      );
    },
  );

  it("falls back to a real Chrome install or any Chromium build", () => {
    const resolved = resolveGoogleChromePath("auto", makeTempDir());
    expect(resolved).not.toBe("");
    expect(resolved).not.toBe("auto");
  });
});

describe("validateConfig", () => {
  it("reports a clear error naming QF_CHROME_PATH for a bad path", () => {
    const result = validateConfig({
      llm: {
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
      },
      chromePath: "/does/not/exist/chrome",
      dataDir: makeTempDir(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("QF_CHROME_PATH");
    }
  });

  it("passes when the chrome path exists and creates the data dir", () => {
    const dir = makeTempDir();
    const chromePath = join(dir, "fake-chrome");
    writeFileSync(chromePath, "#!/bin/sh\nexit 0");

    const dataDir = join(dir, "nested", "data");
    const result = validateConfig({
      llm: {
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
      },
      chromePath,
      dataDir,
    });
    expect(result).toEqual({ ok: true });
    expect(existsSync(dataDir)).toBe(true);
  });

  it("reports a clear error naming QF_DATA_DIR when it cannot be created", () => {
    const dir = makeTempDir();
    const chromePath = join(dir, "fake-chrome");
    writeFileSync(chromePath, "#!/bin/sh\nexit 0");
    const blockingFile = join(dir, "blocked");
    writeFileSync(blockingFile, "not a directory");

    const result = validateConfig({
      llm: {
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
      },
      chromePath,
      dataDir: join(blockingFile, "nested"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain("QF_DATA_DIR");
    }
  });
});

describe("initConfig", () => {
  it("throws with a clear message for invalid config", () => {
    expect(() =>
      initConfig({
        QF_CHROME_PATH: "/does/not/exist/chrome",
        QF_DATA_DIR: makeTempDir(),
      }),
    ).toThrow(/Invalid configuration/);
  });

  it("returns config when valid", () => {
    const dir = makeTempDir();
    const chromePath = join(dir, "fake-chrome");
    writeFileSync(chromePath, "#!/bin/sh\nexit 0");

    const config = initConfig({
      QF_CHROME_PATH: chromePath,
      QF_DATA_DIR: join(dir, "data"),
    });
    expect(config.chromePath).toBe(chromePath);
    expect(config.llm.model).toBe("gpt-4o-mini");
  });
});

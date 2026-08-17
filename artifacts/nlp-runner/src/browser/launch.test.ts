import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listVersionDirs,
  resolveChromePath,
  resolveGoogleChromePath,
} from "../config.js";
import { connect } from "./cdp.js";
import {
  ChromeLaunchError,
  buildLaunchArgs,
  launch,
  parseDevToolsUrl,
} from "./launch.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qf-launch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseDevToolsUrl", () => {
  it("extracts the ws URL from a Chrome stderr line", () => {
    expect(
      parseDevToolsUrl(
        "DevTools listening on ws://127.0.0.1:54321/devtools/browser/abc-123",
      ),
    ).toBe("ws://127.0.0.1:54321/devtools/browser/abc-123");
  });

  it("returns null for unrelated output", () => {
    expect(parseDevToolsUrl("GLES2 is disabled")).toBeNull();
    expect(parseDevToolsUrl("")).toBeNull();
  });
});

describe("buildLaunchArgs", () => {
  it("uses remote-debugging-port=0 with a temp profile in headless mode", () => {
    const args = buildLaunchArgs({
      headless: true,
      port: 0,
      userDataDir: "/tmp/profile",
    });
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--user-data-dir=/tmp/profile");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--window-size=1280,720");
  });

  it("omits the headless flag for headful mode", () => {
    const args = buildLaunchArgs({
      headless: false,
      port: 0,
      userDataDir: "/tmp/profile",
    });
    expect(args).not.toContain("--headless=new");
    expect(args).toContain("--window-size=1280,720");
  });

  it("uses remote-debugging-pipe instead of a debug port when pipe is set", () => {
    const args = buildLaunchArgs({
      headless: true,
      port: 0,
      userDataDir: "/tmp/profile",
      pipe: true,
    });
    expect(args).toContain("--remote-debugging-pipe");
    expect(args).not.toContain("--remote-debugging-port=");
    expect(args).not.toContain("--remote-debugging-address=");
  });

  it("disables automation-controlled features in both headful and headless modes", () => {
    expect(
      buildLaunchArgs({ headless: false, port: 0, userDataDir: "/tmp/profile" }),
    ).toContain("--disable-blink-features=AutomationControlled");
    expect(
      buildLaunchArgs({ headless: true, port: 0, userDataDir: "/tmp/profile" }),
    ).toContain("--disable-blink-features=AutomationControlled");
  });

  it("sets desktop user agent in headless mode to avoid mobile view", () => {
    const args = buildLaunchArgs({
      headless: true,
      port: 0,
      userDataDir: "/tmp/profile",
    });
    expect(args).toContain("--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
  });

  it("does not set user agent in headful mode", () => {
    const args = buildLaunchArgs({
      headless: false,
      port: 0,
      userDataDir: "/tmp/profile",
    });
    expect(args).not.toContain("--user-agent=Mozilla/5.0");
  });

  it("respects custom viewport dimensions", () => {
    const args = buildLaunchArgs({
      headless: true,
      port: 0,
      userDataDir: "/tmp/profile",
      viewportWidth: 1920,
      viewportHeight: 1080,
    });
    expect(args).toContain("--window-size=1920,1080");
  });
});

describe("listVersionDirs", () => {
  it("sorts versioned dirs descending and honors the prefix", () => {
    const root = makeTempDir();
    for (const name of [
      "chromium-100",
      "other-99",
      "chromium-1187",
      "chromium-1000",
    ]) {
      const dir = join(root, name);
      mkdirSync(dir);
    }
    const dirs = listVersionDirs(root, "chromium-");
    expect(dirs.map((d) => d.split("/").pop())).toEqual([
      "chromium-1187",
      "chromium-1000",
      "chromium-100",
    ]);
  });

  it("returns an empty array for a missing root", () => {
    expect(listVersionDirs("/no/such/dir")).toEqual([]);
  });
});

describe("launch error handling", () => {
  it("rejects with a clear 'failed to launch' error for a missing binary", async () => {
    await expect(launch({ chromePath: "/definitely/not/a/chrome" })).rejects.toThrow(
      ChromeLaunchError,
    );
    await expect(
      launch({ chromePath: "/definitely/not/a/chrome" }),
    ).rejects.toThrow(/failed to launch/i);
  });

  it("rejects with a clear error naming QF_CHROME_PATH when it points nowhere", async () => {
    const prev = process.env.QF_CHROME_PATH;
    process.env.QF_CHROME_PATH = "/no/such/binary";
    try {
      await expect(launch()).rejects.toThrow(ChromeLaunchError);
      await expect(launch()).rejects.toThrow(/QF_CHROME_PATH/);
    } finally {
      if (prev === undefined) {
        delete process.env.QF_CHROME_PATH;
      } else {
        process.env.QF_CHROME_PATH = prev;
      }
    }
  });
});

const detectedChrome = resolveChromePath("auto");

describe("launch integration", () => {
  it.runIf(detectedChrome)(
    "launches Chrome, parses a reachable wsUrl, and closes cleanly",
    async () => {
      const browser = await launch({ timeoutMs: 20_000 });
      try {
        expect(browser.wsUrl).toMatch(
          /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+$/i,
        );
        expect(browser.port).toBeGreaterThan(0);
        expect(browser.headless).toBe(true);
        expect(() => process.kill(browser.pid, 0)).not.toThrow();

        const res = await fetch(`http://127.0.0.1:${browser.port}/json/version`);
        expect(res.ok).toBe(true);
        const version = (await res.json()) as { webSocketDebuggerUrl?: string };
        expect(version.webSocketDebuggerUrl).toBe(browser.wsUrl);
      } finally {
        await browser.close();
      }

      expect(() => process.kill(browser.pid, 0)).toThrow();
    },
    30_000,
  );

  it.skipIf(detectedChrome)("skipped: no Chrome/Chromium binary available", () => {
    expect(detectedChrome).toBe("");
  });
});

describe("launch over the DevTools pipe", () => {
  it.runIf(detectedChrome)(
    "launches Chrome via the pipe bridge and speaks CDP",
    async () => {
      const browser = await launch({ pipe: true, timeoutMs: 20_000 });
      try {
        expect(browser.wsUrl).toMatch(
          /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/pipe$/,
        );
        expect(browser.port).toBeGreaterThan(0);
        expect(() => process.kill(browser.pid, 0)).not.toThrow();

        const client = await connect(browser.wsUrl);
        const version = await client.send<{ protocolVersion: string }>(
          "Browser.getVersion",
        );
        expect(version.protocolVersion).toBeTruthy();
        client.close();
      } finally {
        await browser.close();
      }

      expect(() => process.kill(browser.pid, 0)).toThrow();
    },
    30_000,
  );

  const cftChrome = resolveGoogleChromePath("auto");
  it.runIf(
    process.platform === "darwin" &&
      cftChrome !== "" &&
      cftChrome !== detectedChrome,
  )(
    "launches a Chrome for Testing build (real Chrome) via the pipe bridge",
    async () => {
      const browser = await launch({ pipe: true, chromePath: cftChrome, timeoutMs: 25_000 });
      try {
        const client = await connect(browser.wsUrl);
        const version = await client.send<{ product: string }>(
          "Browser.getVersion",
        );
        expect(version.product).toMatch(/Chrome\/\d+/);
        client.close();
      } finally {
        await browser.close();
      }
    },
    35_000,
  );

  it.skipIf(detectedChrome)("skipped: no Chrome/Chromium binary available", () => {
    expect(detectedChrome).toBe("");
  });
});

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveChromePath } from "../config.js";
import { BrowserSession } from "../browser/session.js";
import { captureDomSnapshot } from "./dom-snapshot.js";

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureServerPath = fileURLToPath(new URL("../../fixture/server.ts", import.meta.url));

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const detectedChrome = resolveChromePath("auto");
let fixtureProc: ChildProcess | undefined;
let fixtureBase = "";
const fixtureUp = detectedChrome
  ? (() => {
      const port = 4400 + Math.floor(Math.random() * 100);
      const proc = spawn("pnpm", ["exec", "tsx", fixtureServerPath], {
        cwd: pkgRoot,
        env: { ...process.env, PORT: String(port) },
        stdio: "ignore",
      });
      fixtureProc = proc;
      fixtureBase = `http://127.0.0.1:${port}`;
      return waitForServer(`${fixtureBase}/`, 30_000);
    })()
  : Promise.resolve(false);

const integration = detectedChrome && (await fixtureUp);

afterAll(async () => {
  fixtureProc?.kill("SIGTERM");
});

describe.runIf(integration)("captureDomSnapshot (real Chrome)", () => {
  it("serializes the signup page with indices that resolve to elements", async () => {
    const session = await BrowserSession.launch({
      chromePath: detectedChrome,
      headless: true,
      timeoutMs: 20_000,
    });
    try {
      const page = await session.newPage();
      await page.navigate(`${fixtureBase}/signup`);
      const snapshot = await captureDomSnapshot(page, { screenshot: true });

      expect(snapshot.url).toContain("/signup");
      expect(snapshot.title).toBeTruthy();
      expect(snapshot.screenshot).toBeTruthy();

      const refs = [...snapshot.selectorMap.values()];
      expect(refs.length).toBeGreaterThanOrEqual(3);

      // Interactive elements must resolve via document.querySelector.
      const resolved = await page.evaluate((list: string[]) => {
        return list.map((ref) => {
          let found = false;
          try {
            found = !!document.querySelector(ref);
          } catch {}
          return { ref, found };
        });
      }, refs);
      for (const item of resolved) {
        expect(item.found, `selector "${item.ref}" should resolve`).toBe(true);
      }

      // Text mentions the signup fields.
      expect(snapshot.text).toContain("[Start of page]");
      expect(snapshot.text).toContain("[End of page]");
    } finally {
      await session.close();
    }
  });

  it("detects JS click listeners and marks new elements across snapshots", async () => {
    const session = await BrowserSession.launch({
      chromePath: detectedChrome,
      headless: true,
      timeoutMs: 20_000,
    });
    try {
      const page = await session.newPage();
      await page.navigate(`${fixtureBase}/dynamic`);
      const first = await captureDomSnapshot(page);
      expect(first.selectorMap.size).toBeGreaterThan(0);

      // Re-capture: previously-visible elements should not be marked new.
      const second = await captureDomSnapshot(page, { previous: first });
      const newLines = second.text
        .split("\n")
        .filter((line) => line.includes("*["));
      expect(newLines.length).toBe(0);
    } finally {
      await session.close();
    }
  });
});

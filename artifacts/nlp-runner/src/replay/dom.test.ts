import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveChromePath } from "../config.js";
import { BrowserSession } from "../browser/session.js";
import { resolveElement } from "./dom.js";

// ----- integration bootstrap (gated on chrome + fixture) ----------------------

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureServerPath = fileURLToPath(
  new URL("../../fixture/server.ts", import.meta.url),
);

async function waitForServer(
  baseUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

let fixturePort = 0;
let fixtureProc: ChildProcess | undefined;

const detectedChrome = resolveChromePath("auto");
const fixtureReady = detectedChrome
  ? (() => {
      fixturePort = 3700 + Math.floor(Math.random() * 200);
      fixtureProc = spawn("pnpm", ["exec", "tsx", fixtureServerPath], {
        cwd: pkgRoot,
        env: { ...process.env, PORT: String(fixturePort) },
        stdio: "ignore",
      });
      return waitForServer(`http://127.0.0.1:${fixturePort}/`, 30_000);
    })()
  : Promise.resolve(false);

const integration = detectedChrome && (await fixtureReady);

const sessions: BrowserSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

afterAll(() => {
  fixtureProc?.kill("SIGTERM");
});

const fixtureBase = () => `http://127.0.0.1:${fixturePort}`;

async function newSession(): Promise<BrowserSession> {
  const session = await BrowserSession.launch({ timeoutMs: 20_000 });
  sessions.push(session);
  return session;
}

// ----- tests ------------------------------------------------------------------

describe.runIf(integration)("resolveElement fingerprint parity + ordering", () => {
  it("fingerprint matches when the element is unchanged (parity with Page.fingerprint)", async () => {
    const session = await newSession();
    const page = await session.newPage();
    await page.navigate(`${fixtureBase()}/signup`);

    const fp = await page.fingerprint('[data-testid="signup-result"]');
    const res = await page.evaluate(resolveElement, [
      '[data-testid="signup-result"]',
      "#signup-result",
    ], fp);

    expect(res.found).toBe(true);
    expect(res.fingerprintMatch).toBe(true);
    expect(res.matchedLocator).toBe('[data-testid="signup-result"]');
    expect(res.fingerprint).toBe(fp);
  }, 90_000);

  it("falls back to the next locator when the primary data-testid is removed", async () => {
    const session = await newSession();
    const page = await session.newPage();
    await page.navigate(`${fixtureBase()}/signup`);

    const fp = await page.fingerprint('[data-testid="signup-submit"]');
    const locators = [
      '[data-testid="signup-submit"]',
      "#signup-submit",
      'text="Create account"',
    ];

    // baseline: testid present -> first locator wins, fingerprint matches
    const before = await page.evaluate(resolveElement, locators, fp);
    expect(before.found).toBe(true);
    expect(before.fingerprintMatch).toBe(true);
    expect(before.matchedLocator).toBe('[data-testid="signup-submit"]');

    // remove the primary data-testid: testid locator no longer resolves -> fallback
    await page.evaluate(
      () =>
        document
          .querySelector('[data-testid="signup-submit"]')!
          .removeAttribute("data-testid"),
    );
    const after = await page.evaluate(resolveElement, locators, fp);
    expect(after.found).toBe(true);
    expect(after.fingerprintMatch).toBe(false); // attributes changed -> drift signal
    expect(after.matchedLocator).not.toBe('[data-testid="signup-submit"]');
    expect(after.selector).toBeTruthy();
  }, 90_000);

  it("reports not found when the target element is gone from the page", async () => {
    const session = await newSession();
    const page = await session.newPage();
    await page.navigate(`${fixtureBase()}/signup`);

    const fp = await page.fingerprint('[data-testid="signup-submit"]');
    // wipe the form so nothing matches
    await page.evaluate(
      () => (document.querySelector("#signup-form")!.innerHTML = ""),
    );
    const res = await page.evaluate(resolveElement, [
      '[data-testid="signup-submit"]',
      "#signup-submit",
      'text="Create account"',
    ], fp);

    expect(res.found).toBe(false);
    expect(res.selector).toBeNull();
    expect(res.fingerprintMatch).toBe(false);
  }, 90_000);
});

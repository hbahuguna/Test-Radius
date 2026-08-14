import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import { resolveChromePath } from "../config.js";
import { BrowserSession } from "../browser/session.js";
import { Recorder } from "../recorder/recorder.js";
import { ReplayRunner } from "./engine.js";

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

const detectedChrome = resolveChromePath("auto");
let fixturePort = 0;
let fixtureProc: ChildProcess | undefined;

const fixtureUp = detectedChrome
  ? (() => {
      const port = 3900 + Math.floor(Math.random() * 100);
      const proc = spawn("pnpm", ["exec", "tsx", fixtureServerPath], {
        cwd: pkgRoot,
        env: { ...process.env, PORT: String(port) },
        stdio: "ignore",
      });
      fixtureProc = proc;
      fixturePort = port;
      return waitForServer(`http://127.0.0.1:${port}/`, 30_000);
    })()
  : Promise.resolve(false);

const integration = detectedChrome && (await fixtureUp);
const sessions: BrowserSession[] = [];
const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function makeStore(): DataStore {
  const dir = mkdtempSync(join(tmpdir(), "qf-replay-"));
  tempDirs.push(dir);
  const db = openDatabase(dir);
  openDbs.push(db);
  return new DataStore(db);
}

// ----- tests ------------------------------------------------------------------

describe.runIf(integration)("Replay end-to-end", () => {
  it("record -> replay a signup flow and sees the Welcome message", async () => {
    const store = makeStore();
    const session = await newSession();
    const page = await session.newPage();

    const recorder = new Recorder(page, { settleMs: 50 });
    await recorder.navigate(`${fixtureBase()}/signup`);
    await recorder.fill("[data-testid=signup-name]", "Ada Lovelace");
    await recorder.fill("[data-testid=signup-email]", "ada@example.com");
    await recorder.click("[data-testid=signup-submit]");
    await recorder.saveTest(store, "signup flow");

    const test = store.listTests()[0]!;
    const withSteps = store.getTestWithSteps(test.id)!;
    expect(withSteps.steps.map((s) => s.action)).toEqual([
      "navigate",
      "fill",
      "fill",
      "click",
    ]);

    // replay in a FRESH page
    const replaySession = await newSession();
    const replayPage = await replaySession.newPage();
    const result = await new ReplayRunner(replayPage).runTest(store, withSteps, {
      timeoutMs: 15_000,
    });

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    const resultText = await replayPage.evaluate(
      () => document.querySelector("#signup-result")?.textContent ?? "",
    );
    expect(resultText).toBe("Welcome, Ada Lovelace!");
  }, 90_000);

  it("replays assertion (text/url/visible) and extract steps end-to-end", async () => {
    const store = makeStore();
    const session = await newSession();
    const page = await session.newPage();

    const recorder = new Recorder(page, { settleMs: 50 });
    await recorder.navigate(`${fixtureBase()}/signup`);
    await recorder.fill("[data-testid=signup-name]", "Ada Lovelace");
    await recorder.click("[data-testid=signup-submit]");
    await recorder.assertText("#signup-result", "Welcome");
    await recorder.assertUrl("/signup");
    await recorder.assertVisible("[data-testid=signup-result");
    await recorder.extract("#signup-result", "welcome");
    await recorder.saveTest(store, "signup assertions");

    const withSteps = store.getTestWithSteps(store.listTests()[0]!.id)!;

    const replaySession = await newSession();
    const replayPage = await replaySession.newPage();
    const result = await new ReplayRunner(replayPage).runTest(store, withSteps, {
      timeoutMs: 15_000,
    });

    expect(result.success).toBe(true);
    expect(result.extracted["welcome"]).toBe("Welcome, Ada Lovelace!");
  }, 90_000);

  it("fails cleanly with the step number + intent when an element is gone", async () => {
    const store = makeStore();
    const session = await newSession();
    const page = await session.newPage();

    const recorder = new Recorder(page, { settleMs: 50 });
    await recorder.navigate(`${fixtureBase()}/signup`);
    await recorder.click("[data-testid=signup-submit]");
    await recorder.saveTest(store, "will fail on replay");

    // mutate the saved test: rewrite the click to target a selector that doesn't exist
    const test = store.getTestWithSteps(store.listTests()[0]!.id)!;
    store.updateStep(test.steps[1].id, {
      locators: ["#no-such-element"],
      selector: "#no-such-element",
      elementFingerprint: null,
    });
    const mutated = store.getTestWithSteps(test.id)!;

    const replaySession = await newSession();
    const replayPage = await replaySession.newPage();
    const result = await new ReplayRunner(replayPage).runTest(store, mutated, {
      timeoutMs: 10_000,
    });

    expect(result.success).toBe(false);
    // step 2 is the (mutated) click; intent + step number are present in the error
    expect(result.error).toMatch(/step 2\/2/);
    expect(result.error).toMatch(/Click #no-such-element/);
    expect(result.steps.map((s) => s.status)).toEqual(["passed", "failed"]);

    const run = store.getRun(result.runId)!;
    expect(run.status).toBe("failed");
    expect(run.llmCalls).toBe(0);
  }, 90_000);

  it("writes one PNG per step when --screenshot-dir is given", async () => {
    const store = makeStore();
    const session = await newSession();
    const page = await session.newPage();

    const recorder = new Recorder(page, { settleMs: 50 });
    await recorder.navigate(`${fixtureBase()}/signup`);
    await recorder.click("[data-testid=signup-submit]");
    await recorder.saveTest(store, "screenshot flow");

    const withSteps = store.getTestWithSteps(store.listTests()[0]!.id)!;

    const replaySession = await newSession();
    const replayPage = await replaySession.newPage();
    const shotDir = mkdtempSync(join(tmpdir(), "qf-shots-"));
    const result = await new ReplayRunner(replayPage).runTest(store, withSteps, {
      timeoutMs: 15_000,
      screenshotDir: shotDir,
    });
    expect(result.success).toBe(true);

    const files = await import("node:fs").then((fs) =>
      fs.readdirSync(shotDir),
    );
    expect(files).toHaveLength(withSteps.steps.length);
    expect(files.every((f) => f.endsWith(".png"))).toBe(true);
  }, 90_000);
});

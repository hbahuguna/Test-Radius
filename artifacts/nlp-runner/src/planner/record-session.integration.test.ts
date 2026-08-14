import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import { resolveChromePath } from "../config.js";
import { ReplayRunner } from "../replay/engine.js";
import { RecordSession } from "./record-session.js";
import { BrowserDriverFactory, ReplayDryRunGate } from "./record-cli.js";
import { SmartMockLLM, findByRef } from "./test-utils.js";
import type { SnapshotElement } from "./snapshot.js";

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
let fixturePort = 0;
let fixtureProc: ChildProcess | undefined;
const fixtureUp = detectedChrome
  ? (() => {
      const port = 4200 + Math.floor(Math.random() * 100);
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
const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => fixtureProc?.kill("SIGTERM"));

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "qf-sess-int-"));
  tempDirs.push(dir);
  const db = openDatabase(dir);
  openDbs.push(db);
  return new DataStore(db);
}

describe.runIf(integration)("RecordSession end-to-end (real browser + QF-54 gates)", () => {
  it("records from a query, dry-run replays, minimizes, and caches a replayable test", async () => {
    const store = makeStore();
    const launchOpts = { chromePath: resolveChromePath("auto"), headless: true, timeoutMs: 20_000 };
    const llm = new SmartMockLLM((elements: SnapshotElement[]) => {
      const name = findByRef(elements, "signup-name");
      const email = findByRef(elements, "signup-email");
      const submit = findByRef(elements, "signup-submit");
      if (name && email && submit) {
        return JSON.stringify({
          milestones: ["open signup page", "fill form", "submit"],
          currentMilestone: "submit",
          actions: [
            { type: "fill", ref: name, value: "{name}" },
            { type: "fill", ref: email, value: "{email}" },
            { type: "click", ref: submit },
            { type: "assert", kind: "url", value: "/signup" },
          ],
          done: true,
        });
      }
      return JSON.stringify({
        milestones: ["open signup page", "fill form", "submit"],
        currentMilestone: "open signup page",
        actions: [{ type: "navigate", url: `http://127.0.0.1:${fixturePort}/signup` }],
        done: false,
      });
    });
    const session = new RecordSession(
      llm,
      store,
      new BrowserDriverFactory(store, launchOpts),
      new ReplayDryRunGate(store, launchOpts),
      { auto: true, site: "http://127.0.0.1/" + fixturePort + "/" },
    );
    const out = await session.record("register Ada Lovelace with bob@x.com", "Signup via query");

    expect(out.ok).toBe(true);
    expect(out.report.cached).toBe(true);
    expect(out.report.dryRun.passed).toBe(true);
    expect(out.report.metrics.llmCalls).toBe(2); // 2 LLM turns, no retries
    // minimize drops the redundant url assert
    expect(out.report.minimized.before).toBe(5);
    expect(out.report.minimized.after).toBe(4);
    expect(out.report.error).toBeUndefined();

    const test = store.getTestWithSteps(out.testId!);
    expect(test).toBeTruthy();
    expect(test!.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click"]);
    expect(test!.normalizedQuery).toBe("register {name} with {email}");

    // independent replay of the CACHED test in a fresh browser reproduces the flow
    const { BrowserSession } = await import("../browser/session.js");
    const { ReplayRunner: RR } = await import("../replay/engine.js");
    const replaySession = await BrowserSession.launch({ chromePath: resolveChromePath("auto"), headless: true, timeoutMs: 20_000 });
    try {
      const rPage = await replaySession.newPage();
      const rResult = await new RR(rPage).runTest(store, test!, { timeoutMs: 15_000 });
      expect(rResult.success).toBe(true);
      const text = await rPage.evaluate(() => document.querySelector("#signup-result")?.textContent ?? "");
      expect(text).toBe("Welcome, Ada Lovelace!");
    } finally {
      await replaySession.close();
    }
}, 90_000);
});

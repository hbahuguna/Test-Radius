import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveChromePath } from "../config.js";
import { BrowserSession } from "../browser/session.js";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import type { TestWithSteps } from "../cache/types.js";
import { Recorder } from "../recorder/recorder.js";
import { ReplayRunner } from "./engine.js";
import { LLMStepHealer } from "./heal.js";
import type { LLMMessage, LLMResult } from "../llm/client.js";
import type { AccessibilityNode } from "../browser/session.js";

const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureServerPath = fileURLToPath(new URL("../../fixture/server.ts", import.meta.url));

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
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
const fixtureReady = detectedChrome
  ? (() => {
      fixturePort = 4300 + Math.floor(Math.random() * 100);
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
function newSession(): Promise<BrowserSession> {
  return BrowserSession.launch({ timeoutMs: 20_000 }).then((session) => {
    sessions.push(session);
    return session;
  });
}

function makeStore(): DataStore {
  const dir = mkdtempSync(join(tmpdir(), "qf-heal-"));
  tempDirs.push(dir);
  const db = openDatabase(dir);
  openDbs.push(db);
  return new DataStore(db);
}

// Maps the recorded testid to the redesigned one (must track fixture/redesign.js).
const OLD_TO_DESIGN: Record<string, string> = {
  "signup-name": "signup-full-name",
  "signup-email": "signup-email-address",
  "signup-password": "signup-password-field",
  "signup-submit": "btn-create-account",
};

/**
 * Mock LLM that simulates a self-heal decision. Given the accessibility
 * snapshot (which lists the REDESIGNED elements) and the step intent (which
 * references the *old* locators), it returns the index of the matching
 * redesigned element. No real model.
 */
class FixtureRedesignHealerMock {
  public readonly calls: string[] = [];
  chat(messages: LLMMessage[]): Promise<LLMResult> {
    const prompt = messages.map((m) => m.content).join("\n\n");
    this.calls.push(prompt);
    // The snapshot lists the REDESIGNED elements (new testids); the recorded
    // (old) testids appear only inside the step's intent line. An element step's
    // intent may reference its target either by the old testid (e.g.
    // Fill `[data-testid="signup-name"]`) or by accessible name when the
    // recorder captured a text locator (e.g. Click "Create account"). Names are
    // unchanged by the redesign, so name matching disambiguates clicks. Either
    // way we match against the intent only — not the whole prompt, since the
    // snapshot section lists every element's name.
    const intentMatch = prompt.match(/^The step's intent: "(.*)"\.$/m);
    const intent = intentMatch ? intentMatch[1] : "";
    const newToOld = new Map(
      Object.entries(OLD_TO_DESIGN).map(([old, nw]) => [nw, old]),
    );
    const elementMatches = Array.from(
      prompt.matchAll(/\[(\d+)\] \S+ "([^"]*)" \(([^)]+)\)/g),
    );
    let ref = 0;
    for (const m of elementMatches) {
      const idx = m[1];
      const name = m[2];
      const r = m[3] ?? "";
      const testid = /data-testid="([^"]*)"/.exec(r)?.[1];
      const old = testid ? newToOld.get(testid) : undefined;
      if (old === undefined) continue; // not a redesigned element
      if (
        intent.includes(`data-testid="${old}"`) ||
        intent.includes(`data-testid=${old}`) ||
        (name.length > 0 && intent.includes(name))
      ) {
        ref = Number(idx);
        break;
      }
    }
    return Promise.resolve({ text: JSON.stringify({ ref }) });
  }
}

describe.runIf(integration)("Self-heal on the fixture redesign (QF-64/QF-70)", () => {
  it("records in normal mode, heals on ?redesign=1, and versions the change", async () => {
    const store = makeStore();

    // 1. record a signup flow in NORMAL mode (testids: signup-name/email/submit).
    const recordSession = await newSession();
    const recordPage = await recordSession.newPage();
    const recorder = new Recorder(recordPage, { settleMs: 50 });
    await recorder.navigate(`${fixtureBase()}/signup`);
    await recorder.fill("[data-testid=signup-name]", "Ada");
    await recorder.fill("[data-testid=signup-email]", "ada@example.com");
    await recorder.click("[data-testid=signup-submit]");
    await recorder.saveTest(store, "signup flow");

    const normalTest = store.getTestWithSteps(store.listTests()[0].id)!;
    expect(normalTest.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click"]);

    // 2. record an initial clean run (no redesign -> should pass, no heal).
    const cleanSession = await newSession();
    const cleanPage = await cleanSession.newPage();
    const cleanResult = await new ReplayRunner(cleanPage).runTest(store, normalTest, {
      timeoutMs: 15_000,
    });
    expect(cleanResult.success).toBe(true);
    expect(cleanResult.selfHealed).toBe(0);

    // 3. replay on the REDESIGN page with an LLM healer mocked to return the
    //    redesigned refs. The cached testids no longer match -> heal path.
    const mockLlm = new FixtureRedesignHealerMock();
    const healer = new LLMStepHealer(mockLlm);
    const healSession = await newSession();
    const healPage = await healSession.newPage();
    await healPage.navigate(`${fixtureBase()}/signup?redesign=1`);
    // sanity: confirm the redesign renamed the submit testid
    const probe = await healPage.evaluate(
      () => document.querySelector("[data-testid=btn-create-account]")?.tagName ?? "none",
    );
    expect(probe).toBe("BUTTON");
    const result = await new ReplayRunner(healPage).runTest(store, normalTest, {
      timeoutMs: 15_000,
      healer,
    });
    // the element steps (2 fills + 1 click) each triggered a heal
    expect(result.success).toBe(true);
    expect(result.selfHealed).toBe(3);
    expect(result.llmCalls).toBe(3); // one chat call per healed step

    const welcome = await healPage.evaluate(
      () => document.querySelector("#signup-result")?.textContent ?? "",
    );
    expect(welcome).toBe("Welcome, Ada!");

    // 4. version history records baseline + healed versions (QF-68)
    const versions = store.listVersionsByTest(normalTest.id);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const reasons = versions.map((v) => v.reason ?? "");
    expect(reasons.some((r) => /baseline before self-heal/.test(r))).toBe(true);
    expect(reasons.some((r) => /self-heal/.test(r))).toBe(true);

    // 5. re-running on the redesigned page passes WITHOUT an LLM (cached healed locators)
    const replaySession = await newSession();
    const replayPage = await replaySession.newPage();
    // Each `newSession()` launches an isolated Chrome profile (fresh
    // sessionStorage), so the redesign must be (re)applied here — mirroring the
    // heal run above — for the persisted healed locators to resolve.
    await replayPage.navigate(`${fixtureBase()}/signup?redesign=1`);
    const cachedResult = await new ReplayRunner(replayPage).runTest(store, normalTest, {
      timeoutMs: 15_000,
      // no healer: cached (healed) locators must resolve directly
    });
    expect(cachedResult.success).toBe(true);
    expect(cachedResult.selfHealed).toBe(0);
  }, 120_000);
});

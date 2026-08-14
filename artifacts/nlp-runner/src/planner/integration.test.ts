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
import { RecorderDriver } from "./recorder-driver.js";
import { RecordAgent } from "./agent.js";
import { SmartMockLLM, findByRef } from "./test-utils.js";

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
      const port = 4100 + Math.floor(Math.random() * 100);
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

describe.runIf(integration)("RecordAgent end-to-end (real browser + fixture)", () => {
  it("records a signup flow from a query and stores it for replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qf-agent-"));
    tempDirs.push(dir);
    const db = openDatabase(dir);
    openDbs.push(db);
    const store = new DataStore(db);

    const session = await BrowserSession.launch({ timeoutMs: 20_000 });
    sessions.push(session);
    const page = await session.newPage();
    const driver = new RecorderDriver(page, store);

    const llm = new SmartMockLLM((elements) => {
      const nameIdx = findByRef(elements, "signup-name");
      const emailIdx = findByRef(elements, "signup-email");
      const submitIdx = findByRef(elements, "signup-submit");
      if (nameIdx && emailIdx && submitIdx) {
        return JSON.stringify({
          milestones: ["open signup page", "fill form", "submit and confirm"],
          actions: [
            { type: "fill", ref: nameIdx, value: "{name}" },
            { type: "fill", ref: emailIdx, value: "{email}" },
            { type: "click", ref: submitIdx },
            { type: "assert", kind: "url", value: "/signup" },
          ],
          done: true,
        });
      }
      return JSON.stringify({
        milestones: ["open signup page", "fill form", "submit and confirm"],
        actions: [{ type: "navigate", url: `http://127.0.0.1:${fixturePort}/signup` }],
        done: false,
      });
    });

    const agent = new RecordAgent(llm, driver, { staleThreshold: 10, maxTurns: 8, maxSteps: 20 });
    const res = await agent.record("register Ada Lovelace with bob@x.com", "Signup via query");

    expect(res.ok).toBe(true);
    expect(res.steps).toBe(5); // navigate + 2 fills + click + assert
    expect(driver.getSteps().map((s) => s.action)).toEqual([
      "navigate", "fill", "fill", "click", "assert",
    ]);
    // {name}/{email} placeholders resolved to concrete slot values (QF-53)
    const fills = driver.getSteps().filter((s) => s.action === "fill");
    expect(fills.map((s) => s.value)).toEqual(["Ada Lovelace", "bob@x.com"]);
    expect(res.milestones).toEqual(["open signup page", "fill form", "submit and confirm"]);

    // stored test: canonical query + slots persisted (QF-53)
    const test = store.getTest(store.listTests()[0]!.id)!;
    expect(test.normalizedQuery).toBe("register {name} with {email}");
    const slots = store.listSlotsByTest(test.id);
    expect(slots.map((s) => s.kind).sort()).toEqual(["email", "name"]);
    const emailSlot = slots.find((s) => s.kind === "email")!;
    expect(emailSlot.defaultValue).toBe("bob@x.com");

    // replay reproduces the recorded steps in a fresh page
    const { ReplayRunner } = await import("../replay/engine.js");
    const replaySession = await BrowserSession.launch({ timeoutMs: 20_000 });
    sessions.push(replaySession);
    const replayPage = await replaySession.newPage();
    const withSteps = store.getTestWithSteps(test.id)!;
    const replay = await new ReplayRunner(replayPage).runTest(store, withSteps, {
      timeoutMs: 15_000,
    });
    expect(replay.success).toBe(true);
    expect(replay.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    const resultText = await replayPage.evaluate(
      () => document.querySelector("#signup-result")?.textContent ?? "",
    );
    expect(resultText).toBe("Welcome, Ada Lovelace!");
  }, 90_000);
});

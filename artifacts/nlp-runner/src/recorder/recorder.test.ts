import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import { resolveChromePath } from "../config.js";
import { BrowserSession, type Page } from "../browser/session.js";
import { hashSteps, Recorder, type RecordedStep } from "./recorder.js";
import { detectSlot, detectSlotKind } from "./slots.js";

describe("slot detection", () => {
  it("detects email values", () => {
    expect(detectSlotKind("bob@x.com")).toBe("email");
    expect(detectSlot("bob@x.com")).toEqual({ name: "email", kind: "email" });
  });

  it("detects numbers and names, leaves generic text null", () => {
    expect(detectSlotKind("1,234.5")).toBe("number");
    expect(detectSlotKind("Ada Lovelace")).toBe("name");
    expect(detectSlotKind("hello world")).toBeNull();
  });
});

describe("hashSteps", () => {
  const step = (): RecordedStep => ({
    action: "click",
    selector: "#go",
    value: null,
    locators: ["#go"],
    elementFingerprint: "fp1",
    pageSignatureBefore: "sig1",
    pageSignatureAfter: "sig2",
    waitCondition: { kind: "element", ref: "#result" },
    assertion: null,
  });

  it("is deterministic for identical steps", () => {
    expect(hashSteps([step()])).toBe(hashSteps([step()]));
  });

  it("changes when the recorded action changes", () => {
    const changed = { ...step(), action: "fill" as const, value: "x" };
    expect(hashSteps([changed])).not.toBe(hashSteps([step()]));
  });

  it("is sensitive to element fingerprint changes", () => {
    const changed = { ...step(), elementFingerprint: "fp2" };
    expect(hashSteps([changed])).not.toBe(hashSteps([step()]));
  });
});

// ----- integration (gated on chrome + fixture) ------------------------------

const detectedChrome = resolveChromePath("auto");
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
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

let fixturePort = 0;
let fixtureProc: ChildProcess | undefined;

if (detectedChrome) {
  fixturePort = 3500 + Math.floor(Math.random() * 200);
  fixtureProc = spawn("pnpm", ["exec", "tsx", fixtureServerPath], {
    cwd: pkgRoot,
    env: { ...process.env, PORT: String(fixturePort) },
    stdio: "ignore",
  });
}

const fixtureUp = detectedChrome
  ? await waitForServer(`http://127.0.0.1:${fixturePort}/`, 10_000)
  : false;

afterAll(() => {
  fixtureProc?.kill("SIGTERM");
});

const integration = detectedChrome && fixtureUp;
const sessions: BrowserSession[] = [];
const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixtureBase = () => `http://127.0.0.1:${fixturePort}`;

async function newSession(): Promise<BrowserSession> {
  const session = await BrowserSession.launch({ timeoutMs: 20_000 });
  sessions.push(session);
  return session;
}

async function recordSignupFlow(recorder: Recorder): Promise<void> {
  await recorder.navigate(`${fixtureBase()}/signup`);
  await recorder.fill("[data-testid=signup-name]", "Ada Lovelace");
  await recorder.fill("[data-testid=signup-email]", "ada@example.com");
  await recorder.click("[data-testid=signup-submit]");
}

describe.runIf(integration)("Recorder integration", () => {
    it("records a navigate/fill/click flow with full step metadata", async () => {
      const session = await newSession();
      const page = await session.newPage();
      const recorder = new Recorder(page, { settleMs: 20 });

    await recordSignupFlow(recorder);

    const steps = recorder.getSteps();
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click"]);

    const [nav, fillName, fillEmail, click] = steps;

    // navigate
    expect(nav.selector).toBeNull();
    expect(nav.value).toContain("/signup");
    expect(nav.pageSignatureAfter).toBeTruthy();
    expect(nav.waitCondition).toMatchObject({ kind: "url", contains: expect.stringContaining("/signup") });

    // fills: stable testid-first locators + fingerprint + signatures
    expect(fillName.locators[0]).toBe('[data-testid="signup-name"]');
    expect(fillName.locators).toContain("#signup-name");
    expect(fillName.elementFingerprint).toBeTruthy();
    expect(fillName.pageSignatureBefore).toBeTruthy();
    expect(fillName.pageSignatureAfter).toBeTruthy();
    expect(fillName.waitCondition).toMatchObject({ kind: "element" });

    expect(fillEmail.locators[0]).toBe('[data-testid="signup-email"]');
    expect(fillEmail.value).toBe("ada@example.com");

    // click: wait condition is the post-action expectation
    expect(click.locators[0]).toBe('[data-testid="signup-submit"]');
    expect(click.elementFingerprint).toBeTruthy();
    expect(click.waitCondition).not.toBeNull();
    if (click.waitCondition?.kind === "element") {
      expect(click.waitCondition.ref).toBeTruthy();
    }

    // slots detected from variable-like fill values
    expect(recorder.getSlots()).toEqual([
      { name: "name", kind: "name", defaultValue: "Ada Lovelace" },
      { name: "email", kind: "email", defaultValue: "ada@example.com" },
    ]);
    expect(recorder.getEntryUrl()).toContain("/signup");
  }, 60_000);

  it("saveTest persists a flow; re-recording the same flow updates in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qf-rec-"));
    tempDirs.push(dir);
    const db = openDatabase(dir);
    openDbs.push(db);
    const store = new DataStore(db);

    const session = await newSession();

    const page1 = await session.newPage();
    const rec1 = new Recorder(page1, { settleMs: 20 });
    await recordSignupFlow(rec1);
    const saved1 = await rec1.saveTest(store, "signup flow");
    expect(saved1.created).toBe(true);
    expect(store.getTestWithSteps(saved1.id)?.steps).toHaveLength(4);
    expect(store.listSlotsByTest(saved1.id)).toHaveLength(2);

    const page2 = await session.newPage();
    const rec2 = new Recorder(page2, { settleMs: 20 });
    await recordSignupFlow(rec2);
    const saved2 = await rec2.saveTest(store, "signup flow");
    expect(saved2.id).toBe(saved1.id);
    expect(saved2.created).toBe(false);
    expect(store.listTests()).toHaveLength(1);
    expect(store.getTestWithSteps(saved1.id)?.steps).toHaveLength(4);
  }, 60_000);

  it("re-recording a different flow creates a separate test", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qf-rec2-"));
    tempDirs.push(dir);
    const db = openDatabase(dir);
    openDbs.push(db);
    const store = new DataStore(db);

    const session = await newSession();

    const page1 = await session.newPage();
    const rec1 = new Recorder(page1, { settleMs: 20 });
    await recordSignupFlow(rec1);
    const saved1 = await rec1.saveTest(store, "signup flow");

    const page2 = await session.newPage();
    const rec2 = new Recorder(page2, { settleMs: 20 });
    await rec2.navigate(`${fixtureBase()}/signup`);
    await rec2.fill("[data-testid=signup-email]", "ada@example.com");
    await rec2.click("[data-testid=signup-submit]");
    const saved2 = await rec2.saveTest(store, "signup no-name");

    expect(saved2.id).not.toBe(saved1.id);
    expect(store.listTests()).toHaveLength(2);
  }, 60_000);
});

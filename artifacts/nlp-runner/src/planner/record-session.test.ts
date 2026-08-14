import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import { RecordAgent } from "./agent.js";
import { RecordSession } from "./record-session.js";
import { MockLLMClient, MockDriver } from "./test-utils.js";
import type { SnapshotPayload, SnapshotElement } from "./snapshot.js";
import type { DryRunGate, DriverFactory, DriverBundle } from "./record-session.js";
import type { Page } from "../browser/session.js";
import type { StepAction } from "../cache/types.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "qf-session-"));
  const db = openDatabase(dir);
  return { dir, store: new DataStore(db), db };
}

const SIGNUP = (): SnapshotPayload =>
  MockDriver.page(
    [
      { role: "textbox", name: "Name", ref: '[data-testid="signup-name"]' },
      { role: "textbox", name: "Email", ref: '[data-testid="signup-email"]' },
      { role: "button", name: "Submit", ref: '[data-testid="signup-submit"]' },
      { role: "button", name: "Assert", ref: '[data-testid="assert"]' },
    ],
    "https://example.com/signup",
    "Sign up — Fixture",
  );

function plan(overrides: { milestones?: string[]; currentMilestone?: string; actions?: unknown[]; done?: boolean }): string {
  return JSON.stringify({
    milestones: overrides.milestones,
    currentMilestone: overrides.currentMilestone,
    actions: overrides.actions,
    done: overrides.done ?? false,
  });
}

interface GateResp { success: boolean; error?: string; failingStep?: number }

class ScriptedGate implements DryRunGate {
  readonly calls: Array<{ steps: number; success: boolean; error?: string; failingStep?: number }> = [];
  closed = false;
  constructor(private readonly responses: GateResp[]) {}
  async dryRun(test: Parameters<DryRunGate["dryRun"]>[0]): Promise<{ success: boolean; error?: string; failingStep?: number }> {
    const resp = this.responses.shift() ?? this.responses[this.responses.length - 1] ?? { success: true };
    this.calls.push({ steps: test.steps.length, ...(resp as { success: boolean }) });
    return resp;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeFactory implements DriverFactory {
  created = 0;
  constructor(private readonly store: DataStore, private readonly recipe: (store: DataStore) => MockDriver) {}
  async create(): Promise<DriverBundle> {
    this.created++;
    const driver = this.recipe(this.store);
    return { driver, page: {} as unknown as Page, close: async () => {} } as unknown as DriverBundle;
  }
}

function signupDriver(): MockLLMClient {
  const llm = new MockLLMClient([
    plan({ milestones: ["open signup", "fill form", "submit"], currentMilestone: "open signup", actions: [{ type: "navigate", url: "https://example.com/signup" }] }),
    plan({ currentMilestone: "fill form", actions: [{ type: "fill", ref: 1, value: "{name}" }, { type: "fill", ref: 2, value: "{email}" }] }),
    plan({ currentMilestone: "submit", actions: [{ type: "click", ref: 3 }, { type: "assert", kind: "url", value: "/signup" }], done: true }),
  ]);
  return llm;
}

describe("RecordSession confirm mode (QF-55)", () => {
  it("aborts cleanly at a milestone when the user declines, without caching", async () => {
    const { store, dir, db } = makeStore();
    const confirmed: string[] = [];
    const confirm = async (m: string) => { confirmed.push(m); return m === "open signup"; }; // decline on 2nd milestone
    const llm = new MockLLMClient([
      plan({ milestones: ["open signup", "fill form", "submit"], currentMilestone: "open signup", actions: [{ type: "navigate", url: "https://example.com/signup" }] }),
      plan({ currentMilestone: "fill form", actions: [{ type: "fill", ref: 1, value: "{name}" }] }),
    ]);
    const factory = new FakeFactory(store, (store) => new MockDriver({
      store,
      snapshots: [MockDriver.page([]), SIGNUP()],
      signatures: ["blank", "signup"],
      signaturesByIndex: true,
    }));
    const gate = new ScriptedGate([{ success: true }]);
    const session = new RecordSession(llm, store, factory, gate, { confirm, site: "https://example.com/" });
    const out = await session.record("register Ada Lovelace with bob@x.com", "Signup");

    expect(out.ok).toBe(false);
    expect(out.report.cached).toBe(false);
    expect(out.report.error).toMatch(/aborted by user/i);
    // the user was prompted at least up to the declined milestone
    expect(confirmed[0]).toBe("open signup");
    expect(confirmed).toContain("fill form");
    expect(store.listTests()).toHaveLength(0); // nothing cached
    expect(gate.closed).toBe(true); // gate's browser session released on every record path
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto mode proceeds without prompting", async () => {
    const { store, dir, db } = makeStore();
    const llm = signupDriver();
    let confirmCalls = 0;
    const confirm = async () => { confirmCalls++; return true; };
    const factory = new FakeFactory(store, (store) => new MockDriver({
      store,
      snapshots: [MockDriver.page([]), SIGNUP(), SIGNUP()],
      signatures: ["blank", "signup", "signup2"],
      signaturesByIndex: true,
    }));
    const gate = new ScriptedGate([
      { success: true },   // attempt1 dry-run (full)
      { success: true },   // minimize candidate
    ]);
    const session = new RecordSession(llm, store, factory, gate, { site: "https://example.com/", auto: true, confirm });
    const out = await session.record("register Ada Lovelace with bob@x.com", "Signup");
    expect(out.ok).toBe(true);
    expect(out.report.cached).toBe(true);
    expect(confirmCalls).toBe(0); // auto mode never prompts
    expect(store.listTests()).toHaveLength(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("RecordSession dry-run gate + re-plan-from-failure (QF-56)", () => {
  it("re-records from the failure point and caches after dry-run passes", async () => {
    const { store, dir, db } = makeStore();
    // attempt1: 3 LLM calls (navigate; fill+click; assert) then dry-run FAILS
    // attempt2: resume -> re-record (3 calls) then dry-run PASSES + minimize pass
    const llm = new MockLLMClient([
      // attempt 1
      plan({ milestones: ["open", "fill", "submit"], currentMilestone: "open", actions: [{ type: "navigate", url: "https://example.com/signup" }] }),
      plan({ currentMilestone: "fill", actions: [{ type: "fill", ref: 1, value: "{name}" }, { type: "fill", ref: 2, value: "{email}" }] }),
      plan({ currentMilestone: "submit", actions: [{ type: "click", ref: 3 }, { type: "assert", kind: "url", value: "/signup" }], done: true }),
      // attempt 2 (resume)
      plan({ milestones: ["open", "fill", "submit"], currentMilestone: "open", actions: [{ type: "navigate", url: "https://example.com/signup" }] }),
      plan({ currentMilestone: "fill", actions: [{ type: "fill", ref: 1, value: "{name}" }, { type: "fill", ref: 2, value: "{email}" }] }),
      plan({ currentMilestone: "submit", actions: [{ type: "click", ref: 3 }, { type: "assert", kind: "url", value: "/signup" }], done: true }),
    ]);
    const factory = new FakeFactory(store, (store) => new MockDriver({
      store,
      snapshots: [MockDriver.page([]), SIGNUP(), SIGNUP()],
      signatures: ["blank", "signup", "signup2"],
      signaturesByIndex: true,
    }));
    // attempt1 dry-run fails (failingStep 3); attempt2 dry-run passes; minimize candidate passes
    const gate = new ScriptedGate([
      { success: false, error: "step 3/4: click — element not found", failingStep: 3 },
      { success: true },
      { success: true },
    ]);
    const session = new RecordSession(llm, store, factory, gate);
    const out = await session.record("register Ada Lovelace with bob@x.com", "Signup");

    expect(out.ok).toBe(true);
    expect(out.report.dryRun.attempts).toBe(2);
    expect(out.report.dryRun.passed).toBe(true);
    expect(out.report.cached).toBe(true);
    expect(factory.created).toBe(2); // two record attempts
    // the second attempt was seeded with the resume hint
    expect(llm.prompts.some((p) => p.includes("RESUME"))).toBe(true);
    expect(store.listTests()).toHaveLength(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT cache when dry-run keeps failing up to the attempt cap", async () => {
    const { store, dir, db } = makeStore();
    const llm = new MockLLMClient([
      plan({ milestones: ["open"], currentMilestone: "open", actions: [{ type: "navigate", url: "https://example.com/signup" }], done: true }),
      plan({ milestones: ["open"], currentMilestone: "open", actions: [{ type: "navigate", url: "https://example.com/signup" }], done: true }),
    ]);
    const factory = new FakeFactory(store, (store) => new MockDriver({
      store,
      snapshots: [SIGNUP()],
      signatures: ["signup"],
      signaturesByIndex: true,
    }));
    const gate = new ScriptedGate([
      { success: false, error: "step 1: url mismatch", failingStep: 1 },
      { success: false, error: "step 1: url mismatch", failingStep: 1 },
    ]);
    const session = new RecordSession(llm, store, factory, gate, { maxDryRunAttempts: 2 });
    const out = await session.record("noop query", "Bad");
    expect(out.ok).toBe(false);
    expect(out.report.dryRun.attempts).toBe(2);
    expect(out.report.dryRun.passed).toBe(false);
    expect(out.report.cached).toBe(false);
    expect(store.listTests()).toHaveLength(0); // nothing cached
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("RecordSession macro minimizer (QF-57)", () => {
  it("drops a removable step when the dry-run still passes and reports counts", async () => {
    const { store, dir, db } = makeStore();
    const llm = new MockLLMClient([
      plan({ milestones: ["open", "fill", "submit"], currentMilestone: "open", actions: [{ type: "navigate", url: "https://example.com/signup" }] }),
      plan({ currentMilestone: "fill", actions: [{ type: "fill", ref: 1, value: "{name}" }, { type: "fill", ref: 2, value: "{email}" }] }),
      plan({ currentMilestone: "submit", actions: [{ type: "click", ref: 3 }, { type: "assert", kind: "url", value: "/signup" }], done: true }),
    ]);
    const factory = new FakeFactory(store, (store) => new MockDriver({
      store,
      snapshots: [MockDriver.page([]), SIGNUP(), SIGNUP()],
      signatures: ["blank", "signup", "signup2"],
      signaturesByIndex: true,
    }));
    // full test (4 steps incl assert) passes; removing assert (3 steps) also passes
    const gate = new ScriptedGate([
      { success: true }, // full
      { success: true }, // candidate without assert
    ]);
    const session = new RecordSession(llm, store, factory, gate, { minimizeKinds: ["assert" as StepAction] });
    const out = await session.record("register Ada Lovelace with bob@x.com", "Signup");
    expect(out.ok).toBe(true);
    expect(out.report.minimized.before).toBe(5);
    expect(out.report.minimized.after).toBe(4);
    const test = store.getTestWithSteps(store.listTests()[0].id);
    expect(test?.steps).toHaveLength(4);
    expect(test?.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click"]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("RecordSession record report (QF-58)", () => {
  it("populates all report fields from observed metrics", async () => {
    const { store, dir, db } = makeStore();
    const llm = signupDriver();
    const factory = new FakeFactory(store, (store) => new MockDriver({
      store,
      snapshots: [MockDriver.page([]), SIGNUP(), SIGNUP()],
      signatures: ["blank", "signup", "signup2"],
      signaturesByIndex: true,
    }));
    const gate = new ScriptedGate([{ success: true }, { success: true }]);
    const session = new RecordSession(llm, store, factory, gate, { site: "https://example.com/" });
    const out = await session.record("register Ada Lovelace with bob@x.com", "Signup");
    const r = out.report;
    expect(r.testName).toBe("Signup");
    expect(r.query).toBe("register Ada Lovelace with bob@x.com");
    expect(r.cached).toBe(true);
    expect(r.milestones).toEqual(["open signup", "fill form", "submit"]);
    expect(r.metrics.turns).toBeGreaterThan(0);
    expect(r.metrics.steps).toBe(5);
    expect(r.metrics.llmCalls).toBe(3);
    expect(r.metrics.backtracks).toBe(0);
    expect(r.metrics.guardFires).toBe(0);
    expect(r.dryRun).toEqual({ passed: true, attempts: 1 });
    expect(r.minimized.before).toBe(5);
    expect(r.minimized.after).toBe(4); // default minimizeKinds drops the redundant assert
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("RecordSession site memory (QF-59)", () => {
  it("seeds and retrieves a skeleton; clearing disables transfer", async () => {
    const { store, dir, db } = makeStore();
    const { seedSiteMemory, getSkeleton, clearSiteMemory } = await import("./site-memory.js");
    // seed a skeleton for the domain
    const testRow = { id: 42, name: "old", source: "recorder" as const, entryUrl: "https://example.com/signup", normalizedQuery: "register {name} with {email}", query: "register Ada Lovelace with bob@x.com", stepHash: "h", description: null, createdAt: "", updatedAt: "" } as any;
    const steps = [{ id: 1, testId: 42, idx: 0, action: "click" as const, selector: "x", value: null, locators: [], elementFingerprint: "fp", pageSignatureBefore: "a", pageSignatureAfter: "b", waitCondition: null, assertion: null }];
    seedSiteMemory(store, testRow, steps as any, [{ kind: "email" as const, defaultValue: "bob@x.com" }, { kind: "name" as const, defaultValue: "Ada Lovelace" }], ["open", "fill"]);
    expect(getSkeleton(store, "https://example.com/")?.testId).toBe(42);

    // recording on the same domain pulls the skeleton as a resume hint
    const llm = signupDriver();
    const factory = new FakeFactory(store, (store) => new MockDriver({
      store,
      snapshots: [MockDriver.page([]), SIGNUP(), SIGNUP()],
      signatures: ["blank", "signup", "signup2"],
      signaturesByIndex: true,
    }));
    const gate = new ScriptedGate([{ success: true }, { success: true }]);
    const session = new RecordSession(llm, store, factory, gate, { site: "https://example.com/" });
    const out = await session.record("register Ada Lovelace with bob@x.com", "Signup");
    expect(out.ok).toBe(true);
    expect(llm.prompts.some((p) => p.includes("test #42"))).toBe(true);

    // clearing memory disables transfer
    clearSiteMemory(store, "https://example.com/");
    expect(getSkeleton(store, "https://example.com/")).toBeNull();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

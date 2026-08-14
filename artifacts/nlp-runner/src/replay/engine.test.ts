import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "../browser/session.js";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import type { Step, TestWithSteps } from "../cache/types.js";
import { applyVariables, ReplayRunner, type ReplayResult } from "./engine.js";
import type { HealResult, StepHealer } from "./heal.js";
import { stepToEnglish } from "../util/describe.js";

const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

function makeStore(): DataStore {
  const dir = mkdtempSync(join(tmpdir(), "qf-replay-"));
  tempDirs.push(dir);
  const db = openDatabase(dir);
  openDbs.push(db);
  return new DataStore(db);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 1,
    testId: 1,
    idx: 0,
    action: "click",
    selector: "[data-testid=signup-submit]",
    value: null,
    locators: ['[data-testid="signup-submit"]', 'text="Create account"'],
    elementFingerprint: "fp",
    pageSignatureBefore: null,
    pageSignatureAfter: null,
    waitCondition: null,
    assertion: null,
    ...overrides,
  };
}

function makeTest(store: DataStore, steps: Step[]): TestWithSteps {
  const test = store.createTest({ name: "signup flow", source: "template" });
  for (const step of steps) store.addStep(test.id, step);
  const saved = store.getTestWithSteps(test.id)!;
  saved.steps.forEach((s, i) => {
    s.id = i + 1;
    s.idx = i;
  });
  return saved;
}

/** Minimal in-memory Page double implementing the surface the engine uses. */
class FakePage implements Pick<Page, "evaluate" | "click" | "fill" | "select" | "scroll"> {
  url = "http://localhost:3123/signup";
  clicks: string[] = [];
  fills: [string, string][] = [];
  selects: [string, string][] = [];
  scrolls: string[] = [];
  resolveResult = {
    found: true,
    selector: "[data-testid=signup-submit]",
    fingerprint: "fp",
    fingerprintMatch: true,
    matchedLocator: "[data-testid=signup-submit]",
  } as {
    found: boolean;
    selector: string | null;
    fingerprint: string | null;
    fingerprintMatch: boolean;
    matchedLocator: string | null;
  };
   textValue = "Welcome, Ada";
   visible = true;
   pageSignatureValue = "sig1";
   /** resolveElement calls are counted so tests can simulate retry-then-found. */
   resolveAttempts = 0;
   /** number of leading resolveElement attempts that should return a miss. */
   resolveFailTimes = 0;
   /** getBoundingClientRect (visibility) checks are counted so tests can
    * simulate an element becoming visible after N polls. */
   visibleChecks = 0;
   /** when set, element is hidden until this many visibility checks have
    * happened (then stays visible). Undefined keeps `visible` behavior. */
   visibleFlipAfter?: number = undefined;


  async navigate(url: string): Promise<void> {
    this.url = url;
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    this.fills.push([selector, value]);
  }

  async select(selector: string, value: string): Promise<void> {
    this.selects.push([selector, value]);
  }

  async scroll(selector: string): Promise<void> {
    this.scrolls.push(selector);
  }

  async getUrl(): Promise<string> {
    return this.url;
  }

  async pageSignature(): Promise<string> {
    return this.pageSignatureValue;
  }

  async screenshot(): Promise<string> {
    return "png";
  }

  async evaluate<T = unknown>(
    fn: string | ((...args: unknown[]) => T),
    ...args: unknown[]
  ): Promise<T> {
    const body = typeof fn === "string" ? fn : fn.toString();
    if (body.includes("elementFingerprintSource") || body.includes("expectedFingerprint")) {
      const locators = args[0] as string[];
      this.resolveAttempts++;
      if (this.resolveAttempts <= this.resolveFailTimes) {
        return {
          found: false,
          selector: null,
          fingerprint: null,
          fingerprintMatch: false,
          matchedLocator: null,
        } as T;
      }
      return {
        ...this.resolveResult,
        selector: this.resolveResult.found ? locators[0] : null,
      } as T;
    }
    if (body.includes("querySelector(sel)") && body.includes("textContent")) {
      return this.textValue as T;
    }
    if (body.includes("querySelector(sel)") && body.includes(".value")) {
      return this.textValue as T;
    }
    if (body.includes("getBoundingClientRect")) {
      this.visibleChecks++;
      if (this.visibleFlipAfter !== undefined) {
        return (this.visibleChecks >= this.visibleFlipAfter) as T;
      }
      return this.visible as T;
    }
    throw new Error(`FakePage.evaluate: unexpected function ${body.slice(0, 60)}`);
  }
}

describe("applyVariables", () => {
  it("maps slot defaults to provided variable values", () => {
    const map = applyVariables(
      [
        { name: "email", defaultValue: "ada@example.com" },
        { name: "name", defaultValue: "Ada" },
      ],
      { email: "jane@y.com" },
    );
    expect(map.get("ada@example.com")).toBe("jane@y.com");
    expect(map.has("Ada")).toBe(false);
  });
});

describe("ReplayRunner.runTest", () => {
  it("runs every step and records a passed run", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({ action: "navigate", selector: null, value: "http://localhost:3123/signup", locators: [] }),
      makeStep({ action: "fill", selector: "#signup-name", value: "Ada", locators: ["#signup-name"] }),
      makeStep({ action: "click" }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed"]);
    expect(page.fills).toEqual([["#signup-name", "Ada"]]);
    expect(page.clicks).toEqual(['[data-testid="signup-submit"]']);

    const run = store.getRun(result.runId)!;
    expect(run.status).toBe("passed");
    expect(run.llmCalls).toBe(0);
    const steps = store.listRunStepsByRun(result.runId);
    expect(steps.map((s) => s.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("substitutes slot values from --variables into fill steps", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({ action: "fill", selector: "#signup-email", value: "ada@example.com", locators: ["#signup-email"] }),
    ]);
    store.addSlot(test.id, { name: "email", kind: "email", defaultValue: "ada@example.com" });

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      variables: { email: "jane@y.com" },
    });

    expect(result.success).toBe(true);
    expect(page.fills).toEqual([["#signup-email", "jane@y.com"]]);
  });

  it("records failed and skipped steps and finishes the run as failed", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.resolveResult = { ...page.resolveResult, found: false, selector: null };
    const test = makeTest(store, [
      makeStep({ action: "click" }),
      makeStep({ action: "fill", selector: "#nope", value: "x", locators: ["#nope"] }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(false);
    expect(result.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(result.error).toContain("step 1/2");

    const run = store.getRun(result.runId)!;
    expect(run.status).toBe("failed");
    expect(store.listRunStepsByRun(result.runId).map((s) => s.status)).toEqual([
      "failed",
      "skipped",
    ]);
  });

  it("asserts URL contains, element visible, and text present", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({
        action: "assert",
        selector: null,
        assertion: { op: "url", expected: "/signup" },
      }),
      makeStep({
        action: "assert",
        selector: "#signup-result",
        locators: ["#signup-result"],
        assertion: { op: "visible", expected: true },
      }),
      makeStep({
        action: "assert",
        selector: "#signup-result",
        locators: ["#signup-result"],
        assertion: { op: "text", expected: "Welcome" },
      }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
  });

  it("fails a text assertion when the element text does not match", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.textValue = "Something else";
    const test = makeTest(store, [
      makeStep({
        action: "assert",
        selector: "#signup-result",
        locators: ["#signup-result"],
        assertion: { op: "text", expected: "Welcome" },
      }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not contain "Welcome"');
  });

  it("extracts an element value into the result under the slot name", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.textValue = "bob@x.com";
    const test = makeTest(store, [
      makeStep({
        action: "extract",
        selector: "#signup-email",
        value: "bob@x.com",
        locators: ["#signup-email"],
      }),
    ]);
    store.addSlot(test.id, { name: "email", kind: "email", defaultValue: "bob@x.com" });

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(true);
    expect(result.extracted).toEqual({ email: "bob@x.com" });
  });

  it("records the llm_calls offset from options into the run", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({ action: "navigate", selector: null, value: "http://localhost:3123/signup", locators: [], waitCondition: { kind: "url", contains: "/signup" } }),
    ]);
    const r = await new ReplayRunner(page as unknown as Page).runTest(store, test, { llmCalls: 1 });
    expect(r.llmCalls).toBe(1);
    const run = store.getRun(r.runId)!;
    expect(run.llmCalls).toBe(1);
  });

  it("honors wait conditions via getUrl/pageSignature polling", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({
        action: "navigate",
        selector: null,
        value: "http://localhost:3123/signup",
        locators: [],
        waitCondition: { kind: "url", contains: "/signup" },
      }),
      makeStep({
        action: "wait",
        selector: null,
        locators: [],
        waitCondition: { kind: "signature", hash: "sig1" },
      }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(2);
  });

  it("fails when a signature wait condition never matches", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.pageSignatureValue = "never";
    const test = makeTest(store, [
      makeStep({
        action: "wait",
        selector: null,
        locators: [],
        waitCondition: { kind: "signature", hash: "sig1", timeoutMs: 50, pollMs: 10 },
      }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed out waiting for page signature");
  });

  it("accepts a signature wait once the page moves off the before state (browser-use parity)", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.pageSignatureValue = "after-click";
    const test = makeTest(store, [
      makeStep({
        action: "wait",
        selector: null,
        locators: [],
        waitCondition: {
          kind: "signature",
          hash: "recorded-snapshot",
          before: "before-click",
          timeoutMs: 5000,
          pollMs: 10,
        },
      }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(true);
  });

  it("still fails a signature wait when the page never leaves the before state", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.pageSignatureValue = "before-click";
    const test = makeTest(store, [
      makeStep({
        action: "wait",
        selector: null,
        locators: [],
        waitCondition: {
          kind: "signature",
          hash: "recorded-snapshot",
          before: "before-click",
          timeoutMs: 50,
          pollMs: 10,
        },
      }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed out waiting for page signature");
  });

  it("returns immediately when before equals the recorded hash (no page change)", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.pageSignatureValue = "unchanged";
    const test = makeTest(store, [
      makeStep({
        action: "wait",
        selector: null,
        locators: [],
        waitCondition: {
          kind: "signature",
          hash: "unchanged",
          before: "unchanged",
          timeoutMs: 50,
          pollMs: 10,
        },
      }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);

    expect(result.success).toBe(true);
  });

  it("waits for the element to become visible before dispatching a click", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.visible = false;
    page.visibleFlipAfter = 3;
    const test = makeTest(store, [
      makeStep({ action: "click" }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      timeoutMs: 2000,
      pollMs: 5,
    });

    expect(result.success).toBe(true);
    expect(page.clicks).toEqual(['[data-testid="signup-submit"]']);
    expect(page.visibleChecks).toBeGreaterThanOrEqual(3);
  });

  it("fails a click when the element never becomes visible", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.visible = false;
    page.visibleFlipAfter = Number.POSITIVE_INFINITY;
    const test = makeTest(store, [
      makeStep({ action: "click" }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      timeoutMs: 50,
      pollMs: 5,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed out waiting");
    expect(page.clicks).toHaveLength(0);
  });
});

describe("ReplayRunner assertions — pass/fail coverage", () => {
  it("url assertion passes when the URL contains the expected substring", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({
        action: "assert",
        selector: null,
        assertion: { op: "url", expected: "/signup" },
      }),
    ]);
    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);
    expect(result.success).toBe(true);
  });

  it("url assertion fails when the URL does not contain the expected substring", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({
        action: "assert",
        selector: null,
        assertion: { op: "url", expected: "/welcome" },
      }),
    ]);
    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not contain "\/welcome"/);
  });

  it("visible assertion fails when the element is not visible", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.visible = false;
    const test = makeTest(store, [
      makeStep({
        action: "assert",
        selector: "#signup-result",
        locators: ["#signup-result"],
        assertion: { op: "visible", expected: true },
      }),
    ]);
    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is not visible/);
  });

  it("records both a passing and a failing run with llm_calls 0 and a duration", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({
        action: "navigate",
        selector: null,
        value: "http://localhost:3123/signup",
        locators: [],
        waitCondition: { kind: "url", contains: "/signup" },
      }),
    ]);

    const r1 = await new ReplayRunner(page as unknown as Page).runTest(store, test);
    expect(r1.success).toBe(true);

    const failPage = new FakePage();
    failPage.resolveResult = { ...failPage.resolveResult, found: false, selector: null };
    const failTest = makeTest(store, [
      makeStep({ action: "click" }),
      makeStep({ action: "fill", selector: "#missing", value: "x", locators: ["#missing"] }),
    ]);
    const r2 = await new ReplayRunner(failPage as unknown as Page).runTest(store, failTest, {
      timeoutMs: 5000,
    });
    expect(r2.success).toBe(false);

    const runs = store.listRuns(test.id);
    const failRuns = store.listRuns(failTest.id);
    const passedRun = runs.find((r) => r.id === r1.runId)!;
    const failedRun = failRuns.find((r) => r.id === r2.runId)!;

    expect(passedRun.status).toBe("passed");
    expect(passedRun.finishedAt).not.toBeNull();
    expect(passedRun.llmCalls).toBe(0);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.llmCalls).toBe(0);
    const dur =
      new Date(passedRun.finishedAt!).getTime() - new Date(passedRun.startedAt).getTime();
    expect(dur).toBeGreaterThanOrEqual(0);
  });
});

describe("ReplayRunner self-heal (Epic QF-64)", () => {
  class FakeHealer implements StepHealer {
    calls = 0;
    result: HealResult;
    constructor(result: HealResult) {
      this.result = result;
    }
    async heal(): Promise<HealResult> {
      this.calls++;
      return this.result;
    }
  }

  const healedRef = "[data-testid=healed-submit]";
  const baseHealer = () =>
    new FakeHealer({
      locators: [healedRef],
      elementFingerprint: "newfp",
      matchedSelector: healedRef,
    });

  it("re-tries once after a miss and proceeds without healing when the retry resolves", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.resolveFailTimes = 1; // first attempt misses, retry hits
    const test = makeTest(store, [makeStep({ action: "click" })]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.selfHealed).toBe(0);
    expect(store.listVersionsByTest(test.id)).toHaveLength(0); // no version bump without a heal
  });

  it("heals a locator miss, persists a version, and counts one LLM call", async () => {
    const store = makeStore();
    const page = new FakePage();
    // initial + retry both miss; the heal validation re-resolves successfully
    page.resolveFailTimes = 2;
    const test = makeTest(store, [makeStep({ action: "click" })]);
    const healer = baseHealer();

    // Capture the step's intent BEFORE runTest (a successful heal mutates the
    // step's locators in-place via applyHealToStep, so stepToEnglish(test.steps[0])
    // would otherwise render the healed locator).
    const originalIntent = stepToEnglish(test.steps[0]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      healer,
    });

    expect(result.success).toBe(true);
    expect(healer.calls).toBe(1);
    expect(result.selfHealed).toBe(1);
    expect(result.llmCalls).toBe(1);
    expect(result.selfHealedSteps).toEqual([`step 1: ${originalIntent} -> ${healedRef}`]);

    const run = store.getRun(result.runId)!;
    expect(run.llmCalls).toBe(1);

    // the healed step locators were persisted + at least one version snapshot exists
    const updated = store.getStep(test.steps[0].id)!;
    expect(updated.locators).toEqual([healedRef]);
    expect(updated.elementFingerprint).toBe("newfp");
    expect(store.listVersionsByTest(test.id).length).toBeGreaterThanOrEqual(1);
  });

  it("fails cleanly without healing when no healer is wired", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.resolveFailTimes = 10; // always miss
    const test = makeTest(store, [makeStep({ action: "click" })]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.selfHealed).toBe(0);
    expect(result.llmCalls).toBe(0);
    expect(result.error).toMatch(/no element matches/);
  });

  it("fails cleanly when the healer returns null", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.resolveFailTimes = 10;
    const test = makeTest(store, [makeStep({ action: "click" })]);
    const healer: StepHealer = { heal: async () => null };

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      healer,
    });

    expect(result.success).toBe(false);
    expect(result.selfHealed).toBe(0);
    expect(result.error).toMatch(/no element matches/);
  });

  it("does not heal a resolved locator when there is no recorded fingerprint baseline", async () => {
    const store = makeStore();
    const page = new FakePage();
    // resolveElement always returns fingerprintMatch:false for a null expected
    // fingerprint (dom.ts), so a navigation-click step recorded without a
    // baseline must NOT trigger a spurious heal.
    page.resolveResult = {
      ...page.resolveResult,
      fingerprint: "actual-fp",
      fingerprintMatch: false,
    };
    const test = makeTest(store, [
      makeStep({ action: "click", elementFingerprint: null }),
    ]);
    const healer = baseHealer();

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      healer,
    });

    expect(result.success).toBe(true);
    expect(healer.calls).toBe(0);
    expect(result.selfHealed).toBe(0);
    expect(result.llmCalls).toBe(0);
    expect(page.clicks).toEqual(['[data-testid="signup-submit"]']);
  });

  it("heals when the element resolves but its fingerprint drifted from a recorded baseline", async () => {
    const store = makeStore();
    const page = new FakePage();
    // The recorded fingerprint no longer matches the live element (e.g. a
    // testid was renamed while the id survived): the locator resolves but the
    // identity drifted, so a healer must refresh the cached locators.
    page.resolveResult = {
      ...page.resolveResult,
      fingerprint: "changed",
      fingerprintMatch: false,
    };
    const test = makeTest(store, [makeStep({ action: "click" })]);
    const healer = baseHealer();

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      healer,
    });

    expect(result.success).toBe(true);
    expect(healer.calls).toBe(1);
    expect(result.selfHealed).toBe(1);
  });
});

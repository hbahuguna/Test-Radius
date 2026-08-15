import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "../browser/session.js";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import type { Step, TestWithSteps } from "../cache/types.js";
import { applyVariables, ReplayError, ReplayRunner, type ReplayResult } from "./engine.js";
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
   /** return value for the completion-hint body-text check. */
   bodyTextValue = "Thanks for signing up to the Mitie Newsletter.";
   /** accessibility-tree snapshot for the deterministic last-resort search. */
   accessibilitySnapshotValue: {
     ref: string;
     role: string;
     name: string;
     bounds: { x: number; y: number; width: number; height: number };
     hidden?: boolean;
   }[] = [];


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

  async getAccessibilitySnapshot(): Promise<
    { ref: string; role: string; name: string; bounds: { x: number; y: number; width: number; height: number }; hidden?: boolean }[]
  > {
    return this.accessibilitySnapshotValue;
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
    // Check getBoundingClientRect BEFORE querySelector+textContent because
    // elementIsVisible inlines both the text-search loop (textContent) and the
    // rect check. Matching textContent first would return a truthy string
    // instead of the boolean visibility result, silently masking failures.
    if (body.includes("getBoundingClientRect")) {
      this.visibleChecks++;
      if (this.visibleFlipAfter !== undefined) {
        return (this.visibleChecks >= this.visibleFlipAfter) as T;
      }
      return this.visible as T;
    }
    if (body.includes("querySelector(sel)") && body.includes("textContent")) {
      return this.textValue as T;
    }
    if (body.includes("querySelector(sel)") && body.includes(".value")) {
      return this.textValue as T;
    }
    if (body.includes("innerText")) {
      return this.bodyTextValue as T;
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
    // prioritizeLocators places text="…" before data-testid, so the text
    // locator is the one actually resolved and used to drive the click.
    expect(page.clicks).toEqual(['text="Create account"']);

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
    expect(page.clicks).toEqual(['text="Create account"']);
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

describe("ReplayRunner completion hint", () => {
  it("short-circuits on the completion hint even before the first step", async () => {
    const store = makeStore();
    const page = new FakePage();
    const test = makeTest(store, [
      makeStep({ action: "click" }),
      makeStep({ action: "fill", selector: "#signup-name", value: "Ada", locators: ["#signup-name"] }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      completionHint: "Thanks for signing up to the Mitie Newsletter.",
    });

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(["skipped", "skipped"]);
    expect(result.steps[0]?.detail).toEqual({ reason: "goal already achieved" });
    expect(page.clicks).toHaveLength(0);
    expect(page.fills).toHaveLength(0);
    const run = store.getRun(result.runId)!;
    expect(run.status).toBe("passed");
  });

  it("matches the completion hint despite whitespace differences in the page text", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.bodyTextValue = "Thanks   for signing\n\nup to the Mitie Newsletter. Your\nsubscription is confirmed.";
    const test = makeTest(store, [makeStep({ action: "click" })]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      completionHint: "Thanks for signing up to the Mitie Newsletter. You",
    });

    expect(result.success).toBe(true);
    expect(result.steps[0]?.status).toBe("skipped");
  });

  it("does not short-circuit when the hint is absent from the page", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.bodyTextValue = "Create your account";
    const test = makeTest(store, [makeStep({ action: "click" })]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      completionHint: "Thanks for signing up to the Mitie Newsletter.",
    });

    expect(result.success).toBe(true);
    expect(result.steps[0]?.status).toBe("passed");
    expect(page.clicks).toEqual(['text="Create account"']);
  });
});

describe("ReplayRunner accessible-name last resort", () => {
  it("recovers a click via accessible-name search when no healer is wired", async () => {
    const store = makeStore();
    const page = new FakePage();
    // The recorded locators miss on the first resolve attempt; the AX-ref
    // re-resolution (attempt 2) succeeds.
    page.resolveFailTimes = 1;
    page.accessibilitySnapshotValue = [
      { ref: "[data-testid=subscribe]", role: "button", name: "SUBSCRIBE", bounds: { x: 0, y: 0, width: 100, height: 30 } },
    ];
    const test = makeTest(store, [
      makeStep({ action: "click", locators: ['text="SUBSCRIBE"', "#subscribe"] }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      resolveTimeoutMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.selfHealed).toBe(0);
    expect(page.clicks).toEqual(["[data-testid=subscribe]"]);
  });

  it("still fails when the accessible-name search finds nothing", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.resolveFailTimes = 10; // recorded locators never resolve
    page.accessibilitySnapshotValue = [
      { ref: "#other", role: "button", name: "Order now", bounds: { x: 0, y: 0, width: 100, height: 30 } },
    ];
    const test = makeTest(store, [makeStep({ action: "click", locators: ['text="SUBSCRIBE"', "#subscribe"] })]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      resolveTimeoutMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no element matches/);
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
    // resolveTimeoutMs:0 skips the polling window; only 1 resolve attempt is
    // made before handing off to the healer.  resolveFailTimes=1 makes that
    // single attempt miss, so the healer is guaranteed to be invoked, while
    // the healer's own validation call (attempt 2) resolves successfully.
    page.resolveFailTimes = 1;
    const test = makeTest(store, [makeStep({ action: "click" })]);
    const healer = baseHealer();

    // Capture the step's intent BEFORE runTest (a successful heal mutates the
    // step's locators in-place via applyHealToStep, so stepToEnglish(test.steps[0])
    // would otherwise render the healed locator).
    const originalIntent = stepToEnglish(test.steps[0]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      resolveTimeoutMs: 0,
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
    page.resolveFailTimes = 10; // always miss within the test window
    const test = makeTest(store, [makeStep({ action: "click" })]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      resolveTimeoutMs: 0,
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
      resolveTimeoutMs: 0,
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
    // text="…" locator wins priority ordering over the data-testid
    expect(page.clicks).toEqual(['text="Create account"']);
  });

  // ── New tests: delayed resolution polling ────────────────────────────────

  it("succeeds when the element appears after several failed resolve attempts (polled wait)", async () => {
    // Simulates an async-injected element (cookie banner, modal) that isn't in
    // the DOM on the first attempt but shows up within the polling window.
    const store = makeStore();
    const page = new FakePage();
    page.resolveFailTimes = 5; // first 5 attempts miss; 6th succeeds
    const test = makeTest(store, [makeStep({ action: "click" })]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      resolveTimeoutMs: 5_000, // window large enough for 6+ attempts at delay=0
    });

    expect(result.success).toBe(true);
    expect(result.selfHealed).toBe(0);
    expect(page.resolveAttempts).toBeGreaterThanOrEqual(6);
  });

  it("fails with a locator-miss error when the element never appears within the timeout", async () => {
    const store = makeStore();
    const page = new FakePage();
    page.resolveFailTimes = Number.MAX_SAFE_INTEGER; // never resolves
    const test = makeTest(store, [makeStep({ action: "click" })]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      resolveTimeoutMs: 50, // short window; times out quickly
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no element matches/);
  });

  // ── New tests: optional step skipping ────────────────────────────────────

  it("skips an optional step whose element is absent and continues the run", async () => {
    // resolveFailTimes=1 + resolveTimeoutMs=0: the click step's single resolve
    // attempt misses (attempt 1 ≤ 1), triggering ReplayError → optional skip.
    // The fill step then succeeds on its resolve attempt (attempt 2 > 1).
    const store = makeStore();
    const page = new FakePage();
    page.resolveFailTimes = 1;
    const test = makeTest(store, [
      makeStep({ action: "click", optional: true }),
      makeStep({ action: "fill", selector: "#signup-name", value: "Ada", locators: ["#signup-name"] }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      retryDelayMs: 0,
      resolveTimeoutMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.steps[0]?.status).toBe("skipped");
    expect(result.steps[1]?.status).toBe("passed");
  });

  it("does NOT skip an optional step when the failure is a visibility timeout, not a locator miss", async () => {
    // A WaitTimeoutError (element found but never becomes visible) must propagate
    // even on optional steps: it's an operational failure, not a missing element.
    const store = makeStore();
    const page = new FakePage();
    page.visible = false;
    page.visibleFlipAfter = Number.POSITIVE_INFINITY;
    const test = makeTest(store, [
      makeStep({ action: "click", optional: true }),
    ]);

    const result = await new ReplayRunner(page as unknown as Page).runTest(store, test, {
      timeoutMs: 50,
      pollMs: 5,
    });

    // The run FAILS because the WaitTimeoutError is not caught by the optional handler
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Timed out waiting/);
    expect(result.steps[0]?.status).toBe("failed");
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
      resolveTimeoutMs: 0, // fingerprint mismatch is consistent; skip polling to keep test fast
      healer,
    });

    expect(result.success).toBe(true);
    expect(healer.calls).toBe(1);
    expect(result.selfHealed).toBe(1);
  });
});

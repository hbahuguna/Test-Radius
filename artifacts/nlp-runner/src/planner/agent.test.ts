import { describe, expect, it } from "vitest";
import { RecordAgent, StepExecutionError } from "./agent.js";
import { HappyPathDoneChecker } from "./done-checker.js";
import { Planner, PlanParseError } from "./planner.js";
import { MockLLMClient, MockDriver } from "./test-utils.js";
import type { SnapshotElement } from "./snapshot.js";

function elts(nodes: Array<{ role: string; name: string; ref: string }>): SnapshotElement[] {
  return MockDriver.elts(...nodes);
}

function plan(overrides: {
  milestones?: string[];
  actions?: unknown[];
  done?: boolean;
  hint?: string;
}): string {
  return JSON.stringify({
    milestones: overrides.milestones,
    actions: overrides.actions,
    done: overrides.done ?? false,
    ...(overrides.hint ? { hint: overrides.hint } : {}),
  });
}

describe("RecordAgent batching (QF-51)", () => {
  it("executes a multi-action batch in order against one snapshot", async () => {
    const driver = new MockDriver({
      snapshots: [MockDriver.page(elts([
        { role: "textbox", name: "Email", ref: "input#email" },
        { role: "button", name: "Sign Up", ref: '[data-testid="submit"]' },
      ]), "https://example.com/signup")],
      signatures: ["form"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({
        milestones: ["fill email", "submit"],
        actions: [
          { type: "fill", ref: 1, value: "{email}" },
          { type: "click", ref: 2 },
        ],
        done: true,
      }),
    ]);
    const agent = new RecordAgent(llm, driver);
    const res = await agent.record("register bob@x.com", "Register flow");

    expect(res.ok).toBe(true);
    expect(res.steps).toBe(2);
    expect(driver.steps.map((s) => s.action)).toEqual(["fill", "click"]);
    // {email} placeholder was substituted with the extracted slot value
    expect(driver.steps[0].selector).toContain("bob@x.com");
    expect(driver.snapshotCalls).toHaveLength(1);
  });

  it("navigate ends the turn and triggers a re-snapshot before re-planning", async () => {
    const loginPage = MockDriver.page(
      elts([{ role: "link", name: "Sign Up", ref: '[data-testid="link-signup"]' }]),
      "https://example.com/login",
    );
    const signupPage = MockDriver.page(
      elts([
        { role: "textbox", name: "Email", ref: "input#email" },
        { role: "button", name: "Submit", ref: '[data-testid="submit"]' },
      ]),
      "https://example.com/signup",
    );
    const driver = new MockDriver({
      snapshots: [loginPage, signupPage],
      signatures: ["login", "signup"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      // turn 1: navigate ends the turn (click after it is NOT executed)
      plan({
        milestones: ["open signup", "complete"],
        actions: [
          { type: "navigate", url: "https://example.com/signup" },
          { type: "click", ref: 1 },
        ],
        done: false,
      }),
      // turn 2: fresh snapshot -> fill + submit
      plan({ actions: [{ type: "fill", ref: 1, value: "bob@x.com" }, { type: "click", ref: 2 }], done: true }),
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 5 });
    const res = await agent.record("register bob@x.com", "Signup");

    expect(res.ok).toBe(true);
    // navigate ran, then re-snapshot, then fill+click; the spurious click from
    // turn 1 was dropped (never ran against the stale login snapshot)
    expect(driver.steps.map((s) => s.action)).toEqual(["navigate", "fill", "click"]);
    expect(driver.snapshotCalls).toHaveLength(2);
    expect(res.milestones).toEqual(["open signup", "complete"]);
  });
});

describe("RecordAgent loop guard (QF-52)", () => {
  it("fires a replan hint on a stale signature, then recovers", async () => {
    const page = MockDriver.page(
      elts([{ role: "button", name: "Submit", ref: '[data-testid="submit"]' }]),
    );
    const driver = new MockDriver({
      snapshots: [page],
      signatures: ["SAME", "SAME", "SAME"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({ milestones: ["go"], actions: [{ type: "click", ref: 1 }] }), // turn 1
      plan({ actions: [{ type: "click", ref: 1 }] }),                     // turn 2 (stale=1)
      plan({ actions: [], done: true }),                                   // turn 3 (stale=2 -> hint)
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 2, maxTurns: 10 });
    const res = await agent.record("submit the form", "Loop recovery");

    expect(res.ok).toBe(true);
    expect(res.replanHints).toHaveLength(1);
    expect(res.replanHints[0].reason).toBe("stale_signature");
    expect(driver.steps.map((s) => s.action)).toEqual(["click", "click"]); // turn 3 has no actions
    // the retry turn carried the LOOP GUARD error context in the prompt
    const lastPrompt = llm.getCall(2);
    expect(lastPrompt).toMatch(/LOOP GUARD/i);
  });

  it("a normally progressing record never hits the guard", async () => {
    const pages = [
      MockDriver.page(elts([{ role: "link", name: "Start", ref: "a" }]), "https://x/1", "One"),
      MockDriver.page(elts([{ role: "button", name: "Finish", ref: "b" }]), "https://x/2", "Two"),
      MockDriver.page(elts([{ role: "button", name: "Done", ref: "c" }]), "https://x/3", "Three"),
    ];
    const driver = new MockDriver({
      snapshots: pages,
      signatures: ["s1", "s2", "s3"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({ milestones: ["progress"], actions: [{ type: "click", ref: 1 }] }),
      plan({ actions: [{ type: "click", ref: 1 }] }),
      plan({ actions: [{ type: "click", ref: 1 }], done: true }),
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 2 });
    const res = await agent.record("make progress", "Progressing");
    expect(res.ok).toBe(true);
    expect(res.replanHints).toHaveLength(0);
  });

  it("concludes on the final turn (forced done) when the LLM never emits done", async () => {
    const pages = Array.from({ length: 5 }, (_, i) =>
      MockDriver.page(elts([{ role: "button", name: `b${i}`, ref: `b${i}` }]), `https://x/${i}`, `T${i}`),
    );
    const driver = new MockDriver({
      snapshots: pages,
      signatures: ["s0", "s1", "s2", "s3", "s4"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([plan({ milestones: ["idle"], actions: [{ type: "scroll" }] })]); // repeats last, never done
    const agent = new RecordAgent(llm, driver, { maxTurns: 3, staleThreshold: 99 });
    const res = await agent.record("never finish", "Budget");
    // browser-use style: the final turn force-concludes and saves what was
    // recorded (the dry-run gate in RecordSession later validates replayability)
    expect(res.ok).toBe(true);
    expect(res.turns).toBe(3);
    expect(res.replanHints).toHaveLength(0);
    expect(driver.steps).toHaveLength(3);
    expect(driver.saved).toHaveLength(1);
    expect(driver.saved[0].name).toBe("Budget");
  });
});

describe("RecordAgent re-plan on failure (QF-50)", () => {
  it("re-plans with error context after a step execution error", async () => {
    const page = MockDriver.page(
      elts([{ role: "button", name: "Submit", ref: '[data-testid="submit"]' }]),
    );
    const driver = new MockDriver({ snapshots: [page], signatures: ["a", "b"], signaturesByIndex: true });
    driver.nextError = { action: "click", msg: "boom" };
    const llm = new MockLLMClient([
      plan({ milestones: ["m"], actions: [{ type: "click", ref: 1 }] }), // click throws
      plan({ actions: [{ type: "click", ref: 1 }], done: true }),        // retry succeeds
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 99 });
    const res = await agent.record("submit", "Replan");
    expect(res.ok).toBe(true);
    // the failed turn-1 click was NOT recorded; only the successful
    // re-plan click was
    expect(driver.steps).toHaveLength(1);
    expect(driver.steps[0].action).toBe("click");
    // turn 2 prompt carried the execution-error context
    expect(llm.getCall(1)).toMatch(/execution error/i);
  });

  it("re-plans when the LLM targets a ref that is out of range", async () => {
    const page = MockDriver.page(
      elts([{ role: "button", name: "Submit", ref: "b" }]),
    );
    const driver = new MockDriver({ snapshots: [page], signatures: ["a"], signaturesByIndex: false });
    const llm = new MockLLMClient([
      plan({ milestones: ["m"], actions: [{ type: "click", ref: 99 }] }),
      plan({ actions: [], done: true }),
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 99 });
    const res = await agent.record("submit", "Bad ref");
    expect(res.ok).toBe(true);
    expect(llm.getCall(1)).toMatch(/execution error/i);
    expect(llm.getCall(1)).toMatch(/ref 99 not found/i);
  });
});

describe("RecordAgent malformed plan (QF-49 mid-record)", () => {
  it("returns a parse error result when the LLM never emits valid JSON", async () => {
    const driver = new MockDriver({ snapshots: [MockDriver.page([])], signatures: ["x"] });
    const llm = new MockLLMClient(["nope", "nope", "nope", "nope"]);
    const agent = new RecordAgent(llm, driver);
    const res = await agent.record("register bob@x.com", "No JSON");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/parse|invalid|valid plan/i);
  });
});

describe("RecordAgent end-to-end storage (QF-48 / QF-53)", () => {
  it("records a signup flow, extracts query slots, substitutes {email}, and stores the canonical query", async () => {
    const login = MockDriver.page(
      elts([{ role: "link", name: "Sign Up", ref: '[data-testid="signup-link"]' }]),
      "https://example.com/login",
    );
    const signup = MockDriver.page(
      elts([
        { role: "textbox", name: "Email", ref: "input#email" },
        { role: "button", name: "Submit", ref: '[data-testid="submit"]' },
      ]),
      "https://example.com/signup",
    );
    const driver = new MockDriver({
      snapshots: [login, signup],
      signatures: ["login", "signup-form"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({
        milestones: ["open signup page", "fill email and submit", "reach confirmation"],
        actions: [{ type: "navigate", url: "https://example.com/signup" }],
        done: false,
      }),
      plan({
        actions: [
          { type: "fill", ref: 1, value: "{email}" },
          { type: "click", ref: 2 },
          { type: "assert", kind: "url", value: "signup" },
        ],
        done: true,
      }),
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 99 });
    const res = await agent.record("register bob@x.com", "Signup flow");

    expect(res.ok).toBe(true);
    // steps: navigate -> (re-snapshot) fill -> click -> assert
    expect(driver.steps.map((s) => s.action)).toEqual(["navigate", "fill", "click", "assert"]);
    // {email} placeholder resolved to the extracted slot value (QF-53)
    const fillStep = driver.steps.find((s) => s.action === "fill");
    expect(fillStep?.selector).toContain("bob@x.com");
    // canonical query + slots persisted (QF-53)
    expect(driver.saved).toHaveLength(1);
    expect(driver.saved[0].name).toBe("Signup flow");
    expect(driver.saved[0].opts.normalizedQuery).toBe("register {email}");
    expect(driver.saved[0].opts.extraSlots).toEqual([
      { name: "email", kind: "email", defaultValue: "bob@x.com" },
    ]);
    expect(res.milestones).toEqual(["open signup page", "fill email and submit", "reach confirmation"]);
  });
});

describe("RecordAgent auto-done on submit (no 'declare done' needed)", () => {
  it("saves in-turn when a submit click changes the page signature", async () => {
    const signup = MockDriver.page(
      elts([{ role: "button", name: "Sign Up", ref: '[data-testid="submit"]' }]),
      "https://example.com/signup",
    );
    const driver = new MockDriver({
      snapshots: [signup],
      signatures: ["form", "success"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({ milestones: ["fill", "submit"], actions: [{ type: "click", ref: 1 }], done: false }),
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 99 });
    const res = await agent.record("register a user", "Auto signup");

    expect(res.ok).toBe(true);
    expect(res.turns).toBe(1);
    expect(llm.calls).toHaveLength(1); // no second LLM call
    expect(driver.saved).toHaveLength(1);
  });

  it("stops at the start of the next turn (before another LLM call) when navigation is slower than the in-turn check", async () => {
    const signup = MockDriver.page(
      elts([{ role: "button", name: "Submit", ref: '[data-testid="submit"]' }]),
      "https://example.com/signup",
    );
    const success = MockDriver.page(
      elts([{ role: "heading", name: "Welcome!", ref: "h1" }]),
      "https://example.com/success",
    );
    const driver = new MockDriver({
      snapshots: [signup, success],
      // turn 1: "form" (pre) -> "form" (in-turn post: navigation not settled yet)
      // turn 2 start: "success" differs from "form" -> auto-done before planning
      signatures: ["form", "form", "success"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({ milestones: ["fill", "submit"], actions: [{ type: "click", ref: 1 }], done: false }),
      plan({ actions: [{ type: "click", ref: 1 }], done: true }), // must NOT be consumed
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 99 });
    const res = await agent.record("register a user", "Slow nav signup");

    expect(res.ok).toBe(true);
    expect(res.turns).toBe(2); // entered turn 2, but stopped at the boundary before planning
    expect(llm.calls).toHaveLength(1); // second plan never consumed
    expect(driver.saved).toHaveLength(1);
  });
});

describe("RecordAgent browser-use-style budget guards", () => {
  it("injects a budget warning once 75% of turns are consumed", async () => {
    const pages = Array.from({ length: 5 }, (_, i) =>
      MockDriver.page(elts([{ role: "button", name: `b${i}`, ref: `b${i}` }]), `https://x/${i}`, `T${i}`),
    );
    const driver = new MockDriver({
      snapshots: pages,
      signatures: ["s0", "s1", "s2", "s3", "s4"],
      signaturesByIndex: true,
    });
    // maxTurns 4 -> budget warn at turn >= 3 (75%). The LLM wraps up with
    // done:true on that same (final) turn, so the warning must be present.
    const llm = new MockLLMClient([
      plan({ milestones: ["m"], actions: [{ type: "scroll" }], done: false }),
      plan({ actions: [{ type: "scroll" }], done: false }),
      plan({ actions: [{ type: "scroll" }], done: false }),
      plan({ actions: [{ type: "scroll" }], done: true }),
    ]);
    const agent = new RecordAgent(llm, driver, { maxTurns: 4, staleThreshold: 99 });
    const res = await agent.record("progress", "Budget warn");
    expect(res.ok).toBe(true);
    // turn 4 (index 3) prompt carried the budget warning (4/4 turns) + final-turn note
    expect(llm.getCall(3)).toMatch(/TURN BUDGET WARNING/i);
    expect(llm.getCall(3)).toMatch(/4\/4/);
    expect(llm.getCall(3)).toMatch(/FINAL TURN/i);
  });

  it("stops early after 3 consecutive execution failures", async () => {
    const page = MockDriver.page(elts([{ role: "button", name: "Submit", ref: "b" }]));
    const driver = new MockDriver({
      snapshots: [page],
      signatures: ["a"],
      signaturesByIndex: false,
    });
    // ref 99 is out of range -> every click throws -> consecutive backtracks
    const llm = new MockLLMClient([
      plan({ milestones: ["m"], actions: [{ type: "click", ref: 99 }] }),
      plan({ actions: [{ type: "click", ref: 99 }] }),
      plan({ actions: [{ type: "click", ref: 99 }] }),
      plan({ actions: [{ type: "click", ref: 99 }] }), // must NOT be consumed
    ]);
    const agent = new RecordAgent(llm, driver, { maxTurns: 20, staleThreshold: 99 });
    const res = await agent.record("fail forever", "Consecutive fails");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/consecutive execution failures/i);
    expect(res.turns).toBe(3); // stopped after 3 backtracks, not 20 turns
    expect(llm.calls).toHaveLength(3);
    expect(driver.saved).toHaveLength(0);
  });
});

describe("RecordAgent happy-path done (browser-use style)", () => {
  it("concludes on a single-shot button click once the results page loads", async () => {
    const home = MockDriver.page(
      elts([
        { role: "textbox", name: "Search query", ref: "input#q" },
        { role: "button", name: "Search", ref: "[data-testid='search']" },
      ]),
      "https://shop.example.com",
      "Shop",
    );
    const results = MockDriver.page(
      elts([{ role: "heading", name: "Results for headphones", ref: "h1" }]),
      "https://shop.example.com/search?q=headphones",
      "Search results",
    );
    const driver = new MockDriver({
      snapshots: [home, results],
      signatures: ["home", "results"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({
        milestones: ["search"],
        actions: [
          { type: "fill", ref: 1, value: "headphones" },
          { type: "click", ref: 2 },
        ],
        done: false,
      }),
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 99 });
    const res = await agent.record("search for wireless headphones", "Search flow");

    expect(res.ok).toBe(true);
    expect(res.turns).toBe(1);
    expect(res.steps).toBe(2);
    expect(llm.calls).toHaveLength(1); // no second planning/checker call
    expect(driver.saved).toHaveLength(1);
    expect(driver.steps.map((s) => s.action)).toEqual(["fill", "click"]);
  });

  it("concludes when the clicked link lands on the URL named in the query", async () => {
    const home = MockDriver.page(
      elts([{ role: "link", name: "Dashboard", ref: "[data-testid='dash']" }]),
      "https://example.com",
      "Home",
    );
    const dash = MockDriver.page(
      elts([{ role: "heading", name: "Dashboard", ref: "h1" }]),
      "https://example.com/dashboard",
      "Dashboard",
    );
    const driver = new MockDriver({
      snapshots: [home, dash],
      signatures: ["home", "dashboard"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({ milestones: ["open dashboard"], actions: [{ type: "click", ref: 1 }], done: false }),
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 99 });
    const res = await agent.record("go to the dashboard at /dashboard", "Go to dashboard");

    expect(res.ok).toBe(true);
    expect(res.turns).toBe(1);
    expect(llm.calls).toHaveLength(1);
    expect(driver.saved).toHaveLength(1);
  });

  it("concludes when the post-click page shows confirmation content", async () => {
    const checkout = MockDriver.page(
      elts([{ role: "button", name: "Pay now", ref: "[data-testid='pay']" }]),
      "https://example.com/checkout",
      "Checkout",
    );
    const confirmation = MockDriver.page(
      elts([{ role: "heading", name: "Thank you for your order", ref: "h1" }]),
      "https://example.com/confirmation",
      "Order confirmation",
    );
    const driver = new MockDriver({
      snapshots: [checkout, confirmation],
      signatures: ["checkout", "confirmation"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({ milestones: ["complete checkout"], actions: [{ type: "click", ref: 1 }], done: false }),
    ]);
    const agent = new RecordAgent(llm, driver, { staleThreshold: 99 });
    const res = await agent.record("finish the checkout", "Checkout");

    expect(res.ok).toBe(true);
    expect(res.turns).toBe(1);
    expect(llm.calls).toHaveLength(1);
    expect(driver.saved).toHaveLength(1);
  });

  it("falls back to the LLM for an inconclusive page change (hybrid checker)", async () => {
    const start = MockDriver.page(
      elts([{ role: "button", name: "Proceed", ref: "[data-testid='proceed']" }]),
      "https://example.com/start",
      "Start",
    );
    const next = MockDriver.page(
      elts([
        { role: "heading", name: "Pipeline", ref: "h1" },
        { role: "link", name: "Back", ref: "a#back" },
      ]),
      "https://example.com/next",
      "Next page",
    );
    const driver = new MockDriver({
      snapshots: [start, next],
      signatures: ["start", "next"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({ milestones: ["do the thing"], actions: [{ type: "click", ref: 1 }], done: false }),
      JSON.stringify({ done: true, reason: "destination page reached" }),
    ]);
    const agent = new RecordAgent(llm, driver, {
      staleThreshold: 99,
      doneChecker: new HappyPathDoneChecker(llm),
    });
    const res = await agent.record("do the thing", "LLM done");

    expect(res.ok).toBe(true);
    expect(res.turns).toBe(1);
    expect(res.llmCalls).toBe(2); // plan + one done-checker fallback call
    expect(llm.calls).toHaveLength(2);
    expect(driver.saved).toHaveLength(1);
  });
});

describe("RecordAgent variable slots (--variables JSON)", () => {
  it("substitutes {email} from the variables option and stores it as a slot", async () => {
    const signup = MockDriver.page(
      elts([
        { role: "textbox", name: "Email", ref: "input#email" },
        { role: "button", name: "Create account", ref: "[data-testid='submit']" },
      ]),
      "https://example.com/signup",
      "Sign up",
    );
    const success = MockDriver.page(
      elts([{ role: "heading", name: "Welcome, Ada!", ref: "h1" }]),
      "https://example.com/signup",
      "Sign up",
    );
    const driver = new MockDriver({
      snapshots: [signup, success],
      signatures: ["form", "success"],
      signaturesByIndex: true,
    });
    const llm = new MockLLMClient([
      plan({
        milestones: ["fill", "submit"],
        actions: [
          { type: "fill", ref: 1, value: "{email}" },
          { type: "click", ref: 2 },
        ],
        done: false,
      }),
    ]);
    const agent = new RecordAgent(llm, driver, {
      staleThreshold: 99,
      variables: { email: "ada@example.com" },
    });
    const res = await agent.record("register a user", "Vars");

    expect(res.ok).toBe(true);
    expect(res.turns).toBe(1); // happy-path done after the submit click
    expect(res.steps).toBe(2);
    expect(driver.steps.map((s) => s.action)).toEqual(["fill", "click"]);
    // the {email} placeholder resolved from the variables JSON
    expect(driver.steps[0].selector).toContain("ada@example.com");
    expect(driver.saved[0].opts.extraSlots).toEqual([
      { name: "email", kind: "email", defaultValue: "ada@example.com" },
    ]);
  });
});

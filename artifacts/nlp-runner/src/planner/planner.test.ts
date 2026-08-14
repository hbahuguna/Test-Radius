import { describe, expect, it } from "vitest";
import { Planner, PlanParseError } from "./planner.js";
import { MockLLMClient } from "./test-utils.js";
import { buildMessages } from "./prompt.js";
import type { SnapshotPayload, SnapshotElement } from "./snapshot.js";

function page(elements: SnapshotElement[] = [], url = "https://example.com", title = "Home"): SnapshotPayload {
  return { url, title, elements };
}

describe("Planner (QF-49 retry + QF-50 milestones)", () => {
  it("accepts a valid plan on the first attempt", async () => {
    const llm = new MockLLMClient([
      JSON.stringify({
        milestones: ["open signup", "fill email", "reach dashboard"],
        actions: [{ type: "click", ref: 1 }],
        done: false,
      }),
    ]);
    const planner = new Planner(llm);
    const res = await planner.askPlan({
      query: "register bob@x.com",
      normalizedQuery: "register {email}",
      slots: [{ name: "email", kind: "email", defaultValue: "bob@x.com" }],
      snapshot: page(),
      history: [],
    });
    expect(res.plan.milestones).toEqual(["open signup", "fill email", "reach dashboard"]);
    expect(res.plan.actions).toHaveLength(1);
    expect(res.attempts).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });

  it("retries malformed output and accepts on the second call (1 retry)", async () => {
    const good = JSON.stringify({
      milestones: ["m"],
      actions: [{ type: "navigate", url: "https://x.com/s" }],
      done: false,
    });
    const llm = new MockLLMClient(["not json at all", good]);
    const planner = new Planner(llm, { maxRetries: 2 });
    const res = await planner.askPlan({
      query: "register bob@x.com",
      normalizedQuery: "register {email}",
      slots: [],
      snapshot: page(),
      history: [],
    });
    expect(res.attempts).toBe(2);
    expect(llm.calls).toHaveLength(2);
    const retryLast = llm.calls[1].messages[llm.calls[1].messages.length - 1];
    expect(retryLast.role).toBe("user");
    expect(retryLast.content).toMatch(/not a valid plan object/i);
  });

  it("throws PlanParseError with attempts=3 after retries are exhausted", async () => {
    const llm = new MockLLMClient(["g1", "g2", "g3"]);
    const planner = new Planner(llm, { maxRetries: 2 }); // 1 + 2 retries = 3 attempts
    await expect(
      planner.askPlan({
        query: "x", normalizedQuery: "x", slots: [], snapshot: page(), history: [],
      }),
    ).rejects.toBeInstanceOf(PlanParseError);
    expect(llm.calls).toHaveLength(3);
    try {
      await planner.askPlan({
        query: "x", normalizedQuery: "x", slots: [], snapshot: page(), history: [],
      });
    } catch (e) {
      expect((e as PlanParseError).attempts).toBe(3);
    }
  });

  it("first-turn prompt instructs milestones-first decomposition", () => {
    const msgs = buildMessages({
      query: "register bob@x.com",
      normalizedQuery: "register {email}",
      slots: [{ name: "email", kind: "email", defaultValue: "bob@x.com" }],
      snapshot: page([{ index: 1, role: "button", name: "Sign Up", ref: '[data-testid="signup"]' }]),
      milestones: undefined,
      history: [],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toMatch(/milestones.*FIRST turn/i);
  });

  it("history is echoed on subsequent turns", () => {
    const history = [
      {
        snapshot: page([{ index: 1, role: "button", name: "Sign Up", ref: "[data-testid=signup]" }]),
        plan: { actions: [{ type: "click", ref: 1 }], done: false, milestones: ["open"] },
      },
    ];
    const msgs = buildMessages({
      query: "x",
      normalizedQuery: "x",
      slots: [],
      snapshot: page([{ index: 1, role: "textbox", name: "Email", ref: "input#email" }]),
      milestones: ["open"],
      history: history as Parameters<typeof buildMessages>[0]["history"],
    });
    const user = msgs[1].content;
    expect(user).toMatch(/Recent history/);
    expect(user).toMatch(/TURN: URL: https:\/\/example.com/);
    expect(user).toMatch(/"milestones":\s*\["open"\]/);
  });
});

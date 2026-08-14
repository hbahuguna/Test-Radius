import { describe, expect, it } from "vitest";
import { parsePlan, validateAction, type Action } from "./schema.js";

describe("validateAction (QF-49)", () => {
  it("accepts a navigate", () => {
    expect(validateAction({ type: "navigate", url: "https://example.com" })).toEqual({
      type: "navigate",
      url: "https://example.com",
    });
  });

  it("accepts a fill and requires a non-empty value", () => {
    expect(validateAction({ type: "fill", ref: 2, value: "bob@x.com" })).toEqual({
      type: "fill", ref: 2, value: "bob@x.com",
    });
    expect(validateAction({ type: "fill", ref: 2 })).toEqual(["fill: value must be a non-empty string"]);
  });

  it("rejects ref < 1", () => {
    expect(validateAction({ type: "click", ref: 0 })).toEqual(["click: ref must be >= 1"]);
  });

  it("rejects unknown action types", () => {
    expect(validateAction({ type: "teleport" })).toEqual(["invalid action type: teleport"]);
  });

  it("rejects non-object actions", () => {
    expect(validateAction("click")).toEqual(["action must be an object"]);
  });

  it("accepts assert kinds", () => {
    expect(validateAction({ type: "assert", kind: "url", value: "/dashboard" })).toEqual({
      type: "assert", kind: "url", value: "/dashboard",
    });
    expect(validateAction({ type: "assert", kind: "visible", ref: 1 })).toEqual({
      type: "assert", kind: "visible", ref: 1,
    });
  });

  it("accepts wait with optional ms", () => {
    expect(validateAction({ type: "wait" })).toEqual({ type: "wait" });
    expect(validateAction({ type: "wait", ms: 500 })).toEqual({ type: "wait", ms: 500 });
    expect(validateAction({ type: "wait", ms: -1 })).toEqual(["wait: ms must be a non-negative integer"]);
  });

  it("accepts extract", () => {
    expect(validateAction({ type: "extract", ref: 3, name: "token" })).toEqual({
      type: "extract", ref: 3, name: "token",
    });
  });
});

describe("parsePlan (QF-49)", () => {
  it("parses a valid plan with milestones and actions", () => {
    const text = JSON.stringify({
      milestones: ["open signup", "fill form"],
      actions: [{ type: "navigate", url: "https://example.com/s" }, { type: "click", ref: 3 }],
      done: false,
    });
    const res = parsePlan(text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.plan.milestones).toEqual(["open signup", "fill form"]);
      expect(res.plan.actions).toHaveLength(2);
      expect(res.plan.done).toBe(false);
    }
  });

  it("extracts JSON even with surrounding prose/markdown", () => {
    const text = "Sure thing:\n```json\n" + JSON.stringify({ actions: [{ type: "click", ref: 1 }], done: true }) + "\n```";
    const res = parsePlan(text);
    expect(res.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const res = parsePlan("{not valid json}");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toMatch(/invalid JSON/);
  });

  it("rejects a plan missing the actions array", () => {
    const res = parsePlan(JSON.stringify({ done: false }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toContain("plan.actions must be an array");
  });

  it("collects per-action validation errors", () => {
    const res = parsePlan(JSON.stringify({
      actions: [{ type: "click" }, { type: "fill", ref: 1, value: "x" }],
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes("action[0]"))).toBe(true);
  });

  it("rejects an unknown action type within the array", () => {
    const res = parsePlan(JSON.stringify({ actions: [{ type: "warp", ref: 1 }] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes("warp"))).toBe(true);
  });

  it("rejects non-integer / out-of-range refs", () => {
    expect(parsePlan(JSON.stringify({ actions: [{ type: "click", ref: 1.5 }] })).ok).toBe(false);
    expect(parsePlan(JSON.stringify({ actions: [{ type: "click", ref: "1" }] })).ok).toBe(false);
    expect(parsePlan(JSON.stringify({ actions: [{ type: "click", ref: -1 }] })).ok).toBe(false);
  });

  it("validates the full action union", () => {
    const actions: Action[] = [
      { type: "navigate", url: "https://x" },
      { type: "click", ref: 1 },
      { type: "fill", ref: 2, value: "v" },
      { type: "select", ref: 3, value: "opt" },
      { type: "scroll", ref: 4 },
      { type: "wait", ms: 100 },
      { type: "assert", kind: "url", value: "/d" },
      { type: "assert", kind: "text", ref: 5, value: "hi" },
      { type: "assert", kind: "visible", ref: 6 },
      { type: "extract", ref: 7, name: "n" },
    ];
    const res = parsePlan(JSON.stringify({ milestones: ["m"], actions, done: true }));
    expect(res.ok).toBe(true);
  });
});

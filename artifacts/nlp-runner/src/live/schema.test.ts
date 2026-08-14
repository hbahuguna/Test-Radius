import { describe, expect, it } from "vitest";
import {
  describeActionParams,
  toJsonSchema,
  validateParams,
  type ActionParamsSchema,
} from "./schema.js";

const clickSchema: ActionParamsSchema = {
  type: "object",
  properties: {
    index: { type: "integer", description: "DOM index (>= 1)." },
  },
  required: ["index"],
};

describe("validateParams", () => {
  it("accepts matching params and coerces defaults", () => {
    const waitSchema: ActionParamsSchema = {
      type: "object",
      properties: { ms: { type: "integer", default: 1000 } },
    };
    expect(validateParams(waitSchema, {})).toEqual({ ok: true, value: { ms: 1000 } });
    expect(validateParams(waitSchema, { ms: 5 })).toEqual({ ok: true, value: { ms: 5 } });
  });

  it("rejects unknown keys (extra forbidden)", () => {
    const res = validateParams(clickSchema, { index: 1, foo: "bar" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain('unknown parameter "foo" (not allowed)');
    }
  });

  it("rejects non-object params", () => {
    expect(validateParams(clickSchema, [1])).toEqual({
      ok: false,
      errors: ["params must be a JSON object"],
    });
  });

  it("rejects wrong types and out-of-enum strings", () => {
    const scrollSchema: ActionParamsSchema = {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
      },
    };
    const res = validateParams(scrollSchema, { direction: "left" });
    expect(res.ok).toBe(false);
    expect(validateParams(clickSchema, { index: "2" }).ok).toBe(false);
    expect(validateParams(clickSchema, { index: 2.5 }).ok).toBe(false);
    expect(validateParams(clickSchema, { index: 1 }).ok).toBe(true);
  });

  it("reports missing required params", () => {
    const res = validateParams(clickSchema, {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain('missing required parameter "index"');
    }
  });
});

describe("toJsonSchema", () => {
  it("derives an OpenAI-style object schema with additionalProperties false", () => {
    expect(toJsonSchema(clickSchema)).toEqual({
      type: "object",
      properties: { index: { type: "integer", description: "DOM index (>= 1)." } },
      required: ["index"],
      additionalProperties: false,
    });
  });
});

describe("describeActionParams", () => {
  it("formats the browser-use prompt description", () => {
    expect(describeActionParams("click", "Click an element.", clickSchema)).toBe(
      "click: Click an element. (index=integer (DOM index (>= 1).))",
    );
  });

  it("marks optional params", () => {
    const schema: ActionParamsSchema = {
      type: "object",
      properties: { ms: { type: "integer" } },
    };
    expect(describeActionParams("wait", "Wait.", schema)).toBe(
      "wait: Wait. (ms=integer (optional))",
    );
  });

  it("handles no-param actions", () => {
    const schema: ActionParamsSchema = { type: "object", properties: {} };
    expect(describeActionParams("go_back", "Go back.", schema)).toBe(
      "go_back: Go back.",
    );
  });
});

import { describe, expect, it } from "vitest";
import { createRegistry, ActionRegistry } from "./registry.js";
import { registerBuiltins } from "./actions.js";
import type { RegisteredAction } from "./types.js";

function makeAction(overrides: Partial<RegisteredAction> = {}): RegisteredAction {
  return {
    name: "test_action",
    description: "A test action.",
    terminatesSequence: false,
    params: { type: "object", properties: {} },
    async execute() {
      return { isDone: false };
    },
    ...overrides,
  };
}

describe("ActionRegistry", () => {
  it("registers, lists, and gets actions", () => {
    const registry = new ActionRegistry();
    registry.register(makeAction());
    expect(registry.names()).toEqual(["test_action"]);
    expect(registry.get("test_action")?.name).toBe("test_action");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("rejects duplicate registration", () => {
    const registry = new ActionRegistry();
    registry.register(makeAction());
    expect(() => registry.register(makeAction())).toThrow(/already registered/);
  });

  it("describes actions and validates params via the registry", () => {
    const registry = new ActionRegistry();
    registry.register(
      makeAction({
        name: "click",
        description: "Click an element.",
        params: {
          type: "object",
          properties: { index: { type: "integer" } },
          required: ["index"],
        },
      }),
    );
    expect(registry.validate("click", { index: 1 }).ok).toBe(true);
    expect(registry.validate("click", { index: "x" }).ok).toBe(false);
    expect(registry.validate("nope", {}).ok).toBe(false);
  });
});

describe("domain filtering", () => {
  it("hides domain-filtered actions when no page URL matches", () => {
    const registry = new ActionRegistry();
    registry.register(
      makeAction({ name: "search", description: "Site search.", domains: ["example.com"] }),
    );
    registry.register(makeAction({ name: "generic", description: "Always." }));

    const withUrl = registry.getPromptDescription("https://example.com/path");
    expect(withUrl).toContain("search");
    const otherUrl = registry.getPromptDescription("https://other.org");
    expect(otherUrl).not.toContain("search");
    expect(otherUrl).toContain("generic");
  });

  it("supports wildcard domains", () => {
    const registry = new ActionRegistry();
    registry.register(
      makeAction({ name: "docs", description: "Docs.", domains: ["*.example.com"] }),
    );
    expect(registry.getPromptDescription("https://docs.example.com/x")).toContain("docs");
    expect(registry.getPromptDescription("https://evil-example.com/x")).not.toContain("docs");
  });
});

describe("buildActionListSchema", () => {
  it("produces a oneOf discriminated union", () => {
    const registry = new ActionRegistry();
    registry.register(
      makeAction({
        name: "click",
        description: "Click.",
        params: {
          type: "object",
          properties: { index: { type: "integer" } },
          required: ["index"],
        },
      }),
    );
    const schema = registry.buildActionListSchema();
    expect(schema.type).toBe("array");
    expect(schema.minItems).toBe(1);
    const items = (schema.items as { oneOf: unknown[] }).oneOf;
    expect(items).toHaveLength(1);
    const item = items[0] as { properties: { name: Record<string, unknown>; params: Record<string, unknown> } };
    expect(item.properties.name).toEqual({ type: "string", const: "click" });
    expect(item.properties.params.additionalProperties).toBe(false);
  });
});

describe("registerBuiltins", () => {
  it("registers all builtins plus done", () => {
    const registry = createRegistry();
    registerBuiltins((a) => registry.register(a));
    const names = registry.names();
    for (const expected of [
      "navigate",
      "go_back",
      "click",
      "input_text",
      "scroll",
      "wait",
      "open_tab",
      "switch_tab",
      "close_tab",
      "extract",
      "find_text",
      "screenshot",
      "evaluate",
      "done",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

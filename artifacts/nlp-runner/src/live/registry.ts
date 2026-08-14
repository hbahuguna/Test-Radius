/**
 * Action registry (PLAN-live-agent.md Phase 1) — port of browser-use
 * `tools/registry/{views,service}.py`.
 *
 * Actions are registered once, then derive (a) the `<page_specific_actions>`
 * prompt description, (b) the JSON Schema used for structured output / tool
 * calling, and (c) runtime dispatch. `LiveAgent` and `multiAct` only talk to
 * this registry — adding an action never touches the agent loop.
 */
import {
  describeActionParams,
  toJsonSchema,
  validateParams,
  type ActionParamsSchema,
  type Params,
  type ValidationResult,
} from "./schema.js";
import type {
  ActionCall,
  ActionResult,
  LiveContext,
  RegisteredAction,
} from "./types.js";

export class ActionRegistry {
  private readonly actions = new Map<string, RegisteredAction>();

  register(action: RegisteredAction): void {
    if (this.actions.has(action.name)) {
      throw new Error(`action "${action.name}" is already registered`);
    }
    this.actions.set(action.name, action);
  }

  get(name: string): RegisteredAction | undefined {
    return this.actions.get(name);
  }

  list(): RegisteredAction[] {
    return [...this.actions.values()];
  }

  names(): string[] {
    return [...this.actions.keys()];
  }

  /**
   * Browser-use `ActionRegistry.get_prompt_description(page_url)`: with a URL
   * only domain-filtered actions are listed; without one, all actions that
   * have no domain filter.
   */
  getPromptDescription(pageUrl?: string): string {
    const visible = pageUrl
      ? this.list().filter((a) => this.matchesDomains(a, pageUrl))
      : this.list().filter((a) => !a.domains?.length);
    return visible.map((a) => describeActionParams(a.name, a.description, a.params)).join("\n");
  }

  validate(name: string, params: unknown): ValidationResult {
    const action = this.get(name);
    if (!action) {
      return { ok: false, errors: [`unknown action "${name}"`] };
    }
    return validateParams(action.params, params);
  }

  execute(name: string, ctx: LiveContext, params: Params): Promise<ActionResult> {
    const action = this.get(name);
    if (!action) throw new Error(`unknown action "${name}"`);
    return action.execute(ctx, params);
  }

  /**
   * JSON Schema for a single action object:
   * `{ name: <const>, params: <paramsSchema> }` with `additionalProperties: false`.
   */
  private actionObjectSchema(action: RegisteredAction): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name: { type: "string", const: action.name },
        params: toJsonSchema(action.params),
      },
      required: ["name", "params"],
      additionalProperties: false,
    };
  }

  /**
   * JSON Schema for the whole `AgentOutput.action` array: a `oneOf` of every
   * registered action object — the strict-discriminated-union equivalent of
   * browser-use's pydantic `ActionModel`.
   */
  buildActionListSchema(pageUrl?: string): Record<string, unknown> {
    const candidates = this.list().filter(
      (a) => !pageUrl || this.matchesDomains(a, pageUrl),
    );
    return {
      type: "array",
      minItems: 1,
      items: {
        oneOf: candidates.map((a) => this.actionObjectSchema(a)),
      },
    };
  }

  private matchesDomains(action: RegisteredAction, pageUrl: string): boolean {
    if (!action.domains?.length) return true;
    let host = "";
    try {
      host = new URL(pageUrl).host;
    } catch {
      host = pageUrl;
    }
    return action.domains.some((glob) => globMatch(glob, host));
  }
}

/** Register the registry into an `ActionRegistry` instance. */
export function createRegistry(): ActionRegistry {
  return new ActionRegistry();
}

function globMatch(glob: string, value: string): boolean {
  if (glob.includes("*")) {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(value);
  }
  return value === glob || value.endsWith(`.${glob}`);
}

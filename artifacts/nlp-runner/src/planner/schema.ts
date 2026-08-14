export const ACTION_TYPES = [
  "navigate",
  "click",
  "fill",
  "select",
  "scroll",
  "wait",
  "assert",
  "extract",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ASSERT_KINDS = ["text", "url", "visible"] as const;
export type AssertKind = (typeof ASSERT_KINDS)[number];

export interface NavigateAction { type: "navigate"; url: string }
export interface ClickAction { type: "click"; ref: number }
export interface FillAction { type: "fill"; ref: number; value: string }
export interface SelectAction { type: "select"; ref: number; value: string }
export interface ScrollAction { type: "scroll"; ref?: number }
export interface WaitAction { type: "wait"; ms?: number }
export interface AssertAction { type: "assert"; kind: AssertKind; ref?: number; value?: string }
export interface ExtractAction { type: "extract"; ref: number; name: string }
export type Action =
  | NavigateAction
  | ClickAction
  | FillAction
  | SelectAction
  | ScrollAction
  | WaitAction
  | AssertAction
  | ExtractAction;

export interface PlanTurn {
  milestones?: string[];
  actions: Action[];
  done?: boolean;
  hint?: string;
  /**
   * The milestone this turn's actions are advancing toward (QF-55 confirm mode).
   * Required on the first turn; echoed thereafter. Lets the agent prompt the
   * human at each milestone boundary.
   */
  currentMilestone?: string;
}

export interface ParsedPlan { ok: true; plan: PlanTurn }
export interface ParseError { ok: false; errors: string[] }
export type ParsePlanResult = ParsedPlan | ParseError;

function readStr(a: Record<string, unknown>, k: string): string | null {
  const v = a[k];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readInt(a: Record<string, unknown>, type: string, k: string): number | string {
  const v = a[k];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return `${type}: ${k} must be an integer`;
  }
  if (!Number.isInteger(v)) {
    return `${type}: ${k} must be an integer, got ${v}`;
  }
  return v;
}

export function validateAction(obj: unknown): Action | string[] {
  if (typeof obj !== "object" || obj === null) {
    return ["action must be an object"];
  }
  const a = obj as Record<string, unknown>;
  const errors: string[] = [];

  const type = a.type;
  if (typeof type !== "string" || !(ACTION_TYPES as readonly string[]).includes(type)) {
    return [`invalid action type: ${String(type)}`];
  }
  const t = type as ActionType;
  const errStr = (k: string) => `${t}: ${k} must be a non-empty string`;

  switch (t) {
    case "navigate": {
      const url = readStr(a, "url");
      if (url === null) return [errStr("url")];
      return { type: "navigate", url };
    }
    case "click": {
      const r = readInt(a, t, "ref");
      if (typeof r === "string") return [r];
      if (r < 1) return [`${t}: ref must be >= 1`];
      return { type: "click", ref: r };
    }
    case "fill":
    case "select": {
      const r = readInt(a, t, "ref");
      if (typeof r === "string") return [r];
      if (r < 1) return [`${t}: ref must be >= 1`];
      const value = readStr(a, "value");
      if (value === null) return [errStr("value")];
      return t === "select"
        ? { type: "select", ref: r, value }
        : { type: "fill", ref: r, value };
    }
    case "scroll": {
      if (a.ref === undefined) return { type: "scroll" };
      const r = readInt(a, t, "ref");
      if (typeof r === "string") return [r];
      if (r < 1) return [`${t}: ref must be >= 1`];
      return { type: "scroll", ref: r };
    }
    case "wait": {
      const out: WaitAction = { type: "wait" };
      if (a.ms !== undefined) {
        const v = a.ms;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          return [`${t}: ms must be a non-negative integer`];
        }
        out.ms = v;
      }
      return out;
    }
    case "assert": {
      const kind = a.kind;
      if (typeof kind !== "string" || !(ASSERT_KINDS as readonly string[]).includes(kind)) {
        return [`${t}: kind must be one of ${ASSERT_KINDS.join(",")}`];
      }
      const ak = kind as AssertKind;
      const out: AssertAction = { type: "assert", kind: ak };
      if (ak === "url") {
        const value = readStr(a, "value");
        if (value === null) return [errStr("value")];
        out.value = value;
        return out;
      }
      const r = readInt(a, t, "ref");
      if (typeof r === "string") return [r];
      if (r < 1) return [`${t}: ref must be >= 1`];
      out.ref = r;
      if (a.value !== undefined) {
        const value = readStr(a, "value");
        if (value === null) return [errStr("value")];
        out.value = value;
      }
      return out;
    }
    case "extract": {
      const r = readInt(a, t, "ref");
      if (typeof r === "string") return [r];
      if (r < 1) return [`${t}: ref must be >= 1`];
      const name = readStr(a, "name");
      if (name === null) return [errStr("name")];
      return { type: "extract", ref: r, name };
    }
    default: {
      const _exhaustive: never = t;
      return [`unhandled action type: ${_exhaustive}`];
    }
  }
}

export function parsePlan(text: string): ParsePlanResult {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return { ok: false, errors: ["no top-level JSON object found"] };
  }
  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, errors: [`invalid JSON: ${(e as Error).message}`] };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, errors: ["plan must be a JSON object"] };
  }
  const p = parsed as Record<string, unknown>;
  const errors: string[] = [];

  if (!Array.isArray(p.actions)) {
    errors.push("plan.actions must be an array");
  }

  const milestones: string[] | undefined = Array.isArray(p.milestones)
    ? p.milestones.map((m) => String(m))
    : undefined;

  let done: boolean | undefined;
  if (p.done !== undefined) {
    if (typeof p.done !== "boolean") {
      errors.push("plan.done must be a boolean");
    } else {
      done = p.done;
    }
  }

  let hint: string | undefined;
  if (p.hint !== undefined) {
    if (typeof p.hint !== "string") {
      errors.push("plan.hint must be a string");
    } else {
      hint = p.hint;
    }
  }

  let currentMilestone: string | undefined;
  if (p.currentMilestone !== undefined) {
    if (typeof p.currentMilestone !== "string") {
      errors.push("plan.currentMilestone must be a string");
    } else {
      currentMilestone = p.currentMilestone;
    }
  }

  const actions: Action[] = [];
  if (Array.isArray(p.actions)) {
    p.actions.forEach((a, i) => {
      const res = validateAction(a);
      if (typeof res === "string") {
        errors.push(`action[${i}] invalid: ${res}`);
      } else if (Array.isArray(res)) {
        res.forEach((e) => errors.push(`action[${i}] invalid: ${e}`));
      } else {
        actions.push(res);
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, plan: { milestones, actions, done, hint, currentMilestone } };
}

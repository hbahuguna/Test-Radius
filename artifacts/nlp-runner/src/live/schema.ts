/**
 * Strict parameter schema DSL for the live-agent action registry
 * (PLAN-live-agent.md Phase 1).
 *
 * Serves the three roles zod would: (1) runtime validation of the model's
 * JSON params (unknown keys rejected — the pydantic `extra='forbid'` parity),
 * (2) JSON-Schema derivation for `response_format: json_schema` / tool
 * calling, and (3) prompt descriptions for `<page_specific_actions>`.
 */

export type ParamType = "string" | "integer" | "number" | "boolean";

export interface ParamSchema {
  type: ParamType;
  description?: string;
  /** Allowed values for string params. */
  enum?: string[];
  default?: string | number | boolean;
}

export interface ActionParamsSchema {
  type: "object";
  properties: Record<string, ParamSchema>;
  required?: string[];
}

export type Params = Record<string, unknown>;

export type ValidationResult =
  | { ok: true; value: Params }
  | { ok: false; errors: string[] };

export function validateParams(
  schema: ActionParamsSchema,
  input: unknown,
): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["params must be a JSON object"] };
  }
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(obj)) {
    if (!(key in schema.properties)) {
      errors.push(`unknown parameter "${key}" (not allowed)`);
    }
  }

  const value: Params = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    const present = key in obj;
    if (!present) {
      if (spec.default !== undefined) {
        value[key] = spec.default;
        continue;
      }
      if (schema.required?.includes(key)) {
        errors.push(`missing required parameter "${key}"`);
      }
      continue;
    }
    const raw = obj[key];
    const checked = checkType(spec, raw);
    if (!checked.ok) {
      errors.push(`parameter "${key}": ${checked.error}`);
      continue;
    }
    value[key] = checked.value;
  }

  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function checkType(
  spec: ParamSchema,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (spec.type) {
    case "string":
      if (typeof raw !== "string") {
        return { ok: false, error: `expected a string, got ${typeof raw}` };
      }
      if (spec.enum && !spec.enum.includes(raw)) {
        return {
          ok: false,
          error: `expected one of ${spec.enum.join(", ")}, got "${raw}"`,
        };
      }
      return { ok: true, value: raw };
    case "integer":
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return { ok: false, error: `expected an integer, got ${typeof raw}` };
      }
      return { ok: true, value: raw };
    case "number":
      if (typeof raw !== "number" || Number.isNaN(raw)) {
        return { ok: false, error: `expected a number, got ${typeof raw}` };
      }
      return { ok: true, value: raw };
    case "boolean":
      if (typeof raw !== "boolean") {
        return { ok: false, error: `expected a boolean, got ${typeof raw}` };
      }
      return { ok: true, value: raw };
  }
}

/** Derive the OpenAI-style JSON Schema for an action's params. */
export function toJsonSchema(schema: ActionParamsSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    const prop: Record<string, unknown> = { type: spec.type };
    if (spec.description) prop.description = spec.description;
    if (spec.enum) prop.enum = spec.enum;
    properties[key] = prop;
  }
  return {
    type: "object",
    properties,
    required: schema.required ?? [],
    additionalProperties: false,
  };
}

/**
 * Browser-use `RegisteredAction.prompt_description()` port:
 * `name: description. (param=type (param description), ...)`
 */
export function describeActionParams(
  name: string,
  description: string,
  schema: ActionParamsSchema,
): string {
  const desc = description.endsWith(".") ? description.slice(0, -1) : description;
  const parts = Object.entries(schema.properties).map(([key, spec]) => {
    const required = schema.required?.includes(key) ?? false;
    const suffix = required ? "" : " (optional)";
    const detail = spec.description
      ? ` (${spec.description}${suffix})`
      : suffix
        ? ` (optional)`
        : "";
    return `${key}=${spec.type}${detail}`;
  });
  return parts.length
    ? `${name}: ${desc}. (${parts.join(", ")})`
    : `${name}: ${desc}.`;
}

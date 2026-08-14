/**
 * The A11y LLM planner (Story QF-48 / QF-50 / QF-49).
 *
 * `Planner.askPlan` asks the LLM for a plan turn, parses it, and retries on
 * malformed output. Malformed output is retried up to `maxRetries` times (2 by
 * default, per QF-49), then throws `PlanParseError`.
 */
import type { LLMClient } from "../llm/client.js";
import { parsePlan, type PlanTurn, type ParsePlanResult } from "./schema.js";
import { buildMessages, type HistoryEntry, type BuildMessagesParams } from "./prompt.js";

export class PlanParseError extends Error {
  override name = "PlanParseError";
  public override cause?: ParsePlanResult;

  constructor(
    public readonly errors: string[],
    public readonly attempts: number,
    cause?: ParsePlanResult,
  ) {
    super(`Failed to parse LLM plan after ${attempts} attempt(s): ${errors.join("; ")}`);
    this.cause = cause;
  }
}

export interface AskPlanResult {
  plan: PlanTurn;
  attempts: number;
  raw: string;
}

export interface PlannerOptions {
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
}

export class Planner {
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly maxRetries: number;

  constructor(
    private readonly llm: LLMClient,
    options: PlannerOptions = {},
  ) {
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 1500;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async askPlan(
    params: Omit<BuildMessagesParams, "history"> & { history: HistoryEntry[] },
  ): Promise<AskPlanResult> {
    let messages = buildMessages(params);
    let lastParse: ParsePlanResult | undefined;

    const totalAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const res = await this.llm.chat(messages, {
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        responseFormat: { type: "json_object" },
      });
      const parsed = parsePlan(res.text);
      if (parsed.ok) {
        return { plan: parsed.plan, attempts: attempt, raw: res.text };
      }
      lastParse = parsed;
      if (attempt < totalAttempts) {
        // feed back the parse errors and ask for a valid object
        messages = [
          ...messages,
          {
            role: "user",
            content: `Your output was not a valid plan object. Errors:\n- ${parsed.errors.join("\n- ")}\nRe-emit ONLY a valid JSON plan object with "actions" (array of action objects) and "milestones" (array of strings). No prose, no markdown.`,
          },
        ];
      }
    }
    throw new PlanParseError(
      lastParse && !lastParse.ok ? lastParse.errors : ["unknown parse failure"],
      totalAttempts,
      lastParse,
    );
  }
}

import OpenAI from "openai";
import type { GeneratedTraceStep } from "./playwright-script";

/**
 * LLM-based finalizer that synthesizes production Playwright code from the
 * full context of a browser-use run: the goal, the run URL, the recorded
 * action trace, the deterministic Stagehand draft, and the final URL (used for
 * a closing assertion).
 *
 * It writes code only (chat completions, no browser), so thinking-capable
 * providers like opencode work fine here — the forced tool_choice problem that
 * breaks Stagehand's act/click does not apply to plain text generation.
 */

export interface FinalizeScriptInput {
  url: string;
  goal: string;
  trace: GeneratedTraceStep[];
  draftCode: string;
  finalUrl?: string;
  provider: string;
  apiKey: string;
}

export interface FinalizedScript {
  code: string;
  explanation: string;
  warnings: string[];
}

export type FinalizeProgress =
  | { type: "draft" }
  | { type: "draft.ready"; chars: number }
  | { type: "calling"; provider: string; model: string }
  | { type: "token"; delta: string }
  | { type: "complete"; result: FinalizedScript }
  | { type: "error"; message: string };

const SYSTEM_PROMPT = `You are a senior Playwright + TypeScript test engineer. Given a browser automation trace, produce a final, production-quality Playwright script.

Rules:
- Return JSON only, with keys: code, explanation, warnings.
- The script MUST keep the contract:
  export default async function run({ page, step }: { page: Page; step: (name: string, action: () => Promise<void>) => Promise<void>; }) { ... }
- Only import is: import type { Page } from "playwright";
- Prefer resilient locators: getByRole / getByLabel / getByPlaceholder / getByText. Avoid brittle XPath when the trace offers an accessible name.
- Preserve the real navigation: include page.goto for the starting URL, add page.waitForURL when the page URL changes after an action, and finish with a final assertion that the run landed on the expected final URL (page.waitForURL((u) => u.href.includes("<final-url>"))) and/or expected final text.
- For text input, use process.env.TEST_VALUE ?? "<value>" so credentials/secrets are not hardcoded.
- Keep steps wrapped in step("...", async () => { ... }).
- Do NOT add secrets, filesystem, process, or arbitrary network access.
- If the trace is insufficient, still emit the scaffold and explain what to fill in via warnings.`;

export async function* finalizePlaywrightScriptStream(input: FinalizeScriptInput): AsyncGenerator<FinalizeProgress> {
  try {
    yield { type: "draft" };
    const isOpenCode = input.provider.toLowerCase() === "opencode";
    const model = isOpenCode ? "big-pickle" : process.env.CODE_REPAIR_MODEL || "gpt-4o-mini";
    const client = new OpenAI({
      apiKey: input.apiKey,
      baseURL: isOpenCode ? (process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1") : undefined,
    });

    yield { type: "calling", provider: input.provider, model };
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            url: input.url,
            goal: input.goal.slice(0, 2000),
            finalUrl: input.finalUrl ?? null,
            draft: input.draftCode.slice(0, 250_000),
            trace: input.trace.slice(0, 100),
          }),
        },
      ],
      temperature: 0,
      stream: true,
    });

    let content = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        content += delta;
        yield { type: "token", delta };
      }
    }

    const jsonText = content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || content;
    const parsed = JSON.parse(jsonText) as { code?: string; explanation?: string; warnings?: string[] };
    if (!parsed.code || !parsed.code.includes("export default")) {
      throw new Error("Finalize response did not contain a valid script (missing export default).");
    }
    const result: FinalizedScript = {
      code: parsed.code,
      explanation: parsed.explanation || "Finalized from the recorded browser trace.",
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
    yield { type: "complete", result };
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
    return;
  }
}

export async function finalizePlaywrightScript(input: FinalizeScriptInput): Promise<FinalizedScript> {
  for await (const event of finalizePlaywrightScriptStream(input)) {
    if (event.type === "complete") return event.result;
    if (event.type === "error") throw new Error(event.message);
  }
  throw new Error("Finalize ended without a result.");
}
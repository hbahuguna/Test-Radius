import type { Response } from "express";
import { logger } from "../lib/logger";
import { runStream, stopRun, getScreenshot, ByokClient, chatAgentTurn, type ChatContext } from "@workspace/agent";

export interface AgenticRequestBody {
  url: string;
  goal: string;
  assertions?: Array<{
    type: string;
    target?: string;
    expected?: string;
    pattern?: string;
    description?: string;
  }>;
  headless?: boolean;
  max_turns?: number;
  mode?: "reactive" | "planned";
  // BYOK model override keys (plaintext, passed through from decrypted vault)
  openai_api_key?: string;
  anthropic_api_key?: string;
  google_api_key?: string;
  opencode_api_key?: string;
  openrouter_api_key?: string;
  poolside_api_key?: string;
  model_provider?: string;
  model?: string;
}

export interface AgenticRunSummary {
  success: boolean | null;
  error: string | null;
  assertions: unknown;
  assertionResults: Array<{ index: number; pass: boolean; reason: string }> | null;
  generatedCode: string | null;
}

/**
 * Run the agentic test in-process (no external Python :8006 service) and
 * stream the NDJSON events directly to the Express response. Resolves with a
 * summary of the final `done` event for DB persistence/credit refunds.
 */
export async function proxyAgenticStream(
  body: AgenticRequestBody,
  res?: Response,
): Promise<AgenticRunSummary> {
  logger.info({ target: body.url }, "Running agentic run in-process");
  const byok: Record<string, string> = {};
  if (body.openai_api_key) byok.openai = body.openai_api_key;
  if (body.anthropic_api_key) byok.anthropic = body.anthropic_api_key;
  if (body.google_api_key) byok.google = body.google_api_key;
  if (body.opencode_api_key) byok.opencode = body.opencode_api_key;
  if (body.openrouter_api_key) byok.openrouter = body.openrouter_api_key;
  if (body.poolside_api_key) byok.poolside = body.poolside_api_key;

  const input = {
    goal: body.goal,
    url: body.url,
    assertions: body.assertions ?? [],
    headless: body.headless ?? true,
    maxTurns: body.max_turns ?? 30,
    mode: body.mode ?? "reactive",
    byok: Object.keys(byok).length ? byok : null,
    model: body.model ?? null,
  };

  if (res) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }

  const summary: AgenticRunSummary = {
    success: null,
    error: null,
    assertions: null,
    assertionResults: null,
    generatedCode: null,
  };

  for await (const line of runStream(input)) {
    if (res) res.write(line);
    if (line.trim()) {
      try {
        const evt = JSON.parse(line);
        if (evt.event === "done") {
          summary.success = Boolean(evt.success);
          summary.error = typeof evt.error === "string" ? evt.error : null;
          summary.assertions = evt.trace?.assertions ?? null;
          summary.assertionResults = Array.isArray(evt.assertion_results) ? evt.assertion_results : null;
          summary.generatedCode =
            typeof evt.generated_code === "string" ? evt.generated_code : null;
        }
      } catch {
        /* ignore malformed line */
      }
    }
  }
  return summary;
}

/**
 * Ask the in-process agent to stop the current run.
 */
export async function stopAgentRun(): Promise<void> {
  stopRun();
}

/**
 * Fetch the agent's current live screenshot (base64).
 */
export async function getAgentScreenshot(): Promise<Buffer | null> {
  const r = await getScreenshot();
  if (!r?.screenshot) return null;
  return Buffer.from(r.screenshot, "base64");
}

/**
 * Run an agentic chat turn: user message → browser actions → report.
 * Uses the same browser session as the agent.
 */
export async function* streamChatResponse(
  message: string,
  context: string,
  byok: Record<string, string>,
  model: string | null,
  url: string | null,
): AsyncGenerator<string, void, unknown> {
  const providers = Object.entries(byok).map(([provider, apiKey]) => {
    return new ByokClient(provider, apiKey, model ?? undefined);
  });

  if (providers.length === 0) {
    yield "No LLM provider available. Add an API key in Settings.";
    return;
  }

  const client = providers[0];

  // Parse URL and goal from context string
  const parsedUrl = url || "https://example.com";
  const goal = context || "User is chatting about a test run";

  const chatContext: ChatContext = {
    url: parsedUrl,
    goal,
    messages: [],
  };

  // Run the agentic chat turn
  for await (const token of chatAgentTurn(message, chatContext, client)) {
    yield token;
  }
}

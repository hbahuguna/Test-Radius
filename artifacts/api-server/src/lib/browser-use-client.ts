import type { Response } from "express";
import { Buffer } from "buffer";
import { logger } from "./logger";

const BROWSER_USE_URL = process.env.BROWSER_USE_URL || "http://localhost:8001";
const INTERNAL_SECRET = process.env.BROWSER_USE_INTERNAL_SECRET || "dev-secret-change-in-production";

// ============================================================
// Browser-Auto (existing, for backward compatibility)
// ============================================================

export interface BrowserAutoRequestBody {
  url: string;
  goal: string;
  assertions?: Array<{
    type: string;
    target?: string;
    expected?: string;
    pattern?: string;
    description?: string;
    selector?: string;
  }>;
  headless?: boolean;
  max_turns?: number;
  use_vision?: boolean;
  openai_api_key?: string;
  anthropic_api_key?: string;
  google_api_key?: string;
  opencode_api_key?: string;
  openrouter_api_key?: string;
  poolside_api_key?: string;
  model_provider?: string;
  model?: string;
}

export interface BrowserAutoRunSummary {
  success: boolean | null;
  error: string | null;
  assertions: unknown;
  assertionResults: Array<{ index: number; pass: boolean; reason: string }> | null;
  generatedCode: string | null;
  stagehandMetrics?: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    inferenceTimeMs: number;
  } | null;
}

interface RunResponse {
  run_id: string;
  status: string;
  message: string;
}

interface PythonEvent {
  event?: string;
  success?: boolean;
  message?: string;
  error?: string | boolean;
  description?: string;
  step_type?: string;
  step_number?: number;
  screenshot_url?: string;
  screenshot?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  ok?: boolean;
  result?: unknown;
  thinking?: string;
  text?: string;
}

let currentRunId: string | null = null;

export async function proxyBrowserAutoStream(
  body: BrowserAutoRequestBody,
  res?: Response,
): Promise<BrowserAutoRunSummary> {
  logger.info({ target: body.url }, "Running browser-auto agent via Python service");

  if (res) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }

  const summary: BrowserAutoRunSummary = {
    success: null,
    error: null,
    assertions: null,
    assertionResults: null,
    generatedCode: null,
    stagehandMetrics: null,
  };

  try {
    const runResponse = await fetch(`${BROWSER_USE_URL}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({
        url: body.url,
        goal: body.goal,
        model_id: body.model || "openai/gpt-4o",
        max_steps: body.max_turns || 25,
        poolside_api_key: body.poolside_api_key,
        model_provider: body.model_provider,
        use_vision: body.use_vision,
      }),
    });

    if (!runResponse.ok) {
      const error = await runResponse.text();
      throw new Error(`Failed to start run: ${error}`);
    }

    const runData = (await runResponse.json()) as RunResponse;
    currentRunId = runData.run_id;
    logger.info({ run_id: runData.run_id }, "Browser-use run started");

    const streamResponse = await fetch(
      `${BROWSER_USE_URL}/run/${runData.run_id}/stream`,
      {
        headers: {
          "X-Internal-Secret": INTERNAL_SECRET,
        },
      }
    );

    if (!streamResponse.ok) {
      throw new Error("Failed to stream events");
    }

    const reader = streamResponse.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let stepNum = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event: PythonEvent = JSON.parse(line.slice(6));
            
            // Pass through all event types from Python backend
            if (event.step_type === "done" || event.event === "done") {
              stepNum++;
              const ndjson = JSON.stringify({
                event: "done",
                success: event.success ?? true,
                message: event.message || "Run completed",
              });
              if (res) res.write(ndjson + "\n");
              summary.success = event.success ?? true;
              summary.error = event.error && typeof event.error === "string" ? event.error : null;
            } else if (event.step_type) {
              stepNum++;
              const ndjson = JSON.stringify({
                event: "step",
                step: stepNum,
                type: event.step_type,
                description: event.description || "",
                screenshot_url: event.screenshot_url,
                error: event.error,
              });
              if (res) res.write(ndjson + "\n");
            } else if (event.event === "tool_call") {
              // Pass through tool_call events for step updates
              if (res) {
                res.write(JSON.stringify({
                  event: "tool_call",
                  name: event.name,
                  arguments: event.arguments || {},
                }) + "\n");
              }
            } else if (event.event === "tool_result") {
              // Pass through tool_result events for step updates
              if (res) {
                res.write(JSON.stringify({
                  event: "tool_result",
                  ok: event.ok,
                  result: event.result,
                }) + "\n");
              }
            } else if (event.event === "thinking") {
              // Pass through thinking events
              if (res) {
                res.write(JSON.stringify({
                  event: "thinking",
                  text: event.thinking || event.text || "",
                }) + "\n");
              }
            } else if (event.event === "screenshot") {
              // Pass through screenshot events
              if (res) {
                res.write(JSON.stringify({
                  event: "screenshot",
                  screenshot: event.screenshot,
                }) + "\n");
              }
            } else if (event.event === "error") {
              summary.success = false;
              summary.error = event.message || "Unknown error";
              if (res) {
                res.write(JSON.stringify({
                  event: "error",
                  message: event.message,
                }) + "\n");
              }
            }
          } catch {
            // Ignore malformed events
          }
        }
      }
    }

    if (res) {
      res.write(
        JSON.stringify({
          event: "done",
          success: summary.success,
          error: summary.error,
          metrics: summary.stagehandMetrics,
        }) + "\n"
      );
    }

    return summary;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Browser-auto run failed");

    summary.success = false;
    summary.error = errorMessage;

    if (res) {
      res.write(
        JSON.stringify({
          event: "done",
          success: false,
          error: errorMessage,
        }) + "\n"
      );
    }

    return summary;
  } finally {
    currentRunId = null;
  }
}

export async function stopBrowserAutoRun(): Promise<void> {
  if (!currentRunId) return;

  try {
    await fetch(`${BROWSER_USE_URL}/run/${currentRunId}/stop`, {
      method: "POST",
      headers: {
        "X-Internal-Secret": INTERNAL_SECRET,
      },
    });
  } catch (error) {
    logger.error({ error }, "Failed to stop browser-auto run");
  } finally {
    currentRunId = null;
  }
}

export async function getBrowserAutoScreenshot(): Promise<Buffer | null> {
  try {
    const response = await fetch(`${BROWSER_USE_URL}/screenshot`, {
      headers: {
        "X-Internal-Secret": INTERNAL_SECRET,
      },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { screenshot?: string };
    if (data.screenshot) {
      return Buffer.from(data.screenshot, "base64");
    }
    return null;
  } catch {
    return null;
  }
}

export async function* streamBrowserAutoChat(
  message: string,
  context: string,
  byok: Record<string, string>,
  model: string | null,
  url: string | null,
): AsyncGenerator<string, void, unknown> {
  const runResponse = await fetch(`${BROWSER_USE_URL}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_SECRET,
    },
    body: JSON.stringify({
      url: url || "https://example.com",
      goal: message,
      model_id: model || "openai/gpt-4o",
      max_steps: 5,
    }),
  });

  if (!runResponse.ok) {
    yield JSON.stringify({ error: "Failed to start run" });
    return;
  }

  const runData = (await runResponse.json()) as RunResponse;
  const streamResponse = await fetch(
    `${BROWSER_USE_URL}/run/${runData.run_id}/stream`,
    {
      headers: {
        "X-Internal-Secret": INTERNAL_SECRET,
      },
    }
  );

  if (!streamResponse.ok) {
    yield JSON.stringify({ error: "Failed to stream events" });
    return;
  }

  const reader = streamResponse.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event: PythonEvent = JSON.parse(line.slice(6));
          if (event.event === "done" || event.step_type === "done") {
            yield JSON.stringify({
              event: "done",
              message: event.message || "Run completed",
              success: event.success ?? true,
            });
          }
        } catch {
        }
      }
    }
  }
}

export const streamChatResponse = streamBrowserAutoChat;


// ============================================================
// Browser-Agent (new, with rich step events and chat)
// ============================================================

export interface BrowserAgentRunRequest {
  url: string;
  goal: string;
  model_id?: string;
  max_steps?: number;
  use_vision?: boolean;
  keep_alive?: boolean;
  poolside_api_key?: string;
  model_provider?: string;
}

export interface BrowserAgentStepEvent {
  event: "step";
  step_number: number;
  screenshot: string | null;
  model_output: {
    thinking: string | null;
    evaluation_previous_goal: string | null;
    memory: string | null;
    next_goal: string | null;
    actions: Array<{
      name: string;
      raw: Record<string, unknown>;
    }>;
  } | null;
  url: string | null;
  title: string | null;
}

export interface BrowserAgentDoneEvent {
  event: "done";
  success: boolean;
  message: string;
  duration?: number;
}

export interface BrowserAgentErrorEvent {
  event: "error";
  message: string;
}

export type BrowserAgentEvent = BrowserAgentStepEvent | BrowserAgentDoneEvent | BrowserAgentErrorEvent;

export interface BrowserAgentRunResult {
  run_id: string;
  success: boolean | null;
  error: string | null;
  stepCount: number;
  duration: number | null;
}

let currentAgentRunId: string | null = null;

export async function startBrowserAgentRun(
  body: BrowserAgentRunRequest,
  res?: Response,
): Promise<BrowserAgentRunResult | null> {
  logger.info({ target: body.url }, "Starting browser-agent run");

  try {
    const runResponse = await fetch(`${BROWSER_USE_URL}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({
        url: body.url,
        goal: body.goal,
        model_id: body.model_id || "poolside/laguna-xs-2.1",
        max_steps: body.max_steps || 30,
        use_vision: body.use_vision ?? false,
        keep_alive: body.keep_alive ?? true,
        poolside_api_key: body.poolside_api_key,
        model_provider: body.model_provider,
      }),
    });

    if (!runResponse.ok) {
      const error = await runResponse.text();
      throw new Error(`Failed to start run: ${error}`);
    }

    const runData = (await runResponse.json()) as RunResponse;
    currentAgentRunId = runData.run_id;
    logger.info({ run_id: runData.run_id }, "Browser-agent run started");

    // Await streaming - blocks until agent finishes
    const streamResult = res ? await streamAgentEvents(runData.run_id, res) : undefined;

    return {
      run_id: runData.run_id,
      success: streamResult?.success ?? null,
      error: streamResult?.error ?? null,
      stepCount: streamResult?.stepCount ?? 0,
      duration: streamResult?.duration ?? null,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Failed to start browser-agent run");

    if (res && !res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({
          event: "error",
          message: errorMessage,
        })}\n\n`
      );
    }

    return null;
  }
}

async function streamAgentEvents(runId: string, res: Response): Promise<{
  success: boolean | null;
  error: string | null;
  stepCount: number;
  duration: number | null;
}> {
  const streamResponse = await fetch(
    `${BROWSER_USE_URL}/run/${runId}/stream`,
    {
      headers: {
        "X-Internal-Secret": INTERNAL_SECRET,
      },
    }
  );

  if (!streamResponse.ok) {
    const result = { success: false, error: "Failed to connect to event stream", stepCount: 0, duration: null };
    res.write(
      `data: ${JSON.stringify({
        event: "error",
        message: "Failed to connect to event stream",
      })}\n\n`
    );
    return result;
  }

  const reader = streamResponse.body?.getReader();
  if (!reader) return { success: null, error: null, stepCount: 0, duration: null };

  const decoder = new TextDecoder();
  let buffer = "";
  let stepCount = 0;
  let finalSuccess: boolean | null = null;
  let finalError: string | null = null;
  let finalDuration: number | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event: BrowserAgentEvent = JSON.parse(line.slice(6));
            // Keep SSE format with "data: " prefix for frontend
            res.write(`data: ${JSON.stringify(event)}\n\n`);

            if (event.event === "step") {
              stepCount++;
            } else if (event.event === "done") {
              finalSuccess = event.success;
              finalDuration = event.duration ?? null;
              return { success: finalSuccess, error: null, stepCount, duration: finalDuration };
            } else if (event.event === "error") {
              finalError = event.message;
              return { success: false, error: finalError, stepCount, duration: null };
            }
          } catch {
            // Ignore malformed events
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { success: finalSuccess, error: finalError, stepCount, duration: finalDuration };
}

/**
 * Wait for a browser-agent run to complete without an HTTP response object.
 * Connects to the Python backend SSE stream and collects the result in memory.
 */
export async function waitForBrowserAgentRun(runId: string): Promise<BrowserAgentRunResult> {
  logger.info({ run_id: runId }, "Waiting for browser-agent run (background)");
  const result: BrowserAgentRunResult = { run_id: runId, success: null, error: null, stepCount: 0, duration: null };

  try {
    const streamResponse = await fetch(
      `${BROWSER_USE_URL}/run/${runId}/stream`,
      {
        headers: { "X-Internal-Secret": INTERNAL_SECRET },
      },
    );

    if (!streamResponse.ok) {
      result.error = "Failed to connect to event stream";
      return result;
    }

    const reader = streamResponse.body?.getReader();
    if (!reader) return result;

    const decoder = new TextDecoder();
    let buffer = "";
    let stepCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event: BrowserAgentEvent = JSON.parse(line.slice(6));
            if (event.event === "step") {
              stepCount++;
            } else if (event.event === "done") {
              result.success = event.success;
              result.stepCount = stepCount;
              result.duration = (event as BrowserAgentDoneEvent).duration ?? null;
              return result;
            } else if (event.event === "error") {
              result.success = false;
              result.error = event.message;
              result.stepCount = stepCount;
              return result;
            }
          } catch {
            // Ignore malformed events
          }
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error: errorMessage }, "Background agent run failed");
    result.success = false;
    result.error = errorMessage;
  }

  return result;
}

export async function sendBrowserAgentChat(
  runId: string,
  message: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${BROWSER_USE_URL}/run/${runId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({ message }),
    });

    return response.ok;
  } catch (error) {
    logger.error({ error }, "Failed to send chat message");
    return false;
  }
}

export async function stopBrowserAgentRun(): Promise<void> {
  if (!currentAgentRunId) return;

  try {
    await fetch(`${BROWSER_USE_URL}/run/${currentAgentRunId}/stop`, {
      method: "POST",
      headers: {
        "X-Internal-Secret": INTERNAL_SECRET,
      },
    });
  } catch (error) {
    logger.error({ error }, "Failed to stop browser-agent run");
  } finally {
    currentAgentRunId = null;
  }
}

export async function stopBrowserAgentRunWithId(runId: string): Promise<void> {
  try {
    await fetch(`${BROWSER_USE_URL}/run/${runId}/stop`, {
      method: "POST",
      headers: {
        "X-Internal-Secret": INTERNAL_SECRET,
      },
    });
  } catch (error) {
    logger.error({ error, runId }, "Failed to stop browser-agent run");
  }
}

export async function getBrowserAgentScreenshot(
  runId?: string,
): Promise<Buffer | null> {
  try {
    const url = runId
      ? `${BROWSER_USE_URL}/screenshot?run_id=${runId}`
      : `${BROWSER_USE_URL}/screenshot`;

    const response = await fetch(url, {
      headers: {
        "X-Internal-Secret": INTERNAL_SECRET,
      },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { screenshot?: string };
    if (data.screenshot) {
      return Buffer.from(data.screenshot, "base64");
    }
    return null;
  } catch {
    return null;
  }
}

export async function getBrowserAgentRunStatus(
  runId: string,
): Promise<{ status: string; success: boolean | null; error: string | null } | null> {
  try {
    const response = await fetch(`${BROWSER_USE_URL}/run/${runId}/status`, {
      headers: {
        "X-Internal-Secret": INTERNAL_SECRET,
      },
    });

    if (!response.ok) return null;
    const data = await response.json() as Record<string, unknown>;
    return {
      status: (data.status as string) || "unknown",
      success: (data.success as boolean) ?? null,
      error: (data.error as string) ?? null,
    };
  } catch {
    return null;
  }
}

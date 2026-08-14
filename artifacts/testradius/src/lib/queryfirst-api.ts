import { getSessionToken } from "@/lib/auth";

const API_BASE = "/api/queryfirst";

async function getAuthToken(): Promise<string> {
  return (await getSessionToken()) ?? "";
}

// ----- types -----------------------------------------------------------------

export interface QfTestStep {
  id: number;
  idx: number;
  action: string;
  selector: string | null;
  value: string | null;
  /** Human-readable label produced by stepToEnglish server-side */
  intent: string;
  /** True for cookie/consent steps that are automatically skipped on replay when absent */
  optional: boolean;
}

export interface QfSlot {
  name: string;
  kind: string;
  defaultValue: string | null;
}

export interface QfTest {
  id: number;
  name: string;
  source: string;
  query: string | null;
  entryUrl: string | null;
  stepCount: number;
  steps: QfTestStep[];
  slots: QfSlot[];
}

export interface QfRun {
  id: number;
  testId: number;
  status: string;
  llmCalls: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface QfActionTrace {
  action: string;
  raw: unknown;
  element: Record<string, unknown> | null;
}

export interface QfModelOutput {
  thinking?: string | null;
  evaluation_previous_goal?: string | null;
  memory?: string | null;
  next_goal?: string | null;
  actions?: Array<{ name: string; raw: Record<string, unknown> }>;
}

export type QfEvent =
  | { event: "started"; kind: "record" | "replay" | "browse"; testId?: number; testName?: string; stepCount?: number }
  | { event: "record"; type: "milestones"; milestones: string[] }
  | { event: "record"; type: "plan"; turn: number; currentMilestone?: string; actions?: unknown[]; done?: boolean; hint?: string }
  | { event: "record"; type: "step"; turn: number; stepIndex: number; action: QfActionTrace[]; ok?: boolean; error?: string; url?: string; title?: string; screenshot?: string | null; thinking?: string | null; nextGoal?: string | null; memory?: string | null }
  | { event: "record"; type: "loading"; stepIndex?: number; url?: string; title?: string | null; screenshot?: string | null }
  | { event: "record"; type: "guard"; turn: number; reason?: string }
  | { event: "record"; type: "error"; turn: number; error?: string }
  | { event: "replay"; type: "step" | "done"; idx: number; status: "passed" | "failed" | "skipped"; intent: string; detail: Record<string, unknown>; healed?: string | null; success?: boolean; error?: string }
  | { event: "browse"; type: "step_start" | "action" | "guard" | "done"; step?: number; maxSteps?: number; thinking?: string; evaluation?: string; memory?: string; nextGoal?: string; actionIndex?: number; name?: string; params?: Record<string, unknown>; ok?: boolean; error?: string; message?: string; success?: boolean; text?: string; steps?: number; actions?: number; llmCalls?: number; errors?: string[] }
  | { event: "done"; ok: boolean; testId?: number; report?: unknown; runId?: number; error?: string; llmCalls?: number; selfHealed?: number }
  | { event: "error"; message: string };

// ----- REST helpers ----------------------------------------------------------

async function authedFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await getAuthToken()}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function listTests(): Promise<{ tests: QfTest[] }> {
  return authedFetch<{ tests: QfTest[] }>("/tests");
}

export async function listRuns(testId: number): Promise<{ runs: QfRun[] }> {
  return authedFetch<{ runs: QfRun[] }>(`/runs/${testId}`);
}

export async function deleteTest(id: number): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>(`/tests/${id}`, { method: "DELETE" });
}

export async function deleteStep(
  testId: number,
  stepId: number,
): Promise<{ ok: boolean; steps: QfTestStep[] }> {
  return authedFetch<{ ok: boolean; steps: QfTestStep[] }>(
    `/tests/${testId}/steps/${stepId}`,
    { method: "DELETE" },
  );
}

export async function getScreenshot(): Promise<{ screenshot: string | null }> {
  return authedFetch<{ screenshot: string | null }>("/screenshot");
}

export async function stopRun(): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>("/stop", { method: "POST" });
}

// ----- SSE streaming ---------------------------------------------------------

interface StreamCallbacks {
  onEvent: (event: QfEvent) => void;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

async function streamPost(path: string, body: unknown, callbacks: StreamCallbacks): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await getAuthToken()}`,
    },
    body: JSON.stringify(body),
    signal: callbacks.signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message || `HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

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
            const event: QfEvent = JSON.parse(line.slice(6));
            callbacks.onEvent(event);
          } catch {
            // Ignore malformed events
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // User cancelled - ok
    } else {
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    reader.releaseLock();
  }
}

export function startRecord(
  request: { query: string; entry_url?: string; variables?: Record<string, string>; provider?: string; model_id?: string; api_key?: string; use_vision?: boolean; max_steps?: number },
  callbacks: StreamCallbacks,
): Promise<void> {
  return streamPost("/record", request, callbacks);
}

export function startReplay(
  request: { test_id: number; variables?: Record<string, string>; entry_url?: string; provider?: string; model_id?: string; api_key?: string; headful?: boolean },
  callbacks: StreamCallbacks,
): Promise<void> {
  return streamPost("/replay", request, callbacks);
}

export function startBrowse(
  request: { query: string; entry_url?: string; max_steps?: number; max_actions?: number; provider?: string; model_id?: string; api_key?: string },
  callbacks: StreamCallbacks,
): Promise<void> {
  return streamPost("/browse", request, callbacks);
}
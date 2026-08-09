const API_BASE = "/api/stagehand-agent";

function authHeaders(): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("auth_token") || ""}` };
}

export interface StagehandAction {
  type?: string;
  action?: string;
  description?: string;
  reasoning?: string;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  [key: string]: unknown;
}

export interface StagehandTraceStep {
  stepNumber: number;
  url: string | null;
  actions: StagehandAction[];
}

export interface StagehandRunResult {
  runId: string;
  status: string;
  result: { success: boolean; message: string; completed: boolean };
  trace: StagehandTraceStep[];
  code: string;
  warnings: string[];
  output?: Record<string, unknown> | null;
  metrics?: Record<string, number>;
  scriptId?: string | null;
}

export type StagehandLiveEvent =
  | { event: "started"; runId: string; url: string; goal: string }
  | { event: "loading"; url: string; title: string | null; screenshot: string | null }
  | { event: "step"; stepNumber: number; url: string; title: string | null; screenshot: string | null; actions: StagehandAction[]; text?: string | null }
  | (StagehandRunResult & { event: "done" })
  | { event: "error"; runId: string; message: string };

export async function runStagehandAgent(request: {
  url: string;
  goal: string;
  model_provider: string;
  model_id: string;
  max_steps: number;
}, onEvent?: (event: StagehandLiveEvent) => void): Promise<StagehandRunResult> {
  const response = await fetch(`${API_BASE}/run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || data.error || `Stagehand run failed (${response.status})`);
  }
  if (!response.body) throw new Error("Stagehand run returned no event stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: StagehandRunResult | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6)) as StagehandLiveEvent;
      onEvent?.(event);
      if (event.event === "done") completed = event;
      if (event.event === "error") throw new Error(event.message);
    }
  }
  if (!completed) throw new Error("Stagehand run ended without a completion event");
  return completed;
}

export async function generateStagehandCode(runId: string): Promise<StagehandRunResult> {
  const response = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/generate-code`, {
    method: "POST",
    headers: authHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Code generation failed (${response.status})`);
  return data as StagehandRunResult;
}

export async function runStagehandScript(scriptId: string, url: string): Promise<{ codeRunId: string }> {
  const response = await fetch(`${API_BASE}/scripts/${encodeURIComponent(scriptId)}/run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ url }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Script run failed (${response.status})`);
  return data as { codeRunId: string };
}

export interface CodeRunLiveEvent {
  event?: string;
  type?: string;
  kind?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

export async function streamCodeRunEvents(codeRunId: string, onEvent: (event: CodeRunLiveEvent) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${API_BASE}/code-runs/${encodeURIComponent(codeRunId)}/events`, {
    method: "GET",
    headers: authHeaders(),
    signal,
  });
  if (!response.ok || !response.body) {
    if (signal?.aborted) return;
    throw new Error("Code run event stream unavailable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      onEvent(JSON.parse(line.slice(6)) as CodeRunLiveEvent);
    }
  }
}

export async function stopStagehandCodeRun(codeRunId: string): Promise<void> {
  await fetch(`${API_BASE}/code-runs/${encodeURIComponent(codeRunId)}/stop`, {
    method: "POST",
    headers: authHeaders(),
  });
}

export interface StagehandRepairResult {
  code: string;
  warnings: string[];
  explanation?: string;
}

export async function repairStagehandScript(scriptId: string, errorText: string): Promise<StagehandRepairResult> {
  const response = await fetch(`${API_BASE}/scripts/${encodeURIComponent(scriptId)}/repair`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ error: errorText }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Repair failed (${response.status})`);
  return data as StagehandRepairResult;
}

export async function refineStagehandLocators(scriptId: string, instruction: string): Promise<{ locators: Array<{ selector?: string; description?: string; method?: string }> }> {
  const response = await fetch(`${API_BASE}/scripts/${encodeURIComponent(scriptId)}/refine-locators`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ instruction }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Locator refinement failed (${response.status})`);
  return data as { locators: Array<{ selector?: string; description?: string; method?: string }> };
}
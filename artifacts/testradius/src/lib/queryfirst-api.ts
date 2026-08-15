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
  /**
   * A short success phrase captured at record time (e.g. "Thanks for signing
   * up"). When set, replay short-circuits if this phrase is already visible on
   * the page — making the test idempotent against one-time side effects.
   */
  completionHint: string | null;
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

export type QfMode = "sequential" | "parallel" | "mixed";

export interface QfSuiteTest {
  suiteTestId: number;
  testId: number;
  position: number;
  parallel: boolean;
  name: string;
}

export interface QfSuite {
  id: number;
  name: string;
  description: string | null;
  mode: QfMode;
  createdAt: string;
  updatedAt: string;
  tests: QfSuiteTest[];
}

export interface QfTrainSuite {
  trainSuiteId: number;
  suiteId: number;
  position: number;
  parallel: boolean;
  name: string;
  mode: QfMode | null;
}

export interface QfTrain {
  id: number;
  name: string;
  description: string | null;
  mode: QfMode;
  createdAt: string;
  updatedAt: string;
  suites: QfTrainSuite[];
}

export interface QfSuiteRunItem {
  runId: number;
  testId: number;
  name: string;
  status: string;
  llmCalls: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface QfSuiteRun {
  id: number;
  suiteId: number;
  trainRunId: number | null;
  status: string;
  mode: QfMode;
  startedAt: string;
  finishedAt: string | null;
  error: unknown;
  runs: QfSuiteRunItem[];
}

export interface QfTrainRun {
  id: number;
  trainId: number;
  status: string;
  mode: QfMode;
  startedAt: string;
  finishedAt: string | null;
  error: unknown;
  suiteRuns: QfSuiteRun[];
}

export interface QfScreenshotRef {
  path: string;
  url: string;
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
  | { event: "started"; kind: "record" | "replay" | "browse" | "suite" | "train"; testId?: number; testName?: string; stepCount?: number; suiteId?: number; suiteName?: string; trainId?: number; trainName?: string }
  | { event: "record"; type: "milestones"; milestones: string[] }
  | { event: "record"; type: "plan"; turn: number; currentMilestone?: string; actions?: unknown[]; done?: boolean; hint?: string }
  | { event: "record"; type: "step"; turn: number; stepIndex: number; action: QfActionTrace[]; ok?: boolean; error?: string; url?: string; title?: string; screenshot?: string | null; thinking?: string | null; nextGoal?: string | null; memory?: string | null }
  | { event: "record"; type: "loading"; stepIndex?: number; url?: string; title?: string | null; screenshot?: string | null }
  | { event: "record"; type: "guard"; turn: number; reason?: string }
  | { event: "record"; type: "error"; turn: number; error?: string }
  | { event: "replay"; type: "step" | "done"; idx: number; status: "passed" | "failed" | "skipped"; intent: string; detail: Record<string, unknown>; healed?: string | null; success?: boolean; error?: string }
  | { event: "browse"; type: "step_start" | "action" | "guard" | "done"; step?: number; maxSteps?: number; thinking?: string; evaluation?: string; memory?: string; nextGoal?: string; actionIndex?: number; name?: string; params?: Record<string, unknown>; ok?: boolean; error?: string; message?: string; success?: boolean; text?: string; steps?: number; actions?: number; llmCalls?: number; errors?: string[] }
  | { event: "suite"; type: "step"; suiteRunId: number; testId: number; runId: number; idx: number; status: "passed" | "failed" | "skipped"; intent: string; detail: Record<string, unknown> }
  | { event: "suite"; type: "test-done"; suiteRunId: number; testId: number; runId: number; success: boolean; error?: string }
  | { event: "suite"; type: "suite-done"; suiteRunId: number; success: boolean; error?: string }
  | { event: "train"; type: "suite-start"; trainRunId: number; suiteRunId: number; suiteId: number; suiteName: string }
  | { event: "train"; type: "step"; trainRunId: number; suiteRunId: number; testId: number; runId: number; idx: number; status: "passed" | "failed" | "skipped"; intent: string; detail: Record<string, unknown> }
  | { event: "train"; type: "test-done"; trainRunId: number; suiteRunId: number; testId: number; runId: number; success: boolean; error?: string }
  | { event: "train"; type: "suite-done"; trainRunId: number; suiteRunId: number; success: boolean; error?: string }
  | { event: "train"; type: "done"; trainRunId: number; success: boolean; error?: string }
  | { event: "done"; ok: boolean; testId?: number; testName?: string; report?: unknown; runId?: number; error?: string; llmCalls?: number; selfHealed?: number; suiteRunId?: number; trainRunId?: number; status?: string }
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

// ----- suites & trains -------------------------------------------------------

export async function listSuites(): Promise<{ suites: QfSuite[] }> {
  return authedFetch<{ suites: QfSuite[] }>("/suites");
}

export interface QfSuiteMember {
  testId: number;
  parallel?: boolean;
}

export interface QfTrainMember {
  suiteId: number;
  parallel?: boolean;
}

export async function createSuite(request: { name: string; description?: string; mode?: QfMode; tests?: QfSuiteMember[] }): Promise<{ suite: QfSuite }> {
  return authedFetch<{ suite: QfSuite }>("/suites", { method: "POST", body: JSON.stringify(request) });
}

export async function deleteSuite(id: number): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>(`/suites/${id}`, { method: "DELETE" });
}

export async function updateSuiteTests(suiteId: number, tests: QfSuiteMember[]): Promise<{ suite: QfSuite }> {
  return authedFetch<{ suite: QfSuite }>(`/suites/${suiteId}/tests`, { method: "PUT", body: JSON.stringify({ tests }) });
}

export async function listSuiteRuns(suiteId: number): Promise<{ runs: QfRun[] }> {
  return authedFetch<{ runs: QfRun[] }>(`/suites/${suiteId}/runs`);
}

export async function getSuiteRun(id: number): Promise<{ suiteRun: QfSuiteRun }> {
  return authedFetch<{ suiteRun: QfSuiteRun }>(`/suite-runs/${id}`);
}

export async function listSuiteScreenshots(suiteRunId: number): Promise<{ screenshots: QfScreenshotRef[] }> {
  return authedFetch<{ screenshots: QfScreenshotRef[] }>(`/suite-runs/${suiteRunId}/screenshots`);
}

export function startSuiteRun(
  suiteId: number,
  callbacks: StreamCallbacks,
): Promise<void> {
  return streamPost(`/suites/${suiteId}/run`, {}, callbacks);
}

export async function listTrains(): Promise<{ trains: QfTrain[] }> {
  return authedFetch<{ trains: QfTrain[] }>("/trains");
}

export async function createTrain(request: { name: string; description?: string; mode?: QfMode; suites?: QfTrainMember[] }): Promise<{ train: QfTrain }> {
  return authedFetch<{ train: QfTrain }>("/trains", { method: "POST", body: JSON.stringify(request) });
}

export async function deleteTrain(id: number): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>(`/trains/${id}`, { method: "DELETE" });
}

export async function updateTrainSuites(trainId: number, suites: QfTrainMember[]): Promise<{ train: QfTrain }> {
  return authedFetch<{ train: QfTrain }>(`/trains/${trainId}/suites`, { method: "PUT", body: JSON.stringify({ suites }) });
}

export async function listTrainRuns(trainId: number): Promise<{ runs: QfRun[] }> {
  return authedFetch<{ runs: QfRun[] }>(`/trains/${trainId}/runs`);
}

export async function getTrainRun(id: number): Promise<{ trainRun: QfTrainRun }> {
  return authedFetch<{ trainRun: QfTrainRun }>(`/train-runs/${id}`);
}

export function startTrainRun(
  trainId: number,
  callbacks: StreamCallbacks,
): Promise<void> {
  return streamPost(`/trains/${trainId}/run`, {}, callbacks);
}
import { getSessionToken } from "@/lib/auth";

const API_BASE = "/api/fieldserve";

async function authedFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getSessionToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Types
export type JobStatus =
  | "created" | "scheduled" | "assigned" | "engineer-dispatched"
  | "en-route" | "on-site" | "checking-in" | "waiting-for-access"
  | "waiting-for-equipment" | "in-progress" | "on-hold"
  | "completed" | "failed" | "cancelled" | "deferred"
  | "facility-not-accessible" | "parts-required" | "requires-rescheduling";

export type Priority = "critical" | "high" | "medium" | "low";
export type EngineerStatus = "available" | "busy" | "on-leave";

export interface FieldServeJob {
  id: number;
  title: string;
  description: string | null;
  siteId: number;
  skillRequired: string;
  priority: Priority;
  status: JobStatus;
  assignedEngineerId: number | null;
  scheduledDate: string | null;
  estimatedDuration: number | null;
  slaDeadline: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FieldServeJobWithRelations extends FieldServeJob {
  site?: FieldServeSite;
  engineer?: FieldServeEngineer;
  updates?: FieldServeJobUpdate[];
  attachments?: FieldServeAttachment[];
}

export interface FieldServeEngineer {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  employeeId: string;
  skills: string[];
  status: EngineerStatus;
  currentLat: number | null;
  currentLng: number | null;
  createdAt: string;
  activeJob?: FieldServeJob;
}

export interface FieldServeSite {
  id: number;
  name: string;
  address: string;
  city: string;
  postcode: string;
  lat: number | null;
  lng: number | null;
  accessInstructions: string | null;
  contactName: string | null;
  contactPhone: string | null;
  createdAt: string;
}

export interface FieldServeJobUpdate {
  id: number;
  jobId: number;
  engineerId: number | null;
  fromStatus: string | null;
  toStatus: string;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: string;
}

export interface FieldServeAttachment {
  id: number;
  jobId: number;
  engineerId: number | null;
  fileName: string;
  fileType: string;
  fileSize: number;
  createdAt: string;
}

export interface DashboardStats {
  totalJobs: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  engineerUtilisation: { total: number; available: number; busy: number; onLeave: number };
  slaBreaches: number;
  avgCompletionTime: number | null;
}

export interface CreateJobInput {
  title: string;
  description?: string;
  siteId: number;
  skillRequired: string;
  priority?: Priority;
  scheduledDate?: string;
  estimatedDuration?: number;
  slaDeadline?: string;
}

// Jobs
export async function listJobs(filters?: {
  status?: string;
  engineerId?: number;
  siteId?: number;
  priority?: string;
  page?: number;
  limit?: number;
}): Promise<{ jobs: FieldServeJob[]; total: number }> {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.engineerId) params.set("engineer_id", String(filters.engineerId));
  if (filters?.siteId) params.set("site_id", String(filters.siteId));
  if (filters?.priority) params.set("priority", filters.priority);
  if (filters?.page !== undefined) params.set("page", String(filters.page));
  if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
  const qs = params.toString();
  return authedFetch(`/jobs${qs ? `?${qs}` : ""}`);
}

export async function getJob(id: number): Promise<{ job: FieldServeJobWithRelations }> {
  return authedFetch(`/jobs/${id}`);
}

export async function createJob(input: CreateJobInput): Promise<{ job: FieldServeJob }> {
  return authedFetch("/jobs", { method: "POST", body: JSON.stringify(input) });
}

export async function updateJob(id: number, input: Partial<CreateJobInput>): Promise<{ job: FieldServeJob }> {
  return authedFetch(`/jobs/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function deleteJob(id: number): Promise<{ ok: boolean }> {
  return authedFetch(`/jobs/${id}`, { method: "DELETE" });
}

// Transitions
export async function transitionJob(
  jobId: number,
  action: string,
  body?: Record<string, unknown>,
): Promise<{ job: FieldServeJob }> {
  return authedFetch(`/jobs/${jobId}/${action}`, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

// Engineers
export async function listEngineers(filters?: {
  skill?: string;
  status?: string;
  available?: boolean;
}): Promise<{ engineers: FieldServeEngineer[] }> {
  const params = new URLSearchParams();
  if (filters?.skill) params.set("skill", filters.skill);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.available) params.set("available", "true");
  const qs = params.toString();
  return authedFetch(`/engineers${qs ? `?${qs}` : ""}`);
}

export async function getEngineer(id: number): Promise<{ engineer: FieldServeEngineer }> {
  return authedFetch(`/engineers/${id}`);
}

export async function getEngineerHistory(id: number): Promise<{ history: FieldServeJob[] }> {
  return authedFetch(`/engineers/${id}/history`);
}

// Sites
export async function listSites(): Promise<{ sites: FieldServeSite[] }> {
  return authedFetch("/sites");
}

export async function getSite(id: number): Promise<{ site: FieldServeSite }> {
  return authedFetch(`/sites/${id}`);
}

// Job Updates
export async function listJobUpdates(jobId: number): Promise<{ updates: FieldServeJobUpdate[] }> {
  return authedFetch(`/jobs/${jobId}/updates`);
}

// Dashboard
export async function getDashboardStats(): Promise<{ stats: DashboardStats }> {
  return authedFetch("/dashboard/stats");
}

export async function getOverdueJobs(): Promise<{ jobs: FieldServeJob[] }> {
  return authedFetch("/dashboard/overdue");
}

// Seed / Reset
export async function seedData(): Promise<{ ok: boolean; message: string }> {
  return authedFetch("/seed", { method: "POST" });
}

export async function resetData(): Promise<{ ok: boolean; message: string }> {
  return authedFetch("/reset", { method: "POST" });
}

// Raw fetch for custom requests (used by test runner)
export async function rawApiFetch(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: Record<string, string>; body: string; duration: number }> {
  const token = await getSessionToken();
  const start = performance.now();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body || undefined,
  });
  const duration = Math.round(performance.now() - start);
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  const responseBody = await res.text();
  return { status: res.status, headers: responseHeaders, body: responseBody, duration };
}

// AI test generation
export async function generateTests(
  prompt: string,
  modelProvider?: string,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ testCases: unknown[] }> {
  const token = await getSessionToken();
  const res = await fetch(`${API_BASE}/ai/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ prompt, model_provider: modelProvider }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `HTTP ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let testCases: unknown[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "chunk" && onChunk) onChunk(parsed.content);
        if (parsed.type === "done") testCases = parsed.testCases ?? [];
        if (parsed.type === "error") throw new Error(parsed.message);
      } catch {
        // Skip malformed NDJSON lines
      }
    }
  }

  return { testCases };
}

// Recording
export interface RecordedSession {
  id: number;
  name: string;
  baseUrl: string;
  startedAt: string;
  endedAt: string | null;
  stepCount: number;
  apiSpec: string | null;
  apiSpecUrl: string | null;
}

export interface RecordedStep {
  id: number;
  sessionId: number;
  seq: number;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  durationMs: number;
  createdAt: string;
}

export async function startRecording(name: string, opts?: { baseUrl?: string; apiSpecUrl?: string }): Promise<{ ok: boolean; sessionId: number; apiSpecLoaded: boolean }> {
  return authedFetch("/record/start", {
    method: "POST",
    body: JSON.stringify({ name, baseUrl: opts?.baseUrl ?? "/api/fieldserve", apiSpecUrl: opts?.apiSpecUrl }),
  });
}

export async function stopRecording(): Promise<{ ok: boolean; session: RecordedSession }> {
  return authedFetch("/record/stop", { method: "POST" });
}

export async function getRecordingStatus(): Promise<{ recording: boolean; sessionId: number | null }> {
  return authedFetch("/record/status");
}

export async function listRecordedSessions(): Promise<{ ok: boolean; sessions: RecordedSession[] }> {
  return authedFetch("/record/sessions");
}

export async function getRecordedSession(
  id: number,
): Promise<{ ok: boolean; session: RecordedSession; steps: RecordedStep[] }> {
  return authedFetch(`/record/sessions/${id}`);
}

export async function deleteRecordedSession(id: number): Promise<{ ok: boolean }> {
  return authedFetch(`/record/sessions/${id}`, { method: "DELETE" });
}

export async function exportRecordedSessionCsv(id: number): Promise<void> {
  const token = await getSessionToken();
  const res = await fetch(`${API_BASE}/record/sessions/${id}/csv`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `recorded-${id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function generateTestsFromRecording(
  sessionId: number,
  opts?: { provider?: string; modelId?: string; scenario?: string; onChunk?: (chunk: string) => void; signal?: AbortSignal },
): Promise<{ testCases: unknown[] }> {
  const token = await getSessionToken();
  const res = await fetch(`${API_BASE}/record/sessions/${sessionId}/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      model_provider: opts?.provider,
      model_id: opts?.modelId,
      scenario: opts?.scenario,
    }),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `HTTP ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let testCases: unknown[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "chunk" && opts?.onChunk) opts.onChunk(parsed.content);
        if (parsed.type === "done") testCases = parsed.testCases ?? [];
        if (parsed.type === "error") throw new Error(parsed.message);
      } catch {
        // Skip malformed NDJSON lines
      }
    }
  }

  return { testCases };
}

export interface ReplayStep {
  seq: number;
  method: string;
  path: string;
  status: number;
  expectedStatus: number;
  pass: boolean;
  duration: number;
  error?: string;
  responseBody?: string;
}

export async function replayRecordedSession(
  sessionId: number,
  opts?: {
    baseUrl?: string;
    autoReset?: boolean;
    provider?: string;
    modelId?: string;
    onStep?: (step: ReplayStep) => void;
    onHealing?: (healing: { seq: number; fixes: string[] }) => void;
    signal?: AbortSignal;
  },
): Promise<{
  ok: boolean;
  results: ReplayStep[];
  summary: { total: number; passed: number; failed: number };
}> {
  const token = await getSessionToken();
  const res = await fetch(`${API_BASE}/record/sessions/${sessionId}/replay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ baseUrl: opts?.baseUrl, autoReset: opts?.autoReset, model_provider: opts?.provider, model_id: opts?.modelId }),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `HTTP ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let results: ReplayStep[] = [];
  let summary = { total: 0, passed: 0, failed: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "step" && opts?.onStep) {
          opts.onStep(parsed as ReplayStep);
        }
        if (parsed.type === "healing" && opts?.onHealing) {
          opts.onHealing({ seq: parsed.seq, fixes: parsed.fixes ?? [] });
        }
        if (parsed.type === "done") {
          results = parsed.results ?? [];
          summary = parsed.summary ?? { total: 0, passed: 0, failed: 0 };
        }
        if (parsed.type === "error") throw new Error(parsed.message);
      } catch {
        // Skip malformed NDJSON lines
      }
    }
  }

  // Flush remaining buffer (stream may end without trailing newline)
  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer.trim());
      if (parsed.type === "done") {
        results = parsed.results ?? [];
        summary = parsed.summary ?? { total: 0, passed: 0, failed: 0 };
      }
    } catch {
      // Ignore
    }
  }

  return { ok: true, results, summary };
}

// Autopilot: AI reads the natural-language scenario + API spec and drives the
// API calls itself. Each call is executed as a real HTTP round-trip (captured
// by the active recorder), so the resulting session is replayable.
export interface AutopilotStep {
  stepNumber: number;
  thinking: string;
  nextGoal: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  error?: string;
  done?: boolean;
  requestBody?: string | null;
  responseBody?: string | null;
}

export async function autopilotRecording(
  scenario: string,
  opts?: {
    baseUrl?: string;
    apiSpecUrl?: string;
    provider?: string;
    modelId?: string;
    maxSteps?: number;
    autoReset?: boolean;
    onThinking?: (chunk: string) => void;
    onStep?: (step: AutopilotStep) => void;
    signal?: AbortSignal;
  },
): Promise<{ ok: boolean; session: RecordedSession | null }> {
  const token = await getSessionToken();
  const res = await fetch(`${API_BASE}/record/autopilot`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      scenario,
      baseUrl: opts?.baseUrl,
      apiSpecUrl: opts?.apiSpecUrl,
      model_provider: opts?.provider,
      model_id: opts?.modelId,
      maxSteps: opts?.maxSteps,
      autoReset: opts?.autoReset,
    }),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `HTTP ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let session: RecordedSession | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "thinking" && opts?.onThinking) opts.onThinking(parsed.content);
        else if (parsed.type === "step" && opts?.onStep) opts.onStep(parsed as AutopilotStep);
        else if (parsed.type === "done") session = (parsed.session ?? null) as RecordedSession | null;
        else if (parsed.type === "error") throw new Error(parsed.message);
      } catch {
        // Skip malformed NDJSON lines
      }
    }
  }

  return { ok: true, session };
}

/**
 * Browser-Agent API Client
 * Communicates with the /api/browser-agent backend (no credits required).
 */

import { customFetch } from "@workspace/api-client-react";
import { getSessionToken } from "@/lib/auth";

const API_BASE = "/api/browser-agent";

// ============================================================
// Types
// ============================================================

export interface BrowserAgentRunRequest {
  url: string;
  goal: string;
  model_id?: string;
  model_provider?: string;
  assertions?: Array<{
    type: string;
    target?: string;
    expected?: string;
    pattern?: string;
    description?: string;
    selector?: string;
  }>;
  max_steps?: number;
  use_vision?: boolean;
  keep_alive?: boolean;
}

export interface UserApiKey {
  id: number;
  provider: string;
  keyHint: string;
  createdAt: string;
}

export interface BrowserAgentRunHistoryItem {
  id: string;
  url: string;
  goal: string;
  status: string;
  success: boolean | null;
  error: string | null;
  creditsUsed: number;
  modelUsed: string;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentModelOutput {
  thinking: string | null;
  evaluation_previous_goal: string | null;
  memory: string | null;
  next_goal: string | null;
  actions: Array<{
    name: string;
    raw: Record<string, unknown>;
  }>;
}

export interface AgentStepEvent {
  event: "step";
  step_number: number;
  screenshot: string | null;
  model_output: AgentModelOutput | null;
  url: string | null;
  title: string | null;
}

export interface AgentLoadingEvent {
  event: "loading";
  step_number: number;
  screenshot: string | null;
  model_output: AgentModelOutput | null;
  url: string | null;
  title: string | null;
}

export interface AgentDoneEvent {
  event: "done";
  success: boolean;
  message: string;
  duration?: number;
}

export interface AgentErrorEvent {
  event: "error";
  message: string;
}

export type AgentEvent = AgentStepEvent | AgentLoadingEvent | AgentDoneEvent | AgentErrorEvent;

export interface AgentRunStatus {
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  run_id: string | null;
  success?: boolean | null;
  error?: string | null;
}

// ============================================================
// API Functions
// ============================================================

/**
 * Get the auth token from localStorage.
 */
function getAuthToken(): string {
  return localStorage.getItem("auth_token") || "";
}

/**
 * Start a new browser-agent run with SSE streaming.
 */
export async function startBrowserAgentRun(
  request: BrowserAgentRunRequest,
  callbacks: {
    onEvent: (event: AgentEvent) => void;
    onError?: (error: Error) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const response = await fetch(`${API_BASE}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify(request),
    signal: callbacks.signal,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `HTTP ${response.status}`);
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
            const event: AgentEvent = JSON.parse(line.slice(6));
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

/**
 * Send a follow-up chat message to the running agent.
 */
export async function sendBrowserAgentChat(
  message: string,
  runId?: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify({ message, run_id: runId }),
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stop the current browser-agent run.
 */
export async function stopBrowserAgentRun(): Promise<void> {
  try {
    await fetch(`${API_BASE}/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
      },
    });
  } catch {
    // Ignore errors on stop
  }
}

/**
 * Get the current live screenshot.
 */
export async function getBrowserAgentScreenshot(
  runId?: string,
): Promise<{ screenshot: string | null }> {
  try {
    const url = runId
      ? `${API_BASE}/screenshot?run_id=${runId}`
      : `${API_BASE}/screenshot`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
      },
    });

    if (!response.ok) return { screenshot: null };
    return await response.json();
  } catch {
    return { screenshot: null };
  }
}

/**
 * Get the status of the current run.
 */
export async function getBrowserAgentStatus(): Promise<AgentRunStatus> {
  try {
    const response = await fetch(`${API_BASE}/status`, {
      headers: {
        Authorization: `Bearer ${getAuthToken()}`,
      },
    });

    if (!response.ok) {
      return { status: "idle", run_id: null };
    }

    return await response.json();
  } catch {
    return { status: "idle", run_id: null };
  }
}

/**
 * Get run history for the current user.
 */
export async function getBrowserAgentRunHistory(
  limit = 20,
): Promise<BrowserAgentRunHistoryItem[]> {
  try {
    const token = await getSessionToken();
    const response = await fetch(`${API_BASE}/runs?limit=${limit}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!response.ok) return [];
    const data = await response.json();
    return data.runs ?? [];
  } catch {
    return [];
  }
}

/**
 * Get the user's saved API keys.
 */
export async function getBrowserAgentApiKeys(): Promise<UserApiKey[]> {
  try {
    const res = await customFetch<{ keys: UserApiKey[] }>("/api/keys");
    return res.keys ?? [];
  } catch {
    return [];
  }
}

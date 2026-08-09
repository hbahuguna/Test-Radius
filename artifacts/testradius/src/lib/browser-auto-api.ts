import { customFetch } from "@workspace/api-client-react";
import { getSessionToken } from "@/lib/auth";

export interface BrowserAutoRequest {
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
  model_provider?: string;
  model?: string;
}

export interface BrowserAutoRunHistoryItem {
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

export interface CreditBalance {
  credits_remaining: number;
  credits_used: number;
  plan: string;
}

export interface UserApiKey {
  id: number;
  provider: string;
  keyHint: string;
  createdAt: string;
}

export interface StepEvent {
  step: number;
  action: string;
  target?: string;
  status: "running" | "done" | "error";
  detail?: string;
  thinking?: string;
  evaluation?: string;
  nextGoal?: string;
}

async function getAuthToken(): Promise<string | null> {
  try {
    const token = await getSessionToken();
    return token;
  } catch {
    return null;
  }
}

/**
 * Start a browser-auto run and stream NDJSON events.
 */
export async function streamBrowserAutoRun(
  request: BrowserAutoRequest,
  handlers: {
    onEvent: (event: Record<string, unknown>) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const token = await getAuthToken();
  const response = await fetch("/api/browser-auto/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(request),
    signal: handlers.signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const e: any = new Error(err.message || `Run failed (${response.status})`);
    e.code = err.error || null;
    throw e;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        handlers.onEvent(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  }
  if (buffer.trim()) {
    try {
      handlers.onEvent(JSON.parse(buffer.trim()));
    } catch {
      /* ignore */
    }
  }
}

export async function getBrowserAutoCreditBalance(): Promise<CreditBalance> {
  return customFetch<CreditBalance>("/api/browser-auto/credits");
}

export async function getBrowserAutoRunHistory(limit = 20): Promise<BrowserAutoRunHistoryItem[]> {
  const data = await customFetch<{ runs: BrowserAutoRunHistoryItem[] }>(`/api/browser-auto/runs?limit=${limit}`);
  return data.runs;
}

export async function stopBrowserAutoRun(): Promise<void> {
  await customFetch<{ stopped: boolean }>("/api/browser-auto/run/last/stop", { method: "POST" });
}

export interface Screenshot {
  screenshot: string;
}

export async function getBrowserAutoScreenshot(): Promise<Screenshot | null> {
  const token = await getAuthToken();
  try {
    const res = await fetch("/api/browser-auto/screenshot", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as Screenshot;
  } catch {
    return null;
  }
}

export async function getApiKeys(): Promise<UserApiKey[]> {
  const res = await customFetch<{ keys: UserApiKey[] }>("/api/keys");
  return res.keys ?? [];
}

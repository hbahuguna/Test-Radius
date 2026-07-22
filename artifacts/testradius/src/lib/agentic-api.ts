import { customFetch } from "@workspace/api-client-react";
import { getSessionToken } from "@/lib/auth";

export interface Assertion {
  type: "visibility" | "text" | "url";
  target?: string;
  expected?: string;
  pattern?: string;
  description?: string;
}

export interface RunRequest {
  url: string;
  goal: string;
  assertions?: Assertion[];
  headless?: boolean;
  max_turns?: number;
  mode?: "reactive" | "planned";
  model_provider?: string;
  model?: string;
}

export interface RunHistoryItem {
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

/**
 * Start an agentic run and stream NDJSON events via fetch + ReadableStream.
 */
export async function streamRun(
  request: RunRequest,
  handlers: {
    onEvent: (event: Record<string, unknown>) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const token = await getAuthToken();
  const response = await fetch("/api/tester/run", {
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

  // eslint-disable-next-line no-constant-condition
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

export async function getCreditBalance(): Promise<CreditBalance> {
  return customFetch<CreditBalance>("/api/tester/credits");
}

export interface CouponPreview {
  code: string;
  credits: number;
  description: string | null;
  expired: boolean;
}

/**
 * Preview a coupon's value before redeeming.
 */
export async function previewCoupon(code: string): Promise<CouponPreview> {
  return customFetch<CouponPreview>(`/api/tester/coupons/${encodeURIComponent(code.trim().toUpperCase())}`);
}

/**
 * Redeem a coupon code for the current user. Throws with code "insufficient_credits"
 * style errors (not_found, expired, already_redeemed, max_reached, inactive) so the
 * caller can surface a clear message.
 */
export async function redeemCoupon(code: string): Promise<{ ok: true; credits_granted: number }> {
  const token = await getSessionToken();
  const res = await fetch("/api/tester/coupons/redeem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e: any = new Error(err.message || "Failed to redeem coupon");
    e.code = err.error || "coupon_error";
    throw e;
  }
  return res.json();
}

/**
 * Spend 1 credit for a paid UI action (reason identifies it in the ledger).
 * Throws with code "insufficient_credits" when the user has no credits left
 * (caller should redirect to /pricing).
 */
export async function spendCredit(reason: string): Promise<CreditBalance> {
  const token = await getSessionToken();
  const res = await fetch("/api/tester/credits/spend", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 402) {
      const e: any = new Error("No credits remaining. Buy more to continue.");
      e.code = "insufficient_credits";
      throw e;
    }
    throw new Error(err.message || "Failed to spend credit");
  }
  return res.json();
}

export async function getRunHistory(limit = 20): Promise<RunHistoryItem[]> {
  const data = await customFetch<{ runs: RunHistoryItem[] }>(`/api/tester/runs?limit=${limit}`);
  return data.runs;
}

export async function stopRun(): Promise<void> {
  await customFetch<{ stopped: boolean }>("/api/tester/run/last/stop", { method: "POST" });
}

export interface Screenshot {
  screenshot: string;
}

export async function getScreenshot(): Promise<Screenshot | null> {
  const token = await getAuthToken();
  try {
    const res = await fetch("/api/tester/screenshot", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as Screenshot;
  } catch {
    return null;
  }
}

export async function getApiKeys(): Promise<UserApiKey[]> {
  const data = await customFetch<{ keys: UserApiKey[] }>("/api/keys");
  return data.keys;
}

export async function saveApiKey(provider: string, key: string): Promise<UserApiKey> {
  return customFetch<UserApiKey>("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider, key }),
  });
}

export async function deleteApiKey(id: number): Promise<void> {
  await customFetch<{ deleted: boolean }>(`/api/keys/${id}`, { method: "DELETE" });
}

export async function startCheckout(priceId: string): Promise<void> {
  const token = await getSessionToken();
  const res = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ priceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Checkout failed");
  }
  const { url } = await res.json();
  if (url) window.location.href = url;
}

export interface JiraImportResult {
  goal: string;
  url?: string;
  assertions?: Assertion[];
}

/**
 * Import a Jira ticket's acceptance criteria as a test goal. This is a paid
 * feature — the backend deducts a credit and returns the resolved ticket.
 */
export async function importJira(ticket: string): Promise<JiraImportResult> {
  const token = await getSessionToken();
  const res = await fetch("/api/tester/jira", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ ticket }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 402) throw new Error("Insufficient credits. Buy more to use Jira import.");
    throw new Error(err.message || "Failed to import Jira ticket");
  }
  return res.json();
}

export interface JiraSearchResult {
  key: string;
  summary: string;
  status: string;
  type: string;
}

/**
 * Search the user's connected Jira instance by summary, description, or other
 * text fields. Does not charge credits.
 */
export async function searchJira(query: string): Promise<JiraSearchResult[]> {
  const token = await getSessionToken();
  const res = await fetch("/api/tester/jira/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Failed to search Jira");
  }
  const data = await res.json();
  return data.results ?? [];
}

export interface JiraConnection {
  baseUrl: string;
  email: string;
  token: string;
}

/**
 * Save the user's Jira instance connection. Credentials are stored encrypted
 * server-side as a `jira` API key (JSON: baseUrl/email/token).
 */
export async function saveJiraConnection(conn: JiraConnection): Promise<UserApiKey> {
  const payload = JSON.stringify({
    baseUrl: conn.baseUrl.trim().replace(/\/$/, ""),
    email: conn.email.trim(),
    token: conn.token.trim(),
  });
  return saveApiKey("jira", payload);
}

// Token getter — resolves the current Supabase session token so SSE calls are
// authenticated. Mirrors the getter wired into the API client in auth.tsx.
async function getAuthToken(): Promise<string | null> {
  return getSessionToken();
}

// --- Inline chat ---

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  message: string;
  context: string;
  url?: string;
  model_provider?: string;
  model?: string;
}

/**
 * Stream a chat response from the agent, given the run context.
 */
export async function streamChat(
  request: ChatRequest,
  handlers: {
    onToken: (token: string) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const token = await getAuthToken();
  const response = await fetch("/api/tester/chat", {
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
    const e: any = new Error(err.message || `Chat failed (${response.status})`);
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
        const evt = JSON.parse(line);
        if (evt.event === "token" && typeof evt.text === "string") {
          handlers.onToken(evt.text);
        }
      } catch {
        // ignore malformed lines
      }
    }
  }
  if (buffer.trim()) {
    try {
      const evt = JSON.parse(buffer.trim());
      if (evt.event === "token" && typeof evt.text === "string") {
        handlers.onToken(evt.text);
      }
    } catch {}
  }
}

import { logger } from "../lib/logger";

const AGENT_URL = process.env.SDET_AGENT_URL || "http://localhost:8006";

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
  // BYOK model override keys (plaintext, passed through from decrypted vault)
  openai_api_key?: string;
  anthropic_api_key?: string;
  google_api_key?: string;
  opencode_api_key?: string;
  model_provider?: string;
  model?: string;
}

/**
 * Proxy an agentic run stream from the SDET agent. Returns the raw Response
 * so the caller can stream the NDJSON body back to the client.
 */
export async function proxyAgenticStream(body: AgenticRequestBody): Promise<Response> {
  const url = `${AGENT_URL}/v1/agentic-stream`;
  logger.info({ url, target: body.url }, "Proxying agentic run to SDET agent");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SDET agent error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

/**
 * Ask the SDET agent to stop the current run.
 */
export async function stopAgentRun(): Promise<void> {
  const url = `${AGENT_URL}/v1/agentic/stop`;
  await fetch(url, { method: "POST" }).catch((err) => {
    logger.warn({ err }, "Failed to signal agent stop");
  });
}

/**
 * Fetch a live screenshot from the SDET agent. The agent returns a raw
 * image/png response, so we read the bytes and base64-encode them.
 */
export async function getAgentScreenshot(): Promise<Buffer | null> {
  const url = `${AGENT_URL}/v1/agentic/screenshot`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json().catch(() => null)) as { screenshot?: string } | null;
    if (!data?.screenshot) return null;
    return Buffer.from(data.screenshot, "base64");
  }
  // Raw image/png (the agent's default response).
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return null;
  return buf;
}

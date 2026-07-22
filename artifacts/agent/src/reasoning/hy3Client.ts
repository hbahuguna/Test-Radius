/**
 * Client for the opencode/hy3-free model via the OpenCode Zen API
 * (OpenAI-compatible chat-completions endpoint). Auth via OPENCODE_API_KEY.
 */

import { ByokError, ByokAuthError, type StreamCallbacks } from "./byokClient.js";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const POOLSIDE_BASE_URL = "https://api.poolside.ai/v1";

export class Hy3Client {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(apiKey?: string, apiUrl?: string, model = "hy3-free") {
    // If poolside key is provided, use Poolside endpoint
    if (apiKey?.startsWith("sky_") || (!apiKey && process.env.POOLSIDE_API_KEY?.startsWith("sky_"))) {
      this.baseUrl = (apiUrl || process.env.POOLSIDE_ZEN_BASE_URL || POOLSIDE_BASE_URL).replace(/\/$/, "");
      this.model = "poolside/laguna-xs-2.1";
    } else {
      this.baseUrl = (apiUrl || process.env.OPENCODE_ZEN_BASE_URL || ZEN_DEFAULT_BASE_URL).replace(/\/$/, "");
      this.model = process.env.OPENCODE_MODEL || model;
    }
    this.apiKey = apiKey || process.env.POOLSIDE_API_KEY || process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey || ""}`,
      "Content-Type": "application/json",
    };
  }

  async infer(prompt: string, maxTokens = 1024, temperature = 0.3): Promise<string> {
    if (!this.apiKey) throw new ByokError("OPENCODE_API_KEY (or OPENCODE_ZEN_API_KEY) is not set.");
    const payload = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
      enable_thinking: false,
      stream: false,
    };
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new ByokAuthError(`OpenCode Zen rejected the API key (HTTP ${resp.status}).`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new ByokError(`Zen API returned HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const data: any = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content != null) return content as string;
    const reasoning = data?.choices?.[0]?.message?.reasoning;
    if (reasoning) return reasoning as string;
    throw new ByokError("Zen returned null content and null reasoning");
  }

  async streamInfer(
    prompt: string,
    cb: StreamCallbacks,
    maxTokens = 1024,
    temperature = 0.3,
    system?: string,
  ): Promise<string> {
    if (!this.apiKey) {
      cb.onDelta("reasoning", "[Hy3 error: OPENCODE_API_KEY is not set.]");
      throw new ByokError("OPENCODE_API_KEY (or OPENCODE_ZEN_API_KEY) is not set.");
    }
    try { const d = join(process.cwd(), "logs"); try { mkdirSync(d, { recursive: true }); } catch {} appendFileSync(join(d, "llm-debug.log"), `[${new Date().toISOString()}] Hy3.streamInfer key=${this.apiKey!.slice(0,8)}... model=${this.model} prompt_len=${prompt.length}\n`); } catch {}
    const messages = [{ role: "user", content: prompt }] as any[];
    if (system) messages.unshift({ role: "system", content: system });
    const payload = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      enable_thinking: false,
      stream: true,
    };
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (resp.status === 401 || resp.status === 403) {
      cb.onDelta("reasoning", `[Hy3 error: Zen rejected the API key (HTTP ${resp.status})]`);
      throw new ByokAuthError(`OpenCode Zen rejected the API key (HTTP ${resp.status}).`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      cb.onDelta("reasoning", `[Hy3 error: Zen API returned HTTP ${resp.status}: ${body.slice(0, 400)}]`);
      throw new ByokError(`Zen API returned HTTP ${resp.status}: ${body.slice(0, 400)}`);
    }
    if (!resp.body) throw new ByokError("Zen returned no stream body");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const full: string[] = [];
    let buffer = "";
    let chunkCount = 0;
    const rawChunks: string[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const chunk = line.slice(5).trim();
          if (!chunk || chunk === "[DONE]") continue;
          if (rawChunks.length < 5) rawChunks.push(chunk.slice(0, 300));
          let obj: any;
          try {
            obj = JSON.parse(chunk);
          } catch {
            continue;
          }
          chunkCount++;
          const delta = obj?.choices?.[0]?.delta ?? {};
          if (delta.reasoning) {
            cb.onDelta("reasoning", delta.reasoning);
            full.push(delta.reasoning);
          }
          if (delta.content) {
            cb.onDelta("content", delta.content);
            full.push(delta.content);
          }
        }
      }
    } catch (e: any) {
      if (e instanceof ByokAuthError || e instanceof ByokError) throw e;
      cb.onDelta("reasoning", `[Hy3 error: request to OpenCode Zen failed: ${e?.message ?? e}]`);
      throw new ByokError(`request to OpenCode Zen failed: ${e?.message ?? e}`);
    }
    const result = full.join("");
    const d = join(process.cwd(), "logs");
    try { mkdirSync(d, { recursive: true }); } catch {}
    appendFileSync(join(d, "llm-debug.log"),
      `[${new Date().toISOString()}] chunks=${chunkCount} result_len=${result.length} tail=${result.slice(-300)}\n` +
      rawChunks.map((c, i) => `  chunk[${i}]: ${c}\n`).join("")
    );
    return result;
  }

  health(): boolean {
    return Boolean(this.apiKey);
  }
}

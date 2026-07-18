/**
 * LLM factory: holds one or more LLM clients and picks a healthy one for
 * inference. Ports the Python sdet_agent.reasoning.llm_factory.
 *
 * In BYOK mode there is exactly one client; auth errors propagate so the
 * executor can abort the run instead of silently continuing.
 */

import { ByokClient, ByokAuthError, ByokError, type StreamCallbacks } from "./byokClient.js";
import { Hy3Client } from "./hy3Client.js";

export interface LlmClient {
  provider?: string;
  streamInfer: (
    prompt: string,
    cb: { onDelta: (kind: "reasoning" | "content", text: string) => void },
    maxTokens?: number,
    temperature?: number,
    system?: string,
  ) => Promise<string>;
  health: () => boolean;
}

const ERROR_PREFIXES = ["[Qwen error", "[Hy3 error", "[Byok error"];

function isErrorText(text: string): boolean {
  return ERROR_PREFIXES.some((p) => text.startsWith(p));
}

export interface LlmClientConfig {
  name: string;
  client: LlmClient;
}

export class LLMFactory {
  clients: LlmClientConfig[] = [];

  constructor(configs: LlmClientConfig[]) {
    for (const c of configs) {
      if (c.client.health && c.client.health()) {
        this.clients.push(c);
      }
    }
    if (this.clients.length === 0) {
      // eslint-disable-next-line no-console
      console.warn("[llm_factory] No LLM clients initialized.");
    }
  }

  async streamInfer(
    prompt: string,
    cb: StreamCallbacks,
    maxTokens = 1024,
    temperature = 0,
  ): Promise<[string | null, string]> {
    for (const { name, client } of this.clients) {
      if (client.health && !client.health()) continue;
      try {
        const full = await client.streamInfer(prompt, cb, maxTokens, temperature);
        if (full && !isErrorText(full)) return [name, full];
        // eslint-disable-next-line no-console
        console.warn(`[llm_factory] ${name} returned an error: ${full.slice(0, 120)}`);
      } catch (e) {
        if (e instanceof ByokAuthError || e instanceof ByokError) throw e;
        // eslint-disable-next-line no-console
        console.warn(`[llm_factory] ${name} stream failed: ${(e as Error)?.message}`);
      }
    }
    return [null, ""];
  }
}

/**
 * Build a BYOK factory from a provider->key map. `model` optionally overrides
 * the default model for the selected provider.
 */
export function buildByokFactory(byok: Record<string, string>, model?: string | null): LLMFactory {
  const configs: LlmClientConfig[] = [];
  for (const provider of ["openai", "anthropic", "google", "opencode"]) {
    const key = byok[provider];
    if (!key) continue;
    if (provider === "opencode") {
      configs.push({ name: "byok-opencode", client: new Hy3Client(key, undefined, model ?? undefined) });
    } else {
      configs.push({ name: `byok-${provider}`, client: new ByokClient(provider, key, model ?? undefined) });
    }
  }
  return new LLMFactory(configs);
}

/**
 * Default factory: uses the opencode/hy3-free model via OpenCode Zen. Used when
 * the user has not supplied a BYOK key.
 */
export function defaultFactory(): LLMFactory {
  return new LLMFactory([{ name: "hy3-free", client: new Hy3Client() }]);
}

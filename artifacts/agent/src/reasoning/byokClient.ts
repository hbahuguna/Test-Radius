/**
 * BYOK (bring-your-own-key) LLM clients for the TypeScript agent.
 *
 * Ports the Python sdet_agent.reasoning.byok_client / hy3_client. Routes to
 * the user's own provider using an OpenAI-compatible chat completions endpoint
 * for OpenAI / Anthropic / Google, and the OpenCode Zen API for "opencode".
 *
 * Crucially, auth/API errors RAISE (ByokAuthError / ByokError) instead of
 * returning error text — so a wrong key fails the run fast rather than being
 * mistaken for a valid model response.
 */

export class ByokError extends Error {}
export class ByokAuthError extends ByokError {}

const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
  google: "gemini-2.5-flash",
};

export interface StreamCallbacks {
  onDelta: (kind: "reasoning" | "content", text: string) => void;
}

export class ByokClient {
  readonly provider: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(provider: string, apiKey: string, model?: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.model = model || PROVIDER_DEFAULT_MODEL[provider] || "gpt-4o-mini";
    const base = PROVIDER_ENDPOINTS[provider];
    if (!base) throw new Error(`Unknown BYOK provider: ${provider}`);
    this.baseUrl = base.replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.provider === "anthropic") h["anthropic-version"] = "2023-06-01";
    return h;
  }

  async infer(prompt: string, maxTokens = 1024, temperature = 0.3): Promise<string> {
    if (!this.apiKey) throw new ByokError(`no API key for ${this.provider}`);
    const payload = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new ByokAuthError(
        `${this.provider} rejected the API key (HTTP ${resp.status}). Check the key in Settings.`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new ByokError(`${this.provider} API returned HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const data: any = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content == null) throw new ByokError(`${this.provider} returned null content`);
    return content as string;
  }

  async streamInfer(
    prompt: string,
    cb: StreamCallbacks,
    maxTokens = 1024,
    temperature = 0.3,
    system?: string,
  ): Promise<string> {
    if (!this.apiKey) {
      cb.onDelta("reasoning", `[Byok error: no API key for ${this.provider}]`);
      throw new ByokError(`no API key for ${this.provider}`);
    }
    const messages = [{ role: "user", content: prompt } as any];
    if (system) messages.unshift({ role: "system", content: system });
    const payload = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    };
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (resp.status === 401 || resp.status === 403) {
      cb.onDelta(
        "reasoning",
        `[Byok error: ${this.provider} rejected the API key (HTTP ${resp.status})]`,
      );
      throw new ByokAuthError(
        `${this.provider} rejected the API key (HTTP ${resp.status}). Check the key in Settings.`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      cb.onDelta("reasoning", `[Byok error: ${this.provider} API returned HTTP ${resp.status}: ${body.slice(0, 400)}]`);
      throw new ByokError(`${this.provider} API returned HTTP ${resp.status}: ${body.slice(0, 400)}`);
    }
    if (!resp.body) throw new ByokError(`${this.provider} returned no stream body`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const full: string[] = [];
    let buffer = "";
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
          let obj: any;
          try {
            obj = JSON.parse(chunk);
          } catch {
            continue;
          }
          const delta = obj?.choices?.[0]?.delta?.content;
          if (delta) {
            cb.onDelta("content", delta);
            full.push(delta);
          }
        }
      }
    } catch (e: any) {
      if (e instanceof ByokAuthError || e instanceof ByokError) throw e;
      cb.onDelta("reasoning", `[Byok error: request to ${this.provider} failed: ${e?.message ?? e}]`);
      throw new ByokError(`request to ${this.provider} failed: ${e?.message ?? e}`);
    }
    return full.join("");
  }

  health(): boolean {
    return Boolean(this.apiKey);
  }
}

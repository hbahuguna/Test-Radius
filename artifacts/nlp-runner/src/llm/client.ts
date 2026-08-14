/**
 * Injectable LLM client abstraction for the A11y LLM planner (Story QF-48).
 *
 * The planner depends only on `LLMClient`, so tests inject a mock that returns
 * scripted responses (every manual test plan for QF-49..QF-52 says "mock the
 * LLM"). The production `OpenAIChatClient` speaks any OpenAI-compatible
 * endpoint (configured via `LlmConfig`).
 *
 * Extended for the browser-use-style live agent (PLAN-live-agent.md, Phase 0):
 * multi-part content (text + image), structured `json_schema` output, native
 * tool calling, and SSE streaming. All changes are backwards compatible — the
 * old `string`-content `chat()` callers are unaffected.
 */

export type LLMRole = "system" | "user" | "assistant" | "tool";

export interface LLMTextPart {
  type: "text";
  text: string;
}

export interface LLMImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type LLMContentPart = LLMTextPart | LLMImagePart;

export interface LLMToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string. */
  arguments: string;
}

export interface LLMMessage {
  role: LLMRole;
  /** Plain text (backwards compatible) or structured content parts (vision). */
  content: string | LLMContentPart[];
  name?: string;
  /** Required for `tool` role messages (the tool call being answered). */
  toolCallId?: string;
  /** Assistant messages that produced tool calls must echo them back. */
  toolCalls?: LLMToolCall[];
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** JSON Schema (OpenAI subset) describing a callable tool's parameters. */
export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LLMResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: Record<string, unknown> };

export type LLMToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface LLMChatOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: LLMResponseFormat;
  tools?: LLMTool[];
  toolChoice?: LLMToolChoice;
}

export interface LLMResult {
  text: string;
  usage?: LLMUsage;
  finishReason?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMStreamEvent {
  /** Accumulated text delta for this chunk. */
  text: string;
  toolCalls?: LLMToolCall[];
  usage?: LLMUsage;
  finishReason?: string;
  /** True on the final chunk. */
  done: boolean;
}

export interface LLMClient {
  chat(messages: LLMMessage[], opts?: LLMChatOptions): Promise<LLMResult>;
}

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class LLMError extends Error {
  override name = "LLMError";
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

interface RawMessage {
  role: string;
  content: string | LLMContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

function serializeMessage(message: LLMMessage): RawMessage {
  const raw: RawMessage = { role: message.role, content: message.content };
  if (message.name !== undefined) raw.name = message.name;
  if (message.toolCallId !== undefined) raw.tool_call_id = message.toolCallId;
  if (message.toolCalls !== undefined) {
    raw.tool_calls = message.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return raw;
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export function parseToolCalls(raw: unknown): LLMToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls: LLMToolCall[] = [];
  for (const entry of raw as RawToolCall[]) {
    if (!entry?.function?.name) continue;
    calls.push({
      id: entry.id ?? "",
      name: entry.function.name,
      arguments: entry.function.arguments ?? "",
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function buildRequestBody(
  model: string,
  messages: LLMMessage[],
  opts: LLMChatOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map(serializeMessage),
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.stop) body.stop = opts.stop;
  if (opts.responseFormat) {
    if (opts.responseFormat.type === "json_object") {
      body.response_format = { type: "json_object" };
    } else {
      body.response_format = {
        type: "json_schema",
        json_schema: opts.responseFormat.json_schema,
      };
    }
  }
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
  return body;
}

interface RawChoice {
  message?: {
    content?: string | null;
    tool_calls?: unknown;
  };
  delta?: {
    content?: string | null;
    tool_calls?: unknown;
  };
  finish_reason?: string;
  usage?: unknown;
}

function parseUsage(raw: unknown): LLMUsage | undefined {
  if (!raw) return undefined;
  const u = raw as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  if (u.prompt_tokens === undefined) return undefined;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
  };
}

export class OpenAIChatClient implements LLMClient {
  constructor(private readonly config: OpenAIConfig) {}

  private buildUrl(): URL {
    const base = new URL(this.config.baseUrl);
    let path = base.pathname;
    while (path.endsWith("/")) path = path.slice(0, -1);
    base.pathname = path + "/chat/completions";
    return base;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: this.config.apiKey
        ? `Bearer ${this.config.apiKey}`
        : "",
    };
  }

  async chat(
    messages: LLMMessage[],
    opts: LLMChatOptions = {},
  ): Promise<LLMResult> {
    const res = await fetch(this.buildUrl().toString(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildRequestBody(this.config.model, messages, opts)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LLMError(
        `LLM request failed (${res.status} ${res.statusText}): ${body.slice(0, 300)}`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      choices?: RawChoice[];
      usage?: unknown;
    };
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    return {
      text,
      toolCalls: parseToolCalls(choice?.message?.tool_calls),
      finishReason: choice?.finish_reason,
      usage: parseUsage(data.usage),
    };
  }

  /**
   * Stream a chat completion over SSE. Each yielded event carries the text
   * delta produced in that chunk; the final event has `done: true` plus any
   * usage reported by the server. Providers that don't support streaming
   * throw `LLMError`.
   */
  async *stream(
    messages: LLMMessage[],
    opts: LLMChatOptions = {},
  ): AsyncIterable<LLMStreamEvent> {
    const res = await fetch(this.buildUrl().toString(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        ...buildRequestBody(this.config.model, messages, opts),
        stream: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LLMError(
        `LLM stream request failed (${res.status} ${res.statusText}): ${body.slice(0, 300)}`,
        res.status,
      );
    }
    if (!res.body) {
      throw new LLMError("LLM stream returned no body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: LLMUsage | undefined;
    let finishReason: string | undefined;
    const pendingCalls = new Map<string, { name: string; args: string }>();

    const flushToolCalls = (): LLMToolCall[] | undefined => {
      if (pendingCalls.size === 0) return undefined;
      const calls: LLMToolCall[] = [];
      for (const [id, fn] of pendingCalls) {
        calls.push({ id, name: fn.name, arguments: fn.args });
      }
      return calls;
    };

    const handleLine = (line: string): LLMStreamEvent | null => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return null;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        return {
          text: "",
          usage,
          finishReason,
          toolCalls: flushToolCalls(),
          done: true,
        };
      }
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        return null;
      }
      const jsonObj = json as { choices?: RawChoice[]; usage?: unknown };
      const usageRaw = jsonObj.usage;
      if (usageRaw) usage = parseUsage(usageRaw);
      const choice = jsonObj.choices?.[0];
      if (!choice) return null;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (choice.usage) usage = parseUsage(choice.usage);
      const delta = choice.delta;
      if (!delta) return null;
      const text = delta.content ?? "";
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const id = tc?.id;
          if (typeof id === "string" && id) {
            if (!pendingCalls.has(id)) pendingCalls.set(id, { name: "", args: "" });
          } else {
            // Streams often omit the id on continuation chunks; attribute to
            // the single in-flight call when there is exactly one.
            if (pendingCalls.size === 1) {
              const only = pendingCalls.values().next().value;
              if (only) {
                if (typeof tc?.function?.name === "string") only.name += tc.function.name;
                if (typeof tc?.function?.arguments === "string") only.args += tc.function.arguments;
              }
            }
            return { text, toolCalls: flushToolCalls(), done: false };
          }
          const entry = pendingCalls.get(id);
          if (entry) {
            if (typeof tc?.function?.name === "string") entry.name += tc.function.name;
            if (typeof tc?.function?.arguments === "string") entry.args += tc.function.arguments;
          }
        }
      }
      return { text, toolCalls: flushToolCalls(), done: false };
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const event = handleLine(line);
          if (event) yield event;
        }
      }
      if (buffer) {
        const event = handleLine(buffer);
        if (event) yield event;
      }
      yield { text: "", usage, finishReason, toolCalls: flushToolCalls(), done: true };
    } finally {
      reader.releaseLock();
    }
  }
}

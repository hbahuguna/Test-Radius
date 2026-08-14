import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LLMError,
  OpenAIChatClient,
  parseToolCalls,
  type LLMMessage,
} from "./client.js";
import { modelForRole, clientForRole } from "./roles.js";

let server: Server;
let baseUrl = "";
let lastBody: Record<string, unknown> | undefined;

function startServer(handler: (reqBody: unknown) => { status: number; body: unknown }): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        const { status, body } = handler(JSON.parse(raw || "{}"));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}/v1`;
      }
      resolve();
    });
  });
}

beforeEach(() => {
  baseUrl = "";
  lastBody = undefined;
});

afterEach(() => {
  if (server) server.close();
});

describe("OpenAIChatClient", () => {
  it("posts a plain-string message and reads the reply", async () => {
    await startServer((body) => ({
      status: 200,
      body: {
        choices: [{ message: { content: "hello back" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    }));
    const client = new OpenAIChatClient({ baseUrl, apiKey: "k", model: "m1" });
    const res = await client.chat([{ role: "user", content: "hi" }]);
    expect(res.text).toBe("hello back");
    expect(res.finishReason).toBe("stop");
    expect(res.usage?.totalTokens).toBe(7);
    expect(lastBody).toMatchObject({ model: "m1", messages: [{ role: "user", content: "hi" }] });
  });

  it("serializes image parts, tool messages, and assistant tool_calls", async () => {
    await startServer(() => ({ status: 200, body: { choices: [{ message: { content: "ok" } }] } }));
    const client = new OpenAIChatClient({ baseUrl, apiKey: "k", model: "m" });
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "navigate", arguments: "{\"url\":\"x\"}" }],
      },
      { role: "tool", content: "ok", toolCallId: "call_1" },
    ];
    await client.chat(messages);
    const sent = lastBody?.messages as unknown[];
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
    expect(sent[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "navigate", arguments: "{\"url\":\"x\"}" },
        },
      ],
    });
    expect(sent[2]).toEqual({ role: "tool", content: "ok", tool_call_id: "call_1" });
  });

  it("sends json_schema response_format, tools, and tool_choice", async () => {
    await startServer(() => ({ status: 200, body: { choices: [{ message: { content: "{}" } }] } }));
    const client = new OpenAIChatClient({ baseUrl, apiKey: "k", model: "m" });
    await client.chat([{ role: "user", content: "go" }], {
      responseFormat: { type: "json_schema", json_schema: { name: "out", strict: true } },
      tools: [{ name: "click", description: "click an element", parameters: { type: "object" } }],
      toolChoice: "required",
    });
    expect(lastBody?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "out", strict: true },
    });
    expect(lastBody?.tools).toHaveLength(1);
    expect(lastBody?.tool_choice).toBe("required");
  });

  it("parses tool_calls from the reply", async () => {
    await startServer(() => ({
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_9",
                  type: "function",
                  function: { name: "click", arguments: '{"index": 3}' },
                },
              ],
            },
          },
        ],
      },
    }));
    const client = new OpenAIChatClient({ baseUrl, apiKey: "k", model: "m" });
    const res = await client.chat([{ role: "user", content: "do it" }]);
    expect(res.toolCalls?.[0]).toEqual({
      id: "call_9",
      name: "click",
      arguments: '{"index": 3}',
    });
  });

  it("streams SSE deltas into events", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":" "}}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    await startServer(() => ({ status: 200, body: chunks }));
    const client = new OpenAIChatClient({ baseUrl, apiKey: "k", model: "m" });
    const events = [];
    for await (const ev of client.stream([{ role: "user", content: "s" }])) {
      events.push(ev);
    }
    const text = events.map((e) => e.text).join("");
    expect(text).toBe("Hello ");
    const last = events[events.length - 1];
    expect(last.done).toBe(true);
    expect(last.usage?.totalTokens).toBe(3);
    expect(last.finishReason).toBe("stop");
  });

  it("throws LLMError on non-OK status", async () => {
    await startServer(() => ({ status: 429, body: { error: "rate limited" } }));
    const client = new OpenAIChatClient({ baseUrl, apiKey: "k", model: "m" });
    await expect(client.chat([{ role: "user", content: "x" }])).rejects.toThrow(LLMError);
  });
});

describe("parseToolCalls", () => {
  it("maps raw tool_calls to LLMToolCall", () => {
    expect(
      parseToolCalls([
        { id: "a", type: "function", function: { name: "done", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "click", arguments: "" } },
      ]),
    ).toEqual([
      { id: "a", name: "done", arguments: "{}" },
      { id: "b", name: "click", arguments: "" },
    ]);
  });

  it("returns undefined for non-array or empty input", () => {
    expect(parseToolCalls(null)).toBeUndefined();
    expect(parseToolCalls([])).toBeUndefined();
  });
});

describe("role model selection", () => {
  const config = {
    provider: "openai-compatible",
    baseUrl: "http://x",
    apiKey: "k",
    model: "base",
    agentModel: "agent-vision",
    plannerModel: "planner-fast",
  };

  it("selects role models and falls back to the main model", () => {
    expect(modelForRole(config, "agent")).toBe("agent-vision");
    expect(modelForRole(config, "planner")).toBe("planner-fast");
    const minimal = { provider: "p", baseUrl: "b", apiKey: "", model: "m" };
    expect(modelForRole(minimal, "agent")).toBe("m");
    expect(modelForRole(minimal, "planner")).toBe("m");
  });

  it("clientForRole builds a client with the role model", () => {
    const client = clientForRole(config, "agent");
    expect(client).toBeInstanceOf(OpenAIChatClient);
  });
});

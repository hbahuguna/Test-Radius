import { describe, expect, it, vi } from "vitest";
import type { LLMChatOptions, LLMClient, LLMMessage, LLMResult } from "../llm/client.js";
import type { Page } from "../browser/session.js";
import { LiveAgent, type LiveAgentOptions } from "./agent.js";
import type { DomEntry } from "./dom-snapshot.js";
import { registerBuiltins } from "./actions.js";
import { ActionRegistry } from "./registry.js";

/** LLM that replays a queue of JSON response strings. */
class FakeLLM implements LLMClient {
  queue: string[] = [];
  calls = 0;
  received: LLMMessage[][] = [];
  constructor(responses: string[]) {
    this.queue = [...responses];
  }
  async chat(messages: LLMMessage[], _opts?: LLMChatOptions): Promise<LLMResult> {
    this.calls += 1;
    this.received.push(messages);
    const text = this.queue.shift() ?? '{"action":[]}';
    return { text };
  }
}

/** Minimal page double sufficient for captureDomSnapshot + multiAct. */
class FakePage {
  targetId: string;
  url: string;
  steps: DomEntry[][] = [[]];
  private i = 0;
  clicks: string[] = [];
  fills: { selector: string; text: string }[] = [];
  constructor(targetId: string, url = "about:blank", steps?: DomEntry[][]) {
    this.targetId = targetId;
    this.url = url;
    if (steps) this.steps = steps;
  }
  async getUrl(): Promise<string> {
    return this.url;
  }
  async navigate(u: string): Promise<{ url: string }> {
    this.url = u;
    return { url: u };
  }
  async evaluate<T = unknown>(fn: unknown, ..._args: unknown[]): Promise<T> {
    // () => document.title -> just return a string; string expr -> undefined.
    return (typeof fn === "function" ? ("eval-ok" as unknown) : (undefined as unknown)) as T;
  }
  async evaluateWithCommandLine<T = unknown>(_fn: unknown, ..._args: unknown[]): Promise<T> {
    const entries = this.steps[this.i % this.steps.length] ?? [];
    this.i += 1;
    return entries as unknown as T;
  }
  async screenshot(): Promise<string> {
    return "";
  }
  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }
  async fill(selector: string, text: string): Promise<void> {
    this.fills.push({ selector, text });
  }
  async scroll(_selector: string): Promise<void> {}
  async waitFor(): Promise<unknown> {
    return true;
  }
  async send(_method: string, _params?: unknown): Promise<unknown> {
    return {};
  }
}

/** Minimal session double: manages a pool of FakePages. */
class FakeSession {
  pool: FakePage[] = [];
  seq = 0;
  /** Per-new-page scripted DOM entries (defaults to empty pages). */
  pageSteps?: DomEntry[][];
  newPage(url = "about:blank"): FakePage {
    const p = new FakePage(`t${this.seq++}`, url, this.pageSteps);
    this.pool.push(p);
    return p;
  }
  attachPage(targetId: string): FakePage {
    return this.pool.find((p) => p.targetId === targetId) ?? this.pool[0];
  }
  pages(): { targetId: string; url: string; title: string }[] {
    return this.pool.map((p) => ({ targetId: p.targetId, url: p.url, title: "eval-ok" }));
  }
  get client(): { send: (m: string, p?: unknown) => Promise<unknown> } {
    return {
      send: async (method: string, params?: unknown) => {
        if (method === "Target.closeTarget") {
          const { targetId } = params as { targetId: string };
          this.pool = this.pool.filter((p) => p.targetId !== targetId);
        }
        return {};
      },
    };
  }
}

function makeAgent(session: FakeSession, llm: FakeLLM, opts: Partial<LiveAgentOptions> = {}) {
  const registry = new ActionRegistry();
  registerBuiltins((a) => registry.register(a));
  return new LiveAgent({
    session: session as unknown as LiveAgentOptions["session"],
    llm,
    registry,
    maxSteps: 10,
    maxActionsPerStep: 3,
    maxFailures: 3,
    useVision: false,
    ...opts,
  });
}

function json(action: object[], rest: Record<string, unknown> = {}): string {
  return JSON.stringify({
    evaluation_previous_goal: "ok",
    memory: "m",
    next_goal: "g",
    action,
    ...rest,
  });
}

describe("LiveAgent.browse", () => {
  it("runs navigate → done(success) and terminates happy path", async () => {
    const session = new FakeSession();
    const llm = new FakeLLM([
      json([{ navigate: { url: "https://example.test/" } }]),
      json([{ done: { success: true, text: "all done" } }]),
    ]);
    const agent = makeAgent(session, llm);
    const result = await agent.browse("go to example and finish");
    expect(result.success).toBe(true);
    expect(result.finalText).toBe("all done");
    expect(result.urls).toContain("https://example.test/");
    expect(result.actions).toBe(2);
    expect(result.llmCalls).toBe(2);
  });

  it("synthesizes a failed done when the model returns an empty action", async () => {
    const session = new FakeSession();
    const llm = new FakeLLM([json([]), json([{ done: { success: true, text: "ok" } }])]);
    const agent = makeAgent(session, llm);
    const result = await agent.browse("do something");
    // First response is empty -> synthetic done(false) terminates immediately.
    expect(result.success).toBe(false);
    expect(result.finalText).toContain("No next action");
    expect(result.llmCalls).toBe(1);
  });

  it("retries once on unparseable JSON then recovers", async () => {
    const session = new FakeSession();
    const llm = new FakeLLM([
      "not json at all",
      json([{ done: { success: true, text: "recovered" } }]),
    ]);
    const agent = makeAgent(session, llm);
    const result = await agent.browse("do something");
    expect(result.success).toBe(true);
    expect(result.llmCalls).toBe(2);
  });

  it("force-terminates with done(false) after max_failures", async () => {
    const session = new FakeSession();
    // click index 1 will never resolve (empty selectorMap) -> error each step.
    const llm = new FakeLLM([
      json([{ click: { index: 1 } }]),
      json([{ click: { index: 1 } }]),
      json([{ click: { index: 1 } }]),
      json([{ done: { success: true, text: "ok" } }]),
    ]);
    const agent = makeAgent(session, llm, { maxFailures: 2, maxSteps: 6 });
    const result = await agent.browse("keep failing");
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // The forced-done path terminates without consuming the last scripted response.
    expect(result.steps).toBeLessThanOrEqual(6);
  });

it("click + input_text resolve through the snapshot selector map", async () => {
    const session = new FakeSession();
    session.pageSteps = [[
      { depth: 0, tag: "input", attrs: "type=text", text: null, ref: "#email", interactive: true, scrollable: false },
      { depth: 0, tag: "button", attrs: "type=submit", text: null, ref: "#go", interactive: true, scrollable: false },
    ]];
    const llm = new FakeLLM([
      json([
        { input_text: { index: 1, text: "hello@example.test" } },
        { click: { index: 2 } },
        { done: { success: true, text: "submitted" } },
      ]),
      json([{ done: { success: true, text: "ok" } }]),
    ]);
    const agent = makeAgent(session, llm);
    const result = await agent.browse("fill and submit");
    const page = session.pool[0];
    expect(page.fills).toEqual([{ selector: "#email", text: "hello@example.test" }]);
    expect(page.clicks).toEqual(["#go"]);
    // done is not allowed as a non-single action -> dropped; the run continues,
    // the next step's done(success) terminates the task.
    expect(result.success).toBe(true);
  });
});
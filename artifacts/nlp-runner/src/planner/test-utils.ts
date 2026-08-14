/**
 * Test doubles for planner unit tests (Story QF-48).
 *
 * `MockLLMClient` replays scripted responses and records every message it
 * receives so tests can assert on the prompt. `MockDriver` records the steps
 * the agent executes, serves scripted snapshots/seververity signatures, and
 * captures saveTest invocations — no headless Chrome needed.
 */
import type { LLMClient, LLMMessage, LLMResult } from "../llm/client.js";
import type { RecordingDriver } from "./agent.js";
import type { RecordedStep, RecordedSlot } from "../recorder/recorder.js";
import type { SnapshotPayload, SnapshotElement } from "./snapshot.js";
export type { SnapshotElement };
import type { DataStore, SaveTestResult } from "../cache/queries.js";
import { hashSteps } from "../recorder/recorder.js";
import type { NewStep } from "../cache/types.js";

export class MockLLMClient implements LLMClient {
  public readonly calls: { messages: LLMMessage[]; result: LLMResult }[] = [];
  private readonly scripted: LLMResult[];

  private readonly fallback: LLMResult;

  constructor(responses: Array<string | LLMResult>) {
    this.scripted = responses.map((r) => (typeof r === "string" ? { text: r } : r));
    this.fallback = this.scripted[this.scripted.length - 1] ?? { text: "" };
  }

  async chat(messages: LLMMessage[]): Promise<LLMResult> {
    const result = this.scripted.shift() ?? this.fallback;
    this.calls.push({ messages, result });
    return result;
  }

  get prompts(): string[] {
    return this.calls.map((c) => c.messages.map((m) => m.content).join("\n\n"));
  }

  getCall(n: number): string {
    return this.calls[n]?.messages.map((m) => m.content).join("\n\n") ?? "";
  }
}

export interface MockDriverOptions {
  snapshots: SnapshotPayload[];
  signatures: string[];
  signaturesByIndex?: boolean;
  /** When supplied, saveTest persists the recorded flow to this store. */
  store?: DataStore;
  entryUrl?: string;
}

export class MockDriver implements RecordingDriver {
  readonly steps: RecordedStep[] = [];
  readonly slots: RecordedSlot[] = [];
  readonly saved: Array<{
    name: string;
    opts: { query?: string | null; normalizedQuery?: string | null; description?: string | null; extraSlots?: RecordedSlot[] };
    persisted: boolean;
  }> = [];
  private readonly store?: DataStore;
  private readonly entryUrlValue: string;
  private snapIdx = 0;
  private sigIdx = 0;
  readonly snapshotCalls: number[] = [];
  readonly signatureCalls: number[] = [];

  nextError: { action: string; msg: string } | null = null;

  constructor(private readonly opts: MockDriverOptions) {
    this.store = opts.store;
    this.entryUrlValue = opts.entryUrl ?? opts.snapshots[0]?.url ?? "about:blank";
  }

  snapshot(): Promise<SnapshotPayload> {
    const s = this.opts.snapshots[Math.min(this.snapIdx, this.opts.snapshots.length - 1)];
    this.snapshotCalls.push(this.snapIdx);
    this.snapIdx++;
    return Promise.resolve(s);
  }

  signature(): Promise<string> {
    const arr = this.opts.signatures;
    const s = this.opts.signaturesByIndex
      ? arr[Math.min(this.sigIdx, arr.length - 1)]
      : arr[0];
    this.signatureCalls.push(this.sigIdx);
    this.sigIdx++;
    return Promise.resolve(s);
  }

  navigate(url: string): Promise<void> {
    this._maybeFail("navigate", "navigator");
    return this._step("navigate", url);
  }
  click(selector: string): Promise<void> {
    this._maybeFail("click", selector);
    return this._step("click", selector);
  }
  fill(selector: string, value: string): Promise<void> {
    this._maybeFail("fill", `${selector}="${value}"`);
    return this._step("fill", `${selector}="${value}"`);
  }
  select(selector: string, value: string): Promise<void> {
    return this._step("select", `${selector}=>${value}`);
  }
  scroll(_selector?: string): Promise<void> {
    return this._step("scroll", _selector ?? "");
  }
  assertVisible(selector: string): Promise<void> {
    return this._step("assert", `visible:${selector}`);
  }
  assertText(selector: string, expected: string): Promise<void> {
    return this._step("assert", `text=${expected} @${selector}`);
  }
  assertUrl(contains: string): Promise<void> {
    return this._step("assert", `url~${contains}`);
  }
  extract(selector: string, name: string): Promise<string | undefined> {
    return Promise.resolve(`extracted:${name}`);
  }
  wait(_ms?: number): Promise<void> {
    return Promise.resolve();
  }

  saveTest(
    name: string,
    opts: { query?: string | null; normalizedQuery?: string | null; description?: string | null; extraSlots?: RecordedSlot[] },
  ): Promise<SaveTestResult> {
    const persisted = !!this.store;
    if (this.store) {
      const result = this.store.saveTest({
        name,
        source: "recorder" as const,
        entryUrl: this.entryUrlValue,
        stepHash: hashSteps(this.steps),
        query: opts.query ?? null,
        normalizedQuery: opts.normalizedQuery ?? null,
        queryEmbedding: null,
        description: opts.description ?? null,
        steps: this.steps.map((s) => ({
          action: s.action,
          selector: s.selector,
          value: s.value,
          locators: s.locators,
          elementFingerprint: s.elementFingerprint,
          pageSignatureBefore: s.pageSignatureBefore,
          pageSignatureAfter: s.pageSignatureAfter,
          waitCondition: s.waitCondition,
          assertion: s.assertion,
        })) as NewStep[],
        slots: [...this.slots, ...(opts.extraSlots ?? [])],
      });
      this.saved.push({ name, opts, persisted });
      return Promise.resolve({ id: result.id, created: result.created });
    }
    this.saved.push({ name, opts, persisted });
    return Promise.resolve({ id: this.saved.length, created: true });
  }

  getSteps(): RecordedStep[] {
    return this.steps;
  }
  getSlots(): RecordedSlot[] {
    return this.slots;
  }

  private _maybeFail(action: string, context: string): void {
    if (this.nextError && this.nextError.action === action) {
      const msg = this.nextError.msg;
      this.nextError = null;
      throw new Error(`${action} failed (${context}): ${msg}`);
    }
  }

  private _step(action: string, detail: string): Promise<void> {
    this.steps.push({
      action: action as RecordedStep["action"],
      selector: detail,
      value: null,
      locators: [],
      elementFingerprint: null,
      pageSignatureBefore: "s0",
      pageSignatureAfter: "s1",
      waitCondition: null,
      assertion: null,
    });
    return Promise.resolve();
  }

  static elts(...nodes: Array<{ role: string; name: string; ref: string }>): SnapshotElement[] {
    return nodes.map((n, i) => ({ index: i + 1, role: n.role, name: n.name, ref: n.ref }));
  }

  static page(elements: Array<{ role: string; name: string; ref: string }>, url = "https://example.com", title = "Example") {
    return { url, title, elements: MockDriver.elts(...elements) } as SnapshotPayload;
  }
}

/**
 * Smart mock LLM that parses the current snapshot out of the prompt it receives
 * and derives a plan from the *elements* (matched by their stable CSS `ref`,
 * e.g. a data-testid selector) — so tests don't hard-code fragile 1-based
 * indices. Used by the real-browser integration test.
 */
export class SmartMockLLM implements LLMClient {
  readonly calls: string[] = [];
  constructor(
    private readonly plan: (
      elements: Array<{ index: number; role: string; name: string; ref: string }>,
      prompt: string,
    ) => string | LLMResult,
  ) {}

  async chat(messages: LLMMessage[]): Promise<LLMResult> {
    const prompt = messages.map((m) => m.content).join("\n\n");
    const elements = parseCurrentElements(prompt);
    const out = this.plan(elements, prompt);
    this.calls.push(prompt);
    return typeof out === "string" ? { text: out } : out;
  }
}

const ELEMENT_LINE = /^(\d+): \[([^\]]*)\] "([^"]*)" \(ref=(.*)\)$/gm;

export function parseCurrentElements(
  prompt: string,
): Array<{ index: number; role: string; name: string; ref: string }> {
  const start = prompt.indexOf("Current page:");
  const section = start === -1 ? prompt : prompt.slice(start);
  const elements: Array<{ index: number; role: string; name: string; ref: string }> = [];
  for (const m of section.matchAll(ELEMENT_LINE)) {
    elements.push({
      index: Number(m[1]),
      role: m[2],
      name: m[3],
      ref: m[4],
    });
  }
  return elements;
}

export function findByRef(
  elements: Array<{ index: number; ref: string }>,
  testid: string,
): number | undefined {
  return elements.find((e) => e.ref.includes(testid))?.index;
}

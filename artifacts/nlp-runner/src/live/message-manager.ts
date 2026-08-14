/**
 * Message manager (PLAN-live-agent.md Phase 3) — port of browser-use
 * `agent/message_manager/service.py` + `AgentMessagePrompt.get_user_message`.
 *
 * Each step produces ONE user message: the full state (user_request →
 * agent_history → browser_state → read_state → page_specific_actions →
 * step_info), with the agent history embedded as a summarized event stream.
 * Keeping a single state message (rather than replaying every prior assistant
 * turn) keeps the token budget flat across long runs — the history block is the
 * authoritative record of what happened.
 */
import type { LLMClient, LLMMessage } from "../llm/client.js";
import type { ActionResult } from "./types.js";
import type {
  AgentOutput,
  AgentStepInfo,
  HistoryItem,
  MessageCompactionSettings,
} from "./views.js";
import { DEFAULT_COMPACTION } from "./views.js";

export interface BrowserStateInput {
  url: string;
  title: string;
  domText: string;
  tabs: { tabId: string; url: string; title: string }[];
  /** base64 PNG, or null when vision is off. */
  screenshot: string | null;
}

export interface MessageManagerOptions {
  maxHistoryItems?: number;
  compaction?: MessageCompactionSettings;
}

export class MessageManager {
  task: string;
  readonly systemPrompt: string;
  readonly maxHistoryItems: number | null;
  readonly compaction: MessageCompactionSettings;
  private history: HistoryItem[] = [];
  private compactedMemory: string | null = null;
  private lastCompactionStep = 0;
  /** Nudges/context messages appended to the next state message. */
  private contextMessages: string[] = [];
  private screenshots: string[] = [];
  private lastStateMessageText: string | null = null;

  constructor(task: string, systemPrompt: string, opts: MessageManagerOptions = {}) {
    this.task = task;
    this.systemPrompt = systemPrompt;
    this.maxHistoryItems = opts.maxHistoryItems ?? null;
    this.compaction = opts.compaction ?? DEFAULT_COMPACTION;
    if (this.maxHistoryItems !== null && this.maxHistoryItems <= 5) {
      throw new Error("maxHistoryItems must be null or greater than 5");
    }
  }

  get historyItems(): HistoryItem[] {
    return this.history;
  }

  get compactedMemoryView(): string | null {
    return this.compactedMemory;
  }

  /** Add a one-shot context message (budget warning, loop nudge, force-done) to the next state message. */
  addContextMessage(text: string): void {
    this.contextMessages.push(text);
  }

  /** Record a completed step into the history. */
  addHistoryItem(item: HistoryItem): void {
    this.history.push(item);
  }

  /** Summarize older history into a compact memory block; returns true if it ran. */
  async maybeCompact(llm: LLMClient | undefined, stepInfo: AgentStepInfo): Promise<boolean> {
    const settings = this.compaction;
    if (!settings.enabled || !llm) return false;
    const stepsSince = stepInfo.stepNumber - this.lastCompactionStep;
    if (stepsSince < settings.compactEveryNSteps) return false;

    const fullText = this.history.map((i) => historyItemToString(i)).join("\n").trim();
    if (fullText.length < settings.triggerCharCount) return false;

    const sections: string[] = [];
    if (this.compactedMemory) {
      sections.push(`<previous_compacted_memory>\n${this.compactedMemory}\n</previous_compacted_memory>`);
    }
    sections.push(`<agent_history>\n${fullText}\n</agent_history>`);
    const input = sections.join("\n\n");

    const systemPrompt = [
      "You are summarizing an agent run for prompt compaction.",
      "Capture task requirements, key facts, decisions, partial progress, errors, and next steps.",
      "Preserve important entities, values, and URLs.",
      "CRITICAL: Only mark a step as completed if you see explicit success confirmation. Otherwise mark it IN-PROGRESS.",
      "Return plain text only.",
      settings.summaryMaxChars ? `Keep under ${settings.summaryMaxChars} characters if possible.` : "",
    ]
      .filter(Boolean)
      .join("\n");

    let summary: string | null = null;
    try {
      const res = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: input },
        ],
        { temperature: 0 },
      );
      summary = res.text.trim() || null;
    } catch {
      return false;
    }
    if (!summary) return false;

    this.compactedMemory = summary;
    this.history = this.history.slice(-settings.keepLastItems);
    this.lastCompactionStep = stepInfo.stepNumber;
    this.contextMessages = [];
    return true;
  }

  /** Build the LLM messages for the next step: [system, user(state)]. */
  buildMessages(state: {
    browser: BrowserStateInput;
    actionsDescription: string;
    readState: string | null;
    stepInfo: AgentStepInfo;
    useVision: boolean;
  }): LLMMessage[] {
    const text = this.buildStateMessage(state);
    this.lastStateMessageText = text;
    const userMessage: LLMMessage = { role: "user", content: text };
    if (state.useVision && state.browser.screenshot) {
      userMessage.content = [
        { type: "text", text },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${state.browser.screenshot}` },
        },
      ];
    }
    return [{ role: "system", content: this.systemPrompt }, userMessage];
  }

  /** Pure-string state message (testable without an LLM). */
  buildStateMessage(state: {
    browser: BrowserStateInput;
    actionsDescription: string;
    readState: string | null;
    stepInfo: AgentStepInfo;
  }): string {
    const out: string[] = [];
    out.push(`<user_request>\n${this.task}\n</user_request>\n`);
    out.push(`<agent_history>\n${this.agentHistoryDescription()}\n</agent_history>\n`);
    out.push(`<browser_state>\n${this.browserStateDescription(state.browser)}\n</browser_state>\n`);
    const readState = state.readState?.trim();
    if (readState) out.push(`<read_state>\n${readState}\n</read_state>\n`);
    out.push(`<page_specific_actions>\n${state.actionsDescription}\n</page_specific_actions>\n`);
    if (this.contextMessages.length > 0) {
      out.push(this.contextMessages.join("\n\n") + "\n");
      this.contextMessages = [];
    }
    out.push(this.stepMetaDescription(state.stepInfo));
    return out.join("\n");
  }

  private agentHistoryDescription(): string {
    const prefix = this.compactedMemory
      ? `<compacted_memory>\n<!-- Summary of prior steps; treat as unverified — do not report as completed unless confirmed this session. -->\n${this.compactedMemory}\n</compacted_memory>\n`
      : "";
    if (this.maxHistoryItems === null) {
      return prefix + this.history.map((i) => historyItemToString(i)).join("\n");
    }
    const total = this.history.length;
    if (total <= this.maxHistoryItems) {
      return prefix + this.history.map((i) => historyItemToString(i)).join("\n");
    }
    const omitted = total - this.maxHistoryItems;
    const recent = this.maxHistoryItems - 1;
    const items = [
      historyItemToString(this.history[0]),
      `<sys>[... ${omitted} previous steps omitted...]</sys>`,
      ...this.history.slice(-recent).map((i) => historyItemToString(i)),
    ];
    return prefix + items.join("\n");
  }

  private browserStateDescription(b: BrowserStateInput): string {
    const lines: string[] = [];
    lines.push(`Current URL: ${b.url}`);
    lines.push("Available tabs:");
    for (const t of b.tabs) {
      lines.push(`Tab ${t.tabId}: ${t.url} - ${b.title.slice(0, 30)}`);
    }
    lines.push("");
    lines.push(b.domText || "empty page");
    return lines.join("\n");
  }

  private stepMetaDescription(stepInfo: AgentStepInfo): string {
    const step = `Step${stepInfo.stepNumber + 1} maximum:${stepInfo.maxSteps}`;
    const today = new Date().toISOString().slice(0, 10);
    return `<step_info>${step}\nToday:${today}</step_info>\n`;
  }

  get lastStateMessage(): string | null {
    return this.lastStateMessageText;
  }
}

/** Render a history item in the browser-use `<step_N>` event-stream format. */
export function historyItemToString(item: HistoryItem): string {
  const lines: string[] = [];
  lines.push(`<step_{${item.step}}>:`);
  lines.push(`Evaluation of Previous Step: ${item.evaluationPreviousGoal}`);
  lines.push(`Memory: ${item.memory}`);
  lines.push(`Next Goal: ${item.nextGoal}`);
  lines.push("Action Results:");
  if (item.actionResults.length === 0) {
    lines.push("  (none)");
  } else {
    for (const r of item.actionResults) {
      lines.push(`  - ${describeActionResult(r)}`);
    }
  }
  lines.push(`</step_{${item.step}}>:`);
  return lines.join("\n");
}

function describeActionResult(r: ActionResult): string {
  if (r.isDone) {
    return `done(${r.success ? "success" : "failure"}): ${r.extractedContent ?? ""}`;
  }
  if (r.error) return `error: ${r.error}`;
  if (r.extractedContent) return `ok: ${r.extractedContent}`;
  return "ok";
}

/** Build a history item from the model output + action results. */
export function makeHistoryItem(
  step: number,
  output: AgentOutput,
  results: ActionResult[],
): HistoryItem {
  return {
    step,
    evaluationPreviousGoal: output.evaluation_previous_goal ?? "",
    memory: output.memory ?? "",
    nextGoal: output.next_goal ?? "",
    actionResults: results,
  };
}
/**
 * LiveAgent (PLAN-live-agent.md Phase 3) — port of browser-use
 * `agent/service.py` (`step`, `run`, `multi_act`) driving the action
 * registry with `json_schema` structured output. Implements `LiveContext`
 * so the registered actions can resolve DOM indexes and manage tabs.
 */
import type { LLMChatOptions, LLMClient } from "../llm/client.js";
import type { BrowserSession, Page } from "../browser/session.js";
import type { ActionCall, ActionResult, LiveContext, LiveTab } from "./types.js";
import { ActionRegistry } from "./registry.js";
import { validateParams, toJsonSchema } from "./schema.js";
import { registerBuiltins } from "./actions.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  ActionLoopDetector,
} from "./loop-detector.js";
import {
  MessageManager,
  makeHistoryItem,
} from "./message-manager.js";
import { captureDomSnapshot, type DomSnapshot } from "./dom-snapshot.js";
import type {
  AgentOutput,
  AgentStepInfo,
  BrowseAgentEvent,
  BrowseResult,
  MessageCompactionSettings,
  ParsedAction,
} from "./views.js";
import { DEFAULT_COMPACTION } from "./views.js";

export interface LiveAgentOptions {
  session: BrowserSession;
  llm: LLMClient;
  registry?: ActionRegistry;
  maxSteps?: number;
  maxActionsPerStep?: number;
  maxFailures?: number;
  useVision?: boolean;
  maxHistoryItems?: number;
  compaction?: MessageCompactionSettings;
  systemPromptOverride?: string;
  /** Random/seed initial tab URL. */
  initialUrl?: string;
  /** Streaming callback for real-time progress events. */
  onEvent?: (event: BrowseAgentEvent) => void;
}

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_MAX_ACTIONS = 3;
const DEFAULT_MAX_FAILURES = 5;
const LLM_MAX_TOKENS = 2000;

export class LiveAgent implements LiveContext {
  readonly browserSession: BrowserSession;
  readonly llm: LLMClient;
  readonly registry: ActionRegistry;
  readonly maxSteps: number;
  readonly maxActionsPerStep: number;
  readonly maxFailures: number;
  readonly useVision: boolean;
  readonly messages: MessageManager;
  readonly loopDetector = new ActionLoopDetector();

  /** The currently focused page (last opened/switched/navigated tab). */
  currentPage!: Page;
  /** The focused page, exposed to actions via `LiveContext.page`. */
  get page(): Page {
    return this.currentPage;
  }
  /** Selector map from the most recent snapshot (index → CSS selector). */
  private selectorMap = new Map<number, string>();

  private nSteps = 0;
  private consecutiveFailures = 0;
  private lastModelOutput: AgentOutput | null = null;
  private lastResult: ActionResult[] | null = null;
  /** One-shot read state from the previous step's extract/evaluate. */
  private readState: string | null = null;
  private lastSnapshot: DomSnapshot | null = null;

  private visitedUrls: string[] = [];
  private screenshots: string[] = [];
  private actionCount = 0;
  private errors: string[] = [];
  private llmCalls = 0;
  private doneResult: { success: boolean; text: string } | null = null;
  private readonly onEvent?: (event: BrowseAgentEvent) => void;

  constructor(opts: LiveAgentOptions) {
    this.browserSession = opts.session;
    this.llm = opts.llm;
    this.registry = opts.registry ?? new ActionRegistry();
    if (opts.registry == null) registerBuiltins((a) => this.registry.register(a));
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxActionsPerStep = opts.maxActionsPerStep ?? DEFAULT_MAX_ACTIONS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.useVision = opts.useVision ?? false;
    const sys = opts.systemPromptOverride ?? buildSystemPrompt(this.maxActionsPerStep);
    this.messages = new MessageManager("", sys, {
      maxHistoryItems: opts.maxHistoryItems,
      compaction: opts.compaction ?? DEFAULT_COMPACTION,
    });
    this.onEvent = opts.onEvent;
  }

  resolveSelector(index: number): string {
    const sel = this.selectorMap.get(index);
    if (!sel) throw new Error(`no interactive element at index ${index} in the current browser state`);
    return sel;
  }

  async openTab(url?: string): Promise<void> {
    const page = await this.browserSession.newPage(url ?? "about:blank");
    this.currentPage = page;
    if (url && url !== "about:blank") await page.navigate(url).catch(() => {});
  }

  async switchTab(tabId: string): Promise<void> {
    const tabs = await this.browserSession.pages();
    const match = tabs.find((t) => t.targetId.slice(-4) === tabId);
    if (!match) throw new Error(`no tab with id "${tabId}"`);
    const page = await this.browserSession.attachPage(match.targetId);
    await page.send("Page.bringToFront").catch(() => {});
    this.currentPage = page;
  }

  async closeTab(tabId: string): Promise<void> {
    const tabs = await this.browserSession.pages();
    const match = tabs.find((t) => t.targetId.slice(-4) === tabId);
    if (!match) throw new Error(`no tab with id "${tabId}"`);
    await this.browserSession.client.send("Target.closeTarget", { targetId: match.targetId });
    if (this.currentPage?.targetId === match.targetId) {
      const remaining = (await this.browserSession.pages())[0];
      if (remaining) this.currentPage = await this.browserSession.attachPage(remaining.targetId);
    }
  }

  async listTabs(): Promise<LiveTab[]> {
    const tabs = await this.browserSession.pages();
    return tabs.map((t) => ({ tabId: t.targetId.slice(-4), url: t.url, title: t.title }));
  }

  /** Run the task loop. Returns the final browse result. */
  async browse(task: string): Promise<BrowseResult> {
    this.messages.task = task;
    const start = Date.now();
    this.currentPage = await this.browserSession.newPage("about:blank");

    while (this.nSteps < this.maxSteps) {
      if (this.consecutiveFailures >= this.maxFailures + 1) {
        this.errors.push(`stopped: ${this.maxFailures} consecutive failures`);
        break;
      }
      const stepInfo: AgentStepInfo = { stepNumber: this.nSteps, maxSteps: this.maxSteps };

      // Step 1: capture state + add previous history item.
      if (this.lastModelOutput && this.lastResult) {
        this.messages.addHistoryItem(
          makeHistoryItem(this.nSteps, this.lastModelOutput, this.lastResult),
        );
      }

      let snapshot: DomSnapshot;
      try {
        snapshot = await this.captureState();
      } catch (e) {
        this.errors.push(`state capture failed: ${(e as Error).message}`);
        this.consecutiveFailures += 1;
        this.nSteps += 1;
        continue;
      }
      this.lastSnapshot = snapshot;
      this.visitedUrls.push(snapshot.url);

      this.loopDetector.recordPageState(
        snapshot.url,
        snapshot.text,
        snapshot.selectorMap.size,
      );

      // Step 2: nudges (budget, loop, force-done).
      this.injectBudgetWarning(stepInfo);
      const nudge = this.loopDetector.getNudgeMessage();
      if (nudge) {
        this.messages.addContextMessage(nudge);
        this.onEvent?.({ type: "guard", step: this.nSteps, message: nudge });
      }

      const lastStep = stepInfo.stepNumber + 1 >= stepInfo.maxSteps;
      const forceDone = lastStep || this.consecutiveFailures >= this.maxFailures;
      if (forceDone) this.injectForceDone(this.consecutiveFailures >= this.maxFailures);

      // Step 3: build messages + call LLM.
      const actionsDescription = this.registry.getPromptDescription(snapshot.url);
      const llmMessages = this.messages.buildMessages({
        browser: {
          url: snapshot.url,
          title: snapshot.title,
          domText: snapshot.text,
          tabs: await this.listTabs(),
          screenshot: this.useVision ? (snapshot.screenshot ?? null) : null,
        },
        actionsDescription,
        readState: this.consumeReadState(),
        stepInfo,
        useVision: this.useVision,
      });

      let output: AgentOutput;
      try {
        output = await this.getAgentOutput(llmMessages);
      } catch (e) {
        this.errors.push(`llm step ${this.nSteps + 1} failed: ${(e as Error).message}`);
        this.consecutiveFailures += 1;
        this.nSteps += 1;
        continue;
      }
      this.lastModelOutput = output;

      this.onEvent?.({
        type: "step_start",
        step: this.nSteps,
        maxSteps: this.maxSteps,
        thinking: output.thinking,
        evaluation: output.evaluation_previous_goal,
        memory: output.memory,
        nextGoal: output.next_goal,
      });

      // Step 4: execute actions.
      let results: ActionResult[];
      try {
        results = await this.multiAct(output.action);
      } catch (e) {
        results = [{ isDone: false, error: `${(e as Error).name}: ${(e as Error).message}` }];
      }
      this.lastResult = results;
      this.actionCount += output.action.length;
      this.recordReadState(results);

      for (let ai = 0; ai < output.action.length && ai < results.length; ai++) {
        const r = results[ai];
        const call = output.action[ai];
        this.onEvent?.({
          type: "action",
          step: this.nSteps,
          actionIndex: ai,
          name: call.name,
          params: call.params,
          ok: !r.error,
          error: r.error,
        });
        if (r.isDone) break;
      }

      // Step 5: loop detection + failure accounting.
      this.loopDetector.recordActions(output.action);
      const singleError = results.length === 1 && results[0].error;
      if (singleError) {
        this.consecutiveFailures += 1;
        this.errors.push(`step ${this.nSteps + 1}: ${results[0].error}`);
      } else if (this.consecutiveFailures > 0) {
        this.consecutiveFailures = 0;
      }

      // Step 6: termination.
      const done = results.find((r) => r.isDone);
      if (done) {
        this.doneResult = {
          success: done.success !== false,
          text: done.extractedContent ?? "",
        };
        break;
      }

      this.nSteps += 1;
    }

    const durationMs = Date.now() - start;
    const success = this.doneResult?.success ?? false;
    const finalText = this.doneResult?.text ?? (this.errors[0] ?? "agent did not call done");
    const browseResult: BrowseResult = {
      success,
      finalText,
      steps: this.nSteps + (this.doneResult ? 1 : 0),
      actions: this.actionCount,
      urls: dedupe(this.visitedUrls),
      screenshots: this.screenshots,
      durationMs,
      llmCalls: this.llmCalls,
      errors: this.errors,
    };
    this.onEvent?.({
      type: "done",
      success: browseResult.success,
      text: browseResult.finalText,
      steps: browseResult.steps,
      actions: browseResult.actions,
      llmCalls: browseResult.llmCalls,
      errors: browseResult.errors,
    });
    return browseResult;
  }

  private async captureState(): Promise<DomSnapshot> {
    const previous = this.lastSnapshot ?? undefined;
    const snap = await captureDomSnapshot(this.currentPage, {
      screenshot: this.useVision,
      previous,
    });
    this.selectorMap = snap.selectorMap;
    if (this.useVision && snap.screenshot) this.screenshots.push(snap.screenshot);
    return snap;
  }

  private consumeReadState(): string | null {
    const r = this.readState;
    this.readState = null;
    return r;
  }

  private recordReadState(results: ActionResult[]): void {
    const parts = results
      .filter((r) => r.extractedContent && r.includeExtractedContentOnlyOnce)
      .map((r) => r.extractedContent as string);
    this.readState = parts.length > 0 ? parts.join("\n\n") : null;
    // Persist images returned by the screenshot action so they survive the step.
    for (const r of results) {
      if (r.images) for (const img of r.images) this.screenshots.push(img.data);
    }
  }

  private injectBudgetWarning(stepInfo: AgentStepInfo): void {
    const stepsUsed = stepInfo.stepNumber + 1;
    const ratio = stepsUsed / stepInfo.maxSteps;
    if (ratio >= 0.75 && stepsUsed < stepInfo.maxSteps) {
      const remaining = stepInfo.maxSteps - stepsUsed;
      const pct = Math.floor(ratio * 100);
      this.messages.addContextMessage(
        `BUDGET WARNING: You have used ${stepsUsed}/${stepInfo.maxSteps} steps (${pct}%). ${remaining} steps remaining. If the task cannot be completed in the remaining steps, prioritize the highest-value items and call done with what you have.`,
      );
    }
  }

  private injectForceDone(afterFailure: boolean): void {
    const reason = afterFailure
      ? `You failed ${this.maxFailures} times. We terminate the agent.`
      : "You reached max_steps - this is your last step.";
    this.messages.addContextMessage(
      `${reason} Your only available tool is the "done" tool — all other tools are not available. If the task is not fully finished, set success in "done" to false. Include everything you found in the done text.`,
    );
  }

  /** Call the LLM with the AgentOutput json_schema and parse/validate the result (one retry on bad output). */
  private async getAgentOutput(messages: Parameters<LLMClient["chat"]>[0]): Promise<AgentOutput> {
    const opts: LLMChatOptions = {
      temperature: 0,
      maxTokens: LLM_MAX_TOKENS,
      responseFormat: { type: "json_schema", json_schema: { name: "AgentOutput", schema: this.agentOutputSchema(), strict: false } },
    };
    this.llmCalls += 1;
    let res = await this.llm.chat(messages, opts);
    let parsed = this.parseOutput(res.text);

    if (!parsed) {
      // Retry once with a clarification.
      this.llmCalls += 1;
      const retry: typeof messages = [
        ...messages,
        {
          role: "user",
          content:
            "You forgot to return a valid action. Respond with a valid JSON object matching the expected schema, including your assessment and a non-empty action array.",
        },
      ];
      res = await this.llm.chat(retry, opts);
      parsed = this.parseOutput(res.text);
    }
    if (!parsed) {
      // Synthetic done so the run terminates cleanly.
      return {
        thinking: "No valid action returned by the LLM.",
        evaluation_previous_goal: "uncertain",
        memory: "LLM returned no parseable action.",
        next_goal: "terminate",
        action: [{ name: "done", params: { success: false, text: "No next action returned by the LLM." } }],
      };
    }
    if (parsed.action.length === 0) {
      // Empty action -> synthetic done (browser-use parity).
      parsed.action = [{ name: "done", params: { success: false, text: "No next action returned by the LLM!" } }];
    }
    // When forced to done, drop any non-done actions the model emitted.
    if (this.consecutiveFailures >= this.maxFailures || this.nSteps + 1 >= this.maxSteps) {
      parsed.action = [{ name: "done", params: { success: false, text: parsed.memory ?? "terminated" } }];
    }
    return parsed;
  }

  /** Parse + normalize + validate the model's JSON text. Returns null on hard failure. */
  private parseOutput(text: string): AgentOutput | null {
    const obj = parseJsonObject(text);
    if (!obj || typeof obj !== "object") return null;
    const rawAction = (obj as { action?: unknown }).action;
    if (!Array.isArray(rawAction)) return null;
    const actions: ParsedAction[] = [];
    for (const item of rawAction) {
      if (!item || typeof item !== "object") return null;
      const keys = Object.keys(item as object);
      if (keys.length !== 1) return null;
      const name = keys[0];
      const params = (item as Record<string, unknown>)[name];
      if (!params || typeof params !== "object") return null;
      const valid = validateParams(this.registry.get(name)?.params ?? { type: "object", properties: {} }, params as Record<string, unknown>);
      if (!valid.ok) return null;
      actions.push({ name, params: params as Record<string, unknown> });
    }
    if (actions.length > this.maxActionsPerStep) actions.length = this.maxActionsPerStep;
    return {
      thinking: stringOrUndef((obj as { thinking?: unknown }).thinking),
      evaluation_previous_goal: stringOrUndef((obj as { evaluation_previous_goal?: unknown }).evaluation_previous_goal),
      memory: stringOrUndef((obj as { memory?: unknown }).memory),
      next_goal: stringOrUndef((obj as { next_goal?: unknown }).next_goal),
      action: actions,
    };
  }

  /** Build the AgentOutput JSON Schema from the registry's actions. */
  private agentOutputSchema(): Record<string, unknown> {
    const actions = this.registry.list();
    const actionObjects = actions.map((a) => ({
      type: "object",
      properties: { [a.name]: toJsonSchema(a.params) },
      required: [a.name],
      additionalProperties: false,
    }));
    return {
      type: "object",
      properties: {
        thinking: { type: "string" },
        evaluation_previous_goal: { type: "string" },
        memory: { type: "string" },
        next_goal: { type: "string" },
        action: {
          type: "array",
          minItems: 1,
          maxItems: this.maxActionsPerStep,
          items: { oneOf: actionObjects },
        },
      },
      required: ["evaluation_previous_goal", "memory", "next_goal", "action"],
      additionalProperties: false,
    };
  }

  /** Execute a batch of actions with page-change guards (browser-use `multi_act`). */
  async multiAct(actions: ActionCall[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (let i = 0; i < actions.length; i++) {
      const call = actions[i];
      const action = this.registry.get(call.name);
      if (!action) {
        results.push({ isDone: false, error: `unknown action "${call.name}"` });
        return results;
      }
      if (i > 0 && call.name === "done") {
        results.push({ isDone: false, error: "done is allowed only as a single action" });
        break;
      }
      const preUrl = await this.currentPage.getUrl().catch(() => "");
      const preFocus = this.currentPage.targetId;
      try {
        const r = await action.execute(this, call.params);
        results.push(r);
      } catch (e) {
        results.push({ isDone: false, error: `${(e as Error).name}: ${(e as Error).message}` });
        return results;
      }
      if (r_isLast(results, i, actions)) break;
      if (action.terminatesSequence) break;
      const postUrl = await this.currentPage.getUrl().catch(() => preUrl);
      const postFocus = this.currentPage.targetId;
      if (postUrl !== preUrl || postFocus !== preFocus) break;
    }
    return results;
  }
}

function r_isLast(results: ActionResult[], i: number, actions: ActionCall[]): boolean {
  const last = results[results.length - 1];
  return !!last.isDone || !!last.error || i === actions.length - 1;
}

function parseJsonObject(text: string): unknown | null {
  const t = text.trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    return null;
  }
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
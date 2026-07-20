/**
 * Agentic executor (TypeScript port). Runs a goal-driven browser test:
 * plan -> act -> observe, streaming structured events. Faithful to the
 * contract the Test-Radius api-server / frontend consume:
 *   thinking_delta, content_delta, tool_call, tool_result, node, done, error
 * The `done` event carries { success, trace:{ assertions }, generated_code }.
 */

import { LLMFactory, buildByokFactory, defaultFactory } from "./reasoning/llmFactory.js";
import { ByokAuthError, ByokError } from "./reasoning/byokClient.js";
import * as bt from "./tools/browserTools.js";

export type EventSink = (event: string, data: Record<string, any>) => void;

export interface AgenticRunOptions {
  goal: string;
  url: string;
  assertions?: Array<Record<string, any>>;
  headless?: boolean;
  maxTurns?: number;
  byok?: Record<string, string> | null;
  model?: string | null;
}

export interface RunResult {
  success: boolean;
  trace: { goal: string; url: string; assertions?: unknown };
  generatedCode?: string | null;
  error?: string | null;
  stopped?: boolean;
}

let stopRequested = false;
export function requestStop(): void {
  stopRequested = true;
}
export function clearStop(): void {
  stopRequested = false;
}

interface PlanStep {
  action: string;
  target?: string;
  value?: string;
  thought?: string;
}

function stripCodeFences(text: string): string {
  const m = text.match(/```(?:ts|typescript|js|javascript)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : text.trim();
}

function extractJsonArray(text: string): PlanStep[] {
  // Grab the first balanced JSON array.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (Array.isArray(arr)) return arr as PlanStep[];
  } catch {
    /* ignore */
  }
  return [];
}

export class AgenticExecutor {
  llm: LLMFactory;
  private readonly isByok: boolean;

  constructor(opts: { byok?: Record<string, string> | null; model?: string | null } = {}) {
    if (opts.byok && Object.keys(opts.byok).length) {
      this.llm = buildByokFactory(opts.byok, opts.model);
      this.isByok = true;
    } else {
      this.llm = defaultFactory();
      this.isByok = false;
    }
  }

  private async validateByok(): Promise<void> {
    const [name, out] = await this.llm.streamInfer(
      "Reply with the single word: OK",
      { onDelta: () => {} },
      8,
      0,
    );
    if (!name) throw new ByokError("BYOK key did not produce a response.");
  }

  async run(
    opts: AgenticRunOptions,
    emit: EventSink,
  ): Promise<RunResult> {
    const { goal, url, assertions = [], headless = true, maxTurns = 30 } = opts;
    const trace = { goal, url, assertions };
    clearStop();

    if (this.isByok) {
      try {
        await this.validateByok();
      } catch (e: any) {
        const msg = e instanceof ByokAuthError || e instanceof ByokError
          ? e.message
          : `Provider error: ${e?.message ?? e}`;
        emit("error", { message: msg });
        emit("done", { success: false, error: msg, trace });
        return { success: false, trace, error: msg };
      }
    }

    emit("node", { node_id: "agentic", role: "agent", name: "agentic-execute" });
    const start = await bt.browserStart(headless);
    if (start.status === "error") {
      emit("error", { message: start.error });
      emit("done", { success: false, error: start.error, trace });
      return { success: false, trace, error: start.error };
    }

    const nav = await bt.browserNavigate(url);
    if (!nav.ok) {
      emit("error", { message: nav.error });
      emit("done", { success: false, error: nav.error, trace });
      return { success: false, trace, error: nav.error };
    }

    let generatedCode: string | null = null;
    let success = false;

    try {
      // Many sites show an intercepting modal/pop-up on load (Booking, etc.).
      // Dismiss it up front, THEN snapshot, so the planner sees the real page
      // and element refs are accurate (not the dismissed overlay's controls).
      if (await bt.hasOverlay()) {
        emit("thinking_delta", { text: "Detected an overlay/dialog; dismissing it before proceeding." });
        const d = await bt.browserDismissOverlay();
        if (d.dismissed) emit("tool_call", { name: "dismiss", arguments: {} });
      }

      const snap = await bt.browserSnapshot();
      const elements = snap.interactive_elements ?? [];

      const plan = await this.planBatch(goal, assertions, nav.url || url, elements, emit);
      if (plan.length === 0) {
        emit("thinking_delta", { text: "No actionable steps planned; reporting current state." });
      }

      let stepsSucceeded = 0;
      let stepsExecuted = 0;

      for (const step of plan) {
        if (stopRequested) {
          emit("error", { message: "stopped by user" });
          emit("done", { success: false, error: "stopped by user", trace, stopped: true });
          return { success: false, trace, error: "stopped by user", stopped: true };
        }

        // Re-check for an overlay before each action; clicks can re-trigger one.
        if (await bt.hasOverlay()) {
          emit("thinking_delta", { text: "Overlay reappeared; dismissing before next action." });
          const d = await bt.browserDismissOverlay();
          if (d.dismissed) emit("tool_call", { name: "dismiss", arguments: {} });
        }

        const action = step.action || "fail";
        emit("tool_call", { name: action, arguments: { target: step.target, value: step.value } });
        let result: { ok: boolean; error?: string };
        if (action === "click" && step.target) {
          result = await bt.browserClick(step.target);
        } else if (action === "type" && step.target) {
          result = await bt.browserType(step.target, step.value || "");
        } else if (action === "scroll") {
          result = await bt.browserScroll("down");
        } else if (action === "navigate" && step.target) {
          result = await bt.browserNavigate(step.target).then((r) => ({ ok: r.ok, error: r.error }));
        } else if (action === "wait") {
          result = await bt.browserWait(Number(step.value) || 2000);
        } else if (action === "dismiss") {
          result = await bt.browserDismissOverlay().then((r) => ({ ok: r.ok, dismissed: r.dismissed }));
        } else {
          result = { ok: false, error: `unsupported action: ${action}` };
        }
        stepsExecuted += 1;
        emit("tool_result", { name: action, result: result.ok ? "ok" : result.error });
        if (result.ok) {
          stepsSucceeded += 1;
        } else {
          emit("thinking_delta", { text: `Step failed: ${result.error}` });
        }
      }

      // Success requires that the planned steps actually executed AND that the
      // plan included at least one real interaction (type/click), not just
      // meta-actions (dismiss/navigate/wait). A plan that only dismisses a
      // dialog and waits did not verify the goal.
      const meaningfulSteps = plan.filter(
        (s) => s.action === "type" || s.action === "click",
      ).length;
      const allStepsOk = stepsExecuted === 0 ? false : stepsSucceeded === stepsExecuted;
      success = allStepsOk && meaningfulSteps > 0;

      // Only generate a Playwright test when the run actually succeeded.
      if (success) {
        const code = await this.generateCode(goal, url, plan, emit);
        generatedCode = code;
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      emit("error", { message: msg });
      emit("done", { success: false, error: msg, trace });
      return { success: false, trace, error: msg };
    } finally {
      await bt.browserClose();
    }

    emit("done", { success, trace, generated_code: generatedCode });
    return { success, trace, generatedCode };
  }

  private async planBatch(
    goal: string,
    assertions: Array<Record<string, any>>,
    currentUrl: string,
    elements: bt.SnapshotElement[],
    emit: EventSink,
  ): Promise<PlanStep[]> {
    const elemLines = elements
      .map((e) => {
        const extra = e.editable ? ` [EDITABLE text field${e.inputType && e.inputType !== "text" ? ` type=${e.inputType}` : ""}]` : "";
        return `- ${e.ref} ${e.role}|${e.name}${extra}`;
      })
      .join("\n") || "(no interactive elements)";
    const assertLines = assertions.map((a) => `- ${a.type} ${a.target ?? ""}`).join("\n") || "(none)";
    const prompt = `You are a test automation planner. Given a page and a goal, return a JSON array of steps to achieve the goal.
Each step: {"action":"click|type|scroll|navigate|wait|dismiss", "target":"<element ref like [3]>", "value":"<text for type, or ms for wait>", "thought":"short reason"}.
Available actions:
- click: click an element (target ref) — only use on buttons/links/dropdowns, NOT on text fields
- type: fill a text field (target ref + value) — target MUST be an [EDITABLE text field] element from ELEMENTS
- scroll: scroll the page down
- navigate: go to a DIFFERENT URL than the current one (target) — rarely needed
- wait: pause for the page to settle (value = ms, e.g. 2000)
- dismiss: close a visible modal/pop-up overlay (use first if a dialog is shown)
RULES:
- The browser is ALREADY on the goal page (CURRENT URL below). Do NOT emit a "navigate" step back to that same URL — you are already there. Only use "navigate" to go somewhere genuinely different.
- If a modal/pop-up overlay is visible on the page, emit a "dismiss" step BEFORE trying to click anything behind it.
- Use a [EDITABLE text field] element for any "type" step (e.g. search boxes). Do NOT type into buttons or links.
- Prefer elements whose name matches the goal (e.g. a search field for a destination query).
- Produce a COMPLETE plan of concrete interactions (type into the search field, click search, wait, click a result, verify). Do not stop after dismissing a dialog.
Only output the JSON array, no prose, no markdown.

GOAL: ${goal}
CURRENT URL: ${currentUrl}
ASSERTIONS: ${assertLines}
ELEMENTS:
${elemLines}`;

    const [_, out] = await this.llm.streamInfer(prompt, {
      onDelta: (kind, text) => emit("thinking_delta", { text, kind }),
    }, 2048, 0);
    return extractJsonArray(out);
  }

  private async generateCode(
    goal: string,
    url: string,
    steps: PlanStep[],
    emit: EventSink,
  ): Promise<string> {
    const stepLines = steps.map((s) => `- ${s.action} ${s.target ?? ""} ${s.value ?? ""}`).join("\n") || "- (no steps)";
    const prompt = `Write a Playwright (TypeScript) test that accomplishes this goal. Return ONLY a fenced typescript code block.

GOAL: ${goal}
URL: ${url}
STEPS TAKEN:
${stepLines}`;

    const [_, out] = await this.llm.streamInfer(prompt, {
      onDelta: (kind, text) => emit("content_delta", { text, kind }),
    }, 2048, 0.3);
    return stripCodeFences(out);
  }
}

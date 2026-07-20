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

function extractJsonObject(text: string): PlanStep | null {
  // Strip markdown code fences if present, then find the first balanced {...}.
  const cleaned = text
    .replace(/```(?:json|typescript|js|javascript)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = cleaned.slice(start, i + 1);
        try {
          return JSON.parse(slice) as PlanStep;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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
    const { goal, url, assertions = [], headless = true, maxTurns: maxTurnsOpt = 30 } = opts;
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
    const maxTurns = Math.max(1, Math.min(maxTurnsOpt, 60));

    try {
      // Per-turn agentic loop: each turn we snapshot the CURRENT page, ask the
      // LLM for the single next action against that live DOM, then execute it.
      // This keeps element refs valid even after navigations / overlay changes
      // (a single up-front plan goes stale the moment the page reloads).
      const executed: PlanStep[] = [];
      let turns = 0;
      let lastKey = "";
      let sameFailStreak = 0;

      while (turns < maxTurns) {
        if (stopRequested) {
          emit("error", { message: "stopped by user" });
          emit("done", { success: false, error: "stopped by user", trace, stopped: true });
          return { success: false, trace, error: "stopped by user", stopped: true };
        }
        turns += 1;

        // Dismiss any overlay before observing/acting.
        if (await bt.hasOverlay()) {
          emit("thinking_delta", { text: "Detected an overlay/dialog; dismissing it before proceeding." });
          const d = await bt.browserDismissOverlay();
          if (d.dismissed) {
            emit("tool_call", { name: "dismiss", arguments: {} });
            emit("tool_result", { name: "dismiss", result: "ok" });
            executed.push({ action: "dismiss" });
          }
        }

        const snap = await bt.browserSnapshot();
        const elements = snap.interactive_elements ?? [];
        if (elements.length === 0 && executed.length === 0) {
          emit("thinking_delta", { text: "No interactive elements found on the page." });
        }

        const next = await this.planNextStep(
          goal,
          assertions,
          snap.url || nav.url || url,
          elements,
          executed,
          emit,
        );

        // The planner may signal the goal is achieved.
        if (!next || next.action === "done") {
          emit("thinking_delta", { text: "Planner reports the goal is achieved." });
          success = executed.some((s) => s.action === "type" || s.action === "click");
          break;
        }

        const action = next.action;
        if (!action || typeof action !== "string") {
          emit("thinking_delta", { text: "Planner returned an unrecognized action; re-observing." });
          await bt.browserWait(1000);
          continue;
        }
        emit("tool_call", { name: action, arguments: { target: next.target, value: next.value } });
        let result: { ok: boolean; error?: string };
        if (action === "click" && next.target) {
          result = await bt.browserClick(next.target);
        } else if (action === "type" && next.target) {
          result = await bt.browserType(next.target, next.value || "");
        } else if (action === "scroll") {
          result = await bt.browserScroll("down");
        } else if (action === "navigate" && next.target) {
          // Only honor navigation to a genuinely different URL.
          const cur = (await bt.browserSnapshot().then((s) => s.url)) || "";
          if (next.target === cur || next.target === url) {
            emit("thinking_delta", { text: "Skipping redundant navigation to the current page." });
            result = { ok: true };
          } else {
            result = await bt.browserNavigate(next.target).then((r) => ({ ok: r.ok, error: r.error }));
          }
        } else if (action === "wait") {
          result = await bt.browserWait(Number(next.value) || 2000);
        } else if (action === "dismiss") {
          result = await bt.browserDismissOverlay().then((r) => ({ ok: r.ok, dismissed: r.dismissed }));
        } else {
          result = { ok: false, error: `unsupported action: ${action}` };
        }

        if (action !== "navigate") executed.push(next);
        emit("tool_result", { name: action, result: result.ok ? "ok" : result.error });
        if (!result.ok) {
          const key = `${action}:${next.target ?? ""}`;
          if (key === lastKey) sameFailStreak += 1;
          else {
            lastKey = key;
            sameFailStreak = 1;
          }
          emit("thinking_delta", { text: `Step failed: ${result.error}. Will re-observe and retry.` });
          // Break a stuck loop: if the same action fails repeatedly, nudge the
          // page with a wait/scroll so a fresh snapshot can find new elements.
          if (sameFailStreak >= 3) {
            emit("thinking_delta", { text: "Same step failed 3x; nudging the page to recover." });
            await bt.browserWait(1500);
            await bt.browserScroll("down");
            sameFailStreak = 0;
            lastKey = "";
          }
        } else {
          lastKey = "";
          sameFailStreak = 0;
        }
      }

      // Success requires at least one real interaction (type/click) and that we
      // did not exhaust turns without achieving the goal.
      const meaningfulSteps = executed.filter(
        (s) => s.action === "type" || s.action === "click",
      ).length;
      if (turns >= maxTurns && !success) {
        success = false;
      }
      success = success && meaningfulSteps > 0;

      // Only generate a Playwright test when the run actually succeeded.
      if (success) {
        const code = await this.generateCode(goal, url, executed, emit);
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

  private async planNextStep(
    goal: string,
    assertions: Array<Record<string, any>>,
    currentUrl: string,
    elements: bt.SnapshotElement[],
    history: PlanStep[],
    emit: EventSink,
  ): Promise<PlanStep | null> {
    const elemLines = elements
      .map((e) => {
        const extra = e.editable ? ` [EDITABLE text field${e.inputType && e.inputType !== "text" ? ` type=${e.inputType}` : ""}]` : "";
        return `- ${e.ref} ${e.role}|${e.name}${extra}`;
      })
      .join("\n") || "(no interactive elements)";
    const assertLines = assertions.map((a) => `- ${a.type} ${a.target ?? ""}`).join("\n") || "(none)";
    const histLines = history.length
      ? history.map((h, i) => `${i + 1}. ${h.action}${h.target ? ` ${h.target}` : ""}${h.value ? ` "${h.value}"` : ""}`).join("\n")
      : "(none yet)";
    const prompt = `You are an agentic test executor. Given the CURRENT page state, decide the SINGLE next action that makes progress toward the GOAL. Respond with ONE JSON object (not an array):
{"action":"click|type|scroll|navigate|wait|dismiss|done", "target":"<element ref like [3]>", "value":"<text for type, or ms for wait>", "thought":"short reason"}
- "done": only when the goal is fully achieved and verified (e.g. price/rating visible). Do NOT use done just because a dialog was dismissed.
Available actions:
- click: click an element (target ref) — only on buttons/links/dropdowns, NOT text fields
- type: fill a text field (target ref + value) — target MUST be an [EDITABLE text field] element from ELEMENTS
- scroll: scroll the page down
- navigate: go to a DIFFERENT URL than the current one (target) — rarely needed
- wait: pause for the page to settle (value = ms, e.g. 2000)
- dismiss: close a visible modal/pop-up overlay (use first if a dialog is shown)
- done: goal achieved
RULES:
- The browser is ALREADY on the goal page (CURRENT URL below). Do NOT navigate to that same URL.
- If a modal/pop-up overlay is visible, choose "dismiss" as the next action.
- Use an [EDITABLE text field] for any "type" step. Do NOT type into buttons or links.
- Prefer elements whose name matches the goal (e.g. a search field for a destination query).
- Choose exactly ONE next action based on the CURRENT elements; do not repeat a step that just succeeded unless it makes new progress.
- Element refs (like [3]) are ONLY valid for THIS turn's CURRENT ELEMENTS. NEVER reuse a ref you picked in a previous turn — every turn, pick a fresh ref from the list shown above. If the page changed after a click/navigation, the elements are new.
- After you click a link/button that opens a new page (e.g. a course result), the NEXT turn's CURRENT ELEMENTS will be that new page. Perform verification (enrollment/start option, description) on the NEW page, not by clicking the same result again.
- If a click on a result keeps failing or the target is not visible, scroll to bring results into view and pick the visible ref from the refreshed list. Do NOT click the same hidden/detached ref repeatedly.
- If a click is blocked by an overlay or backdrop intercepting pointer events, choose "dismiss" before retrying the click.
- If CURRENT ELEMENTS is empty, the page is likely still loading or rendered no standard controls — choose "wait" or "scroll" to let it settle. NEVER reference an element ref (like [1]) when the element list is empty.
Only output the JSON object, no prose, no markdown.

GOAL: ${goal}
CURRENT URL: ${currentUrl}
ASSERTIONS: ${assertLines}
ACTIONS TAKEN SO FAR:
${histLines}
CURRENT ELEMENTS:
${elemLines}`;

    const [_, out] = await this.llm.streamInfer(prompt, {
      onDelta: (kind, text) => emit("thinking_delta", { text, kind }),
    }, 1024, 0);
    const step = extractJsonObject(out);
    if (step && typeof step.action === "string") return step;
    return null;
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

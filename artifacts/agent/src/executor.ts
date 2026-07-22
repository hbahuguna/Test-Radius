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
import { planGoal, type PlannedStep } from "./planner.js";
import { executeStep } from "./stepExecutor.js";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const LOG_DIR = join(process.cwd(), "logs");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_FILE = join(LOG_DIR, "agent-debug.log");
function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

export type EventSink = (event: string, data: Record<string, any>) => void;

export interface AgenticRunOptions {
  goal: string;
  url: string;
  assertions?: Array<Record<string, any>>;
  headless?: boolean;
  maxTurns?: number;
  byok?: Record<string, string> | null;
  model?: string | null;
  /** "reactive" = default single-step loop; "planned" = decompose goal first */
  mode?: "reactive" | "planned";
}

export interface RunResult {
  success: boolean;
  trace: { goal: string; url: string; assertions?: unknown };
  assertionResults?: Array<{ index: number; pass: boolean; reason: string }> | null;
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
  // Strip markdown code fences if present, then find a balanced {...} that
  // contains an "action" field. For reasoning models, the JSON action is
  // typically at the END of a long reasoning chain, so we scan from the
  // last `{` backwards to find the right one.
  const cleaned = text
    .replace(/```(?:json|typescript|js|javascript)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // Strategy: find ALL `{` positions, try each from last to first.
  // The action JSON is usually at the end of the output.
  const openBraces: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") openBraces.push(i);
  }

  // Try from the last `{` backwards — the action JSON is at the end.
  for (let s = openBraces.length - 1; s >= 0; s--) {
    const start = openBraces[s];
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
            const obj = JSON.parse(slice) as PlanStep;
            // Only accept if it has an "action" field — filters out
            // random JSON objects in the reasoning text.
            if (obj && typeof obj.action === "string") return obj;
          } catch {
            // Try next candidate
          }
          break;
        }
      }
    }
  }

  // Fallback: scan for action patterns in the text. Reasoning models
  // sometimes embed the action inline without proper JSON wrapping.
  // e.g. `"action":"click","target":"[3]"`
  const actionMatch = text.match(/"action"\s*:\s*"(click|type|scroll|navigate|wait|dismiss|done|selectOption)"/);
  if (actionMatch) {
    const action = actionMatch[1];
    const targetMatch = text.match(/"target"\s*:\s*"([^"]*)"/);
    const valueMatch = text.match(/"value"\s*:\s*"([^"]*)"/);
    const thoughtMatch = text.match(/"thought"\s*:\s*"([^"]*)"/);
    return {
      action,
      target: targetMatch?.[1] || undefined,
      value: valueMatch?.[1] || undefined,
      thought: thoughtMatch?.[1] || undefined,
    };
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
      128,
      0,
    );
    if (!name || !out.trim()) throw new ByokError("BYOK key did not produce a response. Check your API key and model selection in Settings.");
  }

  async run(
    opts: AgenticRunOptions,
    emit: EventSink,
  ): Promise<RunResult> {
    const { goal, url, assertions = [], headless = true, maxTurns: maxTurnsOpt = 30, mode = "reactive" } = opts;
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
    } else if (this.llm.clients.length === 0) {
      const msg = "No LLM provider available. Add an API key in Settings.";
      emit("error", { message: msg });
      emit("done", { success: false, error: msg, trace });
      return { success: false, trace, error: msg };
    }

    // Route to planned mode if requested
    if (mode === "planned") {
      return this.runPlanned(opts, emit);
    }

    // ... existing reactive mode code continues ...

    emit("node", { node_id: "agentic", role: "agent", name: "agentic-execute" });
    debugLog(`=== RUN START === goal="${goal}" url="${url}" assertions=${assertions.length}`);
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
      let assertionResults: Array<{ index: number; pass: boolean; reason: string }> | null = null;
      const maxTurns = Math.max(1, Math.min(maxTurnsOpt, 60));

    try {
      // Per-turn agentic loop: each turn we snapshot the CURRENT page, ask the
      // LLM for the single next action against that live DOM, then execute it.
      // This keeps element refs valid even after navigations / overlay changes
      // (a single up-front plan goes stale the moment the page reloads).
      const executed: PlanStep[] = [];
      const lastActions: string[] = [];
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
        debugLog(`\n--- TURN ${turns} ---`);

        // Dismiss any overlay before observing/acting.
        if (await bt.hasOverlay()) {
          debugLog("Overlay detected, dismissing...");
          emit("thinking_delta", { text: "Detected an overlay/dialog; dismissing it before proceeding." });
          const d = await bt.browserDismissOverlay();
          if (d.dismissed) {
            emit("tool_call", { name: "dismiss", arguments: {} });
            emit("tool_result", { name: "dismiss", result: "ok" });
            executed.push({ action: "dismiss" });
            debugLog("Overlay dismissed");
          }
        }

        const snap = await bt.browserSnapshot();
        const elements = snap.interactive_elements ?? [];

        // If the browser/page crashed or was closed, try to recover.
        if (!snap.ok || elements.length === 0 && snap.url === undefined) {
          debugLog("Browser lost — attempting recovery");
          emit("thinking_delta", { text: "Browser context lost; recovering..." });
          const recovered = await bt.browserRecover(url, headless);
          if (!recovered) {
            const msg = "Browser crashed and could not recover.";
            emit("error", { message: msg });
            emit("done", { success: false, error: msg, trace });
            return { success: false, trace, error: msg };
          }
          // Re-snapshot after recovery
          const snap2 = await bt.browserSnapshot();
          const elements2 = snap2.interactive_elements ?? [];
          debugLog(`Recovery snapshot: ${elements2.length} elements, URL=${snap2.url}`);
          // Use recovered snapshot
          Object.assign(snap, snap2);
          elements.length = 0;
          elements.push(...elements2);
        }

        debugLog(`Snapshot: ${elements.length} elements, URL=${snap.url}`);
        for (const e of elements) {
          debugLog(`  ${e.ref} ${e.role}|${e.name}${e.editable ? " [EDITABLE]" : ""}${e.role === "option" ? " [OPTION]" : ""}`);
        }

        const next = await this.planNextStep(
          goal,
          assertions,
          snap.url || nav.url || url,
          elements,
          executed,
          emit,
        );

        debugLog(`Planner returned: action=${next?.action} target=${next?.target} value=${next?.value} thought=${next?.thought?.slice(0, 100)}`);

        // The planner may signal the goal is achieved.
        if (next && next.action === "done") {
          // Before accepting "done", verify assertions against the live page.
          // The planner might claim success prematurely — we confirm by
          // snapshotting the current state and asking the LLM to check each
          // assertion.
          const finalSnap = await bt.browserSnapshot();
          const finalElements = finalSnap.interactive_elements ?? [];
          const verdict = await this.verifyAssertions(
            goal, assertions, finalSnap.url || "", finalElements, emit,
          );
          assertionResults = verdict.results;
          if (verdict.ok) {
            emit("thinking_delta", { text: "All assertions verified on the final page." });
            success = true;
          } else {
            emit("thinking_delta", { text: `Assertions failed: ${verdict.reason}. Re-observing.` });
            // Don't break — loop continues so the planner can fix the issue.
            continue;
          }
          break;
        }

        if (!next) {
          // Planner returned null (unparseable output) — re-observe.
          sameFailStreak += 1;
          await bt.browserWait(1000);
          continue;
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
        } else if (action === "selectOption") {
          // Use keyboard navigation (ArrowDown + Enter) to select from a
          // dropdown without clicking, which avoids triggering page navigation.
          result = await bt.browserKeyboardSelect();
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
        debugLog(`Action result: ok=${result.ok} error=${result.error ?? "none"}`);
        emit("tool_result", { name: action, result: result.ok ? "ok" : result.error });

        // Track the last 5 action-target pairs to detect loops where the same
        // action succeeds but makes no progress (e.g. clicking the same combobox
        // repeatedly).
        const actionKey = `${action}:${next.target ?? ""}:${next.value ?? ""}`;
        lastActions.push(actionKey);
        if (lastActions.length > 5) lastActions.shift();
        const repeatCount = lastActions.filter((k) => k === actionKey).length;
        if (repeatCount >= 3) {
          emit("thinking_delta", { text: `Same action repeated ${repeatCount} times; trying something different.` });
          // Force a scroll + wait to break the loop and get a fresh snapshot
          await bt.browserScroll("down");
          await bt.browserWait(1500);
          lastActions.length = 0;
          continue;
        }

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
      debugLog(`=== RUN END (in try) === success=${success} turns=${turns} actions=${executed.length}`);
      for (const a of executed) {
        debugLog(`  ${a.action} ${a.target ?? ""} ${a.value ?? ""}`);
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      emit("error", { message: msg });
      emit("done", { success: false, error: msg, trace });
      return { success: false, trace, error: msg };
    } finally {
      await bt.browserClose();
    }

    emit("done", { success, trace, assertion_results: assertionResults, generated_code: generatedCode });
    debugLog(`=== RUN END === success=${success}`);
    return { success, trace, assertionResults, generatedCode };
  }

  /**
   * PLANNED MODE: Decompose the goal into micro-steps, execute each one,
   * and use deterministic checks to stop — not LLM self-evaluation.
   *
   * Stopping conditions:
   *   1. All assertions pass → success
   *   2. Same page state (URL + elements) seen 3x in a row → stuck → fail
   *   3. Step execution fails 3x in a row → fail
   *   4. Hard step limit reached → fail
   *   5. User requested stop → fail
   *   6. Browser recovery fails → fail
   *   7. Too many re-plans (browser kept crashing) → fail
   */
  private async runPlanned(
    opts: AgenticRunOptions,
    emit: EventSink,
  ): Promise<RunResult> {
    const { goal, url, assertions = [], headless = true, maxTurns: maxTurnsOpt = 30 } = opts;
    const trace = { goal, url, assertions };
    const MAX_STEPS = Math.min(maxTurnsOpt, 15);
    const MAX_REPLANS = 2; // max times we can re-plan after browser crash / stuck

    emit("node", { node_id: "agentic", role: "agent", name: "agentic-execute" });
    emit("thinking_delta", { text: "Planning: breaking down goal into micro-steps..." });
    debugLog(`=== PLANNED RUN START === goal="${goal}" url="${url}"`);

    // Start browser
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

    let success = false;
    let assertionResults: Array<{ index: number; pass: boolean; reason: string }> | null = null;
    let generatedCode: string | null = null;
    const allExecuted: PlannedStep[] = [];
    let replansUsed = 0;
    let totalStepsRun = 0;

    // State tracking for stuck detection
    const stateHistory: string[] = [];
    let consecutiveFailures = 0;

    const fingerprintState = (snapUrl: string, elements: bt.SnapshotElement[]): string => {
      const elemSig = elements
        .slice(0, 15)
        .map((e) => `${e.ref}:${e.role}:${e.name?.slice(0, 40)}`)
        .join("|");
      return `${snapUrl}::${elemSig}`;
    };

    const checkAssertions = async (): Promise<{ pass: boolean; results: Array<{ index: number; pass: boolean; reason: string }> }> => {
      const snap = await bt.browserSnapshot();
      const elements = snap.interactive_elements ?? [];
      const verdict = await this.verifyAssertions(goal, assertions, snap.url || "", elements, emit);
      return { pass: verdict.ok, results: verdict.results };
    };

    const getSnapshot = async (): Promise<{ url: string; elements: bt.SnapshotElement[]; ok: boolean }> => {
      const snap = await bt.browserSnapshot();
      return { url: snap.url || "", elements: snap.interactive_elements ?? [], ok: snap.ok };
    };

    const recoverBrowser = async (reason: string): Promise<{ ok: boolean; snap: { url: string; elements: bt.SnapshotElement[]; ok: boolean } }> => {
      emit("thinking_delta", { text: `Browser lost (${reason}); recovering...` });
      debugLog(`Browser recovery triggered: ${reason}`);

      const recovered = await bt.browserRecover(url, headless);
      if (!recovered) {
        return { ok: false, snap: { url: "", elements: [], ok: false } };
      }

      const snap = await getSnapshot();
      // After recovery we're back at the start URL — reset state tracking
      stateHistory.length = 0;
      consecutiveFailures = 0;
      return { ok: true, snap };
    };

    try {
      // Outer loop: plans. Inner loop: steps within a plan.
      // If browser crashes or we get stuck, we re-plan from current state.
      while (replansUsed <= MAX_REPLANS && totalStepsRun < MAX_STEPS) {
        if (stopRequested) {
          emit("error", { message: "stopped by user" });
          emit("done", { success: false, error: "stopped by user", trace, stopped: true });
          return { success: false, trace, error: "stopped by user", stopped: true };
        }

        // Phase 1: Plan (or re-plan)
        const steps = await planGoal(this.llm, goal, url, assertions);
        if (steps.length === 0) {
          const msg = "Failed to generate a plan.";
          emit("error", { message: msg });
          emit("done", { success: false, error: msg, trace });
          return { success: false, trace, error: msg };
        }

        emit("thinking_delta", { text: `Plan (${steps.length} steps):\n${steps.map((s) => `${s.id}. ${s.instruction}`).join("\n")}` });
        debugLog(`Plan has ${steps.length} steps (replan #${replansUsed})`);

        // Phase 2: Execute steps
        for (let stepIdx = 0; stepIdx < steps.length && totalStepsRun < MAX_STEPS; stepIdx++) {
          if (stopRequested) {
            emit("error", { message: "stopped by user" });
            emit("done", { success: false, error: "stopped by user", trace, stopped: true });
            return { success: false, trace, error: "stopped by user", stopped: true };
          }

          const step = steps[stepIdx];
          totalStepsRun++;
          emit("thinking_delta", { text: `\n--- Step ${step.id}/${steps.length} (total ${totalStepsRun}/${MAX_STEPS}): ${step.instruction} ---` });
          debugLog(`\n--- STEP ${step.id}: ${step.instruction} (action: ${step.action}) --- replan#${replansUsed}`);

          // Handle verify steps
          if (step.action === "verify") {
            const check = await checkAssertions();
            assertionResults = check.results;
            if (check.pass) {
              emit("thinking_delta", { text: "Assertions verified!" });
              success = true;
              allExecuted.push(step);
              break;
            } else {
              emit("thinking_delta", { text: `Assertions not met: ${check.results.map((r) => r.reason).join("; ")}` });
            }
            continue;
          }

          // Dismiss overlays
          if (await bt.hasOverlay()) {
            const d = await bt.browserDismissOverlay();
            if (d.dismissed) {
              emit("tool_call", { name: "dismiss", arguments: {} });
              emit("tool_result", { name: "dismiss", result: "ok" });
            }
          }

          // Snapshot current page
          let snap = await getSnapshot();
          let { elements } = snap;

          // Handle browser crash — recover and re-plan
          if (!snap.ok || (elements.length === 0 && !snap.url)) {
            const rec = await recoverBrowser("snapshot failed");
            if (!rec.ok) {
              const msg = "Browser crashed and could not recover.";
              emit("error", { message: msg });
              emit("done", { success: false, error: msg, trace });
              return { success: false, trace, error: msg };
            }
            snap = rec.snap;
            elements = rec.snap.elements;

            // After recovery, re-plan from current state
            replansUsed++;
            if (replansUsed > MAX_REPLANS) {
              const msg = `Browser crashed ${MAX_REPLANS + 1} times. Too many restarts — aborting.`;
              emit("thinking_delta", { text: msg });
              emit("done", { success: false, error: msg, trace });
              return { success: false, trace, error: msg };
            }
            emit("thinking_delta", { text: `Re-planning from current state (replan ${replansUsed}/${MAX_REPLANS})...` });
            debugLog(`Re-planning: browser recovery #${replansUsed}, current URL=${snap.url}`);
            break; // break inner loop to re-plan
          }

          // === STUCK DETECTION ===
          const stateKey = fingerprintState(snap.url, elements);
          const lastState = stateHistory[stateHistory.length - 1];
          if (lastState === stateKey) {
            consecutiveFailures++;
            emit("thinking_delta", { text: `Stuck: page state unchanged (${consecutiveFailures}/3)` });
            debugLog(`Stuck detection: same state ${consecutiveFailures}x`);

            if (consecutiveFailures >= 3) {
              // Stuck — try re-planning
              replansUsed++;
              if (replansUsed > MAX_REPLANS) {
                const msg = `Agent is stuck and has re-planned ${MAX_REPLANS} times. Goal not achievable from current state.`;
                emit("thinking_delta", { text: msg });
                emit("done", { success: false, error: msg, trace });
                return { success: false, trace, error: msg };
              }
              emit("thinking_delta", { text: `Stuck — re-planning from current state (replan ${replansUsed}/${MAX_REPLANS})...` });
              debugLog(`Re-planning: stuck at state ${stateKey.slice(0, 80)}`);
              stateHistory.length = 0;
              consecutiveFailures = 0;
              break; // break inner loop to re-plan
            }
          } else {
            consecutiveFailures = 0;
          }
          stateHistory.push(stateKey);
          if (stateHistory.length > 10) stateHistory.shift();

          debugLog(`Step ${step.id}: ${elements.length} elements, state=${stateKey.slice(0, 80)}`);

          // Execute the step with retries
          let retries = 0;
          let stepDone = false;
          while (retries < 3 && !stepDone) {
            const result = await executeStep(
              this.llm,
              step.instruction,
              step.action,
              step.targetHint,
              step.value,
              elements,
              emit,
            );

            if (!result) {
              emit("thinking_delta", { text: "Could not parse step action; retrying..." });
              retries++;
              consecutiveFailures++;
              await bt.browserWait(1000);
              continue;
            }

            emit("tool_call", { name: result.action, arguments: { target: result.target, value: result.value } });

            // Dispatch the action
            let actionResult: { ok: boolean; error?: string };
            if (result.action === "click" && result.target) {
              actionResult = await bt.browserClick(result.target);
            } else if (result.action === "type" && result.target) {
              actionResult = await bt.browserType(result.target, result.value || step.value || "");
            } else if (result.action === "selectOption") {
              actionResult = await bt.browserKeyboardSelect();
            } else if (result.action === "scroll") {
              actionResult = await bt.browserScroll("down");
            } else if (result.action === "wait") {
              actionResult = await bt.browserWait(Number(result.value) || 2000);
            } else if (result.action === "dismiss") {
              actionResult = await bt.browserDismissOverlay().then((r) => ({ ok: r.ok, dismissed: r.dismissed }));
            } else {
              actionResult = { ok: false, error: `unsupported action: ${result.action}` };
            }

            emit("tool_result", { name: result.action, result: actionResult.ok ? "ok" : actionResult.error });
            debugLog(`Step ${step.id} result: ok=${actionResult.ok} error=${actionResult.error ?? "none"}`);

            // Check if action failed due to browser issue
            if (!actionResult.ok && actionResult.error?.includes("browser")) {
              const rec = await recoverBrowser(actionResult.error || "action failed");
              if (!rec.ok) {
                const msg = "Browser crashed and could not recover.";
                emit("error", { message: msg });
                emit("done", { success: false, error: msg, trace });
                return { success: false, trace, error: msg };
              }
              replansUsed++;
              if (replansUsed > MAX_REPLANS) {
                const msg = `Browser crashed ${MAX_REPLANS + 1} times. Aborting.`;
                emit("thinking_delta", { text: msg });
                emit("done", { success: false, error: msg, trace });
                return { success: false, trace, error: msg };
              }
              emit("thinking_delta", { text: `Re-planning after browser issue (replan ${replansUsed}/${MAX_REPLANS})...` });
              break; // break retry loop → will break step loop → re-plan
            }

            if (actionResult.ok) {
              stepDone = true;
              allExecuted.push(step);
              consecutiveFailures = 0;
              await bt.browserWait(500);

              // Deterministic goal check
              const check = await checkAssertions();
              assertionResults = check.results;
              if (check.pass) {
                emit("thinking_delta", { text: "Goal achieved — all assertions pass." });
                success = true;
                break;
              }
            } else {
              retries++;
              consecutiveFailures++;
              emit("thinking_delta", { text: `Step failed: ${actionResult.error}. Retrying... (${retries}/3)` });
              await bt.browserWait(1500);
              const retrySnap = await getSnapshot();
              elements.length = 0;
              elements.push(...retrySnap.elements);
            }
          }

          if (success) break;

          // Check if we broke out of retry loop due to browser issue
          if (!stepDone && consecutiveFailures >= 3) {
            // Already handled by stuck detection above
          }
        }

        if (success) break;

        // If we exhausted all steps without success, we're done
        if (replansUsed <= MAX_REPLANS) {
          // We completed the plan but goal not achieved — report failure
          const msg = `Completed ${allExecuted.length} steps but goal not achieved.`;
          emit("thinking_delta", { text: msg });

          // Final assertion check
          const finalCheck = await checkAssertions();
          assertionResults = finalCheck.results;
          if (finalCheck.pass) {
            success = true;
            break;
          }
        }
      }

      const meaningfulSteps = allExecuted.filter(
        (s) => s.action === "type" || s.action === "click",
      ).length;
      success = success && meaningfulSteps > 0;

      if (success) {
        const code = await this.generateCode(goal, url, allExecuted as PlanStep[], emit);
        generatedCode = code;
      }

      debugLog(`=== PLANNED RUN END === success=${success} steps=${allExecuted.length} replans=${replansUsed}`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      emit("error", { message: msg });
      emit("done", { success: false, error: msg, trace });
      return { success: false, trace, error: msg };
    } finally {
      await bt.browserClose();
    }

    emit("done", { success, trace, assertion_results: assertionResults, generated_code: generatedCode });
    return { success, trace, assertionResults, generatedCode };
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
        let extra = "";
        if (e.role === "option") extra = " *** MUST CLICK THIS TO CONFIRM SELECTION ***";
        else if (e.role === "combobox") extra = " [EDITABLE combobox — type to search, then click a suggestion]";
        else if (e.editable) extra = ` [EDITABLE text field${e.inputType && e.inputType !== "text" ? ` type=${e.inputType}` : ""}]`;
        return `- ${e.ref} ${e.role}|${e.name}${extra}`;
      })
      .join("\n") || "(no interactive elements)";
    const assertLines = assertions.map((a) => `- ${a.type} ${a.target ?? ""}`).join("\n") || "(none)";
    const histLines = history.length
      ? history.map((h, i) => `${i + 1}. ${h.action}${h.target ? ` ${h.target}` : ""}${h.value ? ` "${h.value}"` : ""}`).join("\n")
      : "(none yet)";
    const prompt = `You are an agentic test executor. Given the CURRENT page state, decide the SINGLE next action that makes progress toward the GOAL. Respond with ONE JSON object (not an array):
{"action":"click|type|scroll|navigate|wait|dismiss|done", "target":"<element ref like [3]>", "value":"<text for type, or ms for wait>", "thought":"short reason"}
- "done": ONLY when the ENTIRE goal is achieved and every requirement is verified visible on the current page. NEVER say done if the goal has multiple parts and not ALL parts are confirmed. Filling a form field is NOT completion — you must trigger the search, wait for results, and verify the expected data.
Available actions:
- click: click an element (target ref) — buttons/links/comboboxes/suggestions
- type: fill a text field or combobox (target ref + value) — target MUST be an [EDITABLE] element; for comboboxes, type directly — the tool handles click+type automatically
- selectOption: select a dropdown option using keyboard (ArrowDown + Enter) — use this instead of clicking [option] elements to avoid triggering page navigation
- scroll: scroll the page down
- navigate: go to a DIFFERENT URL than the current one (target) — rarely needed
- wait: pause for the page to settle (value = ms, e.g. 2000)
- dismiss: close a visible modal/pop-up overlay
- done: goal achieved
CRITICAL COMBOBOX RULE (Google Flights, etc.):
Step 1: click the combobox element (e.g. "Where from?") — this opens a dialog
Step 2: the next snapshot shows a dialog input (e.g. "Where else?") — type the city name into it
Step 3: after typing, a list of suggestions appears. Use keyboard ArrowDown + Enter to select (NOT click). Clicking options triggers page navigation that crashes the browser.
Step 4: the dialog closes, the combobox is updated — move to the next field
YOU MUST DO ALL 4 STEPS. Never skip steps. Each step is ONE action per turn.
RULES:
- The browser is ALREADY on the goal page. Do NOT navigate to that same URL.
- If a modal/pop-up overlay is visible, choose "dismiss" as the next action.
- Use "click" on a combobox to open its dialog, then "type" into the dialog input that appears. Do NOT type directly into a combobox.
- After typing into a dialog input, if [option] elements are visible, your NEXT action MUST be to click one of them. Do NOT type into another field while options are visible.
- Prefer elements whose name matches the goal.
- For multi-step goals (fill fields → search → wait → open → verify), execute each step in order. After filling ALL form fields, look for a search/submit button. Do NOT say done after just filling fields.
- Choose exactly ONE next action; do not repeat a step that just succeeded.
- Element refs are ONLY valid for THIS turn. NEVER reuse a ref from a previous turn.
- Be CONCISE. Output ONLY the JSON object, no prose, no markdown.

GOAL: ${goal}
CURRENT URL: ${currentUrl}
ASSERTIONS: ${assertLines}
ACTIONS TAKEN SO FAR:
${histLines}
CURRENT ELEMENTS:
${elemLines}`;

    const maxAttempts = 3;
    let lastRaw = "";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sysPrompt = attempt === 0
        ? "CRITICAL: You are a browser automation agent. You MUST output a JSON object with an 'action' field. Example: {\"action\":\"click\",\"target\":\"[1]\",\"value\":\"\",\"thought\":\"why\"}. Do NOT output reasoning. Do NOT explain. Output ONLY the JSON."
        : attempt === 1
          ? "STOP REASONING. Output ONLY a JSON object RIGHT NOW. Example: {\"action\":\"click\",\"target\":\"[1]\",\"value\":\"\",\"thought\":\"why\"}. Your response must start with { and end with }."
          : "FINAL CHANCE: Output ONLY {\"action\":\"click\",\"target\":\"[1]\",\"value\":\"\",\"thought\":\"done\"} or similar. Nothing else.";
      const [_, out] = await this.llm.streamInfer(prompt, {
        onDelta: (kind, text) => emit("thinking_delta", { text, kind }),
      }, 2048, 0, sysPrompt);
      lastRaw = out;
      debugLog(`LLM raw output (${out.length} chars): ${out.slice(-500)}`);
      const step = extractJsonObject(out);
      debugLog(`Parsed step: ${JSON.stringify(step)}`);
      // Guard against template echo: the LLM sometimes echoes the prompt format
      // "click|type|scroll|navigate|wait|dismiss|done" as the action value.
      if (step && typeof step.action === "string" && step.action.includes("|")) {
        debugLog("Template echo detected — rejecting step");
        continue;
      }
      if (step && typeof step.action === "string" && step.action !== "done") return step;
      // If the model returned "done" but no real actions (type/click) have been
      // taken yet, treat it as a premature misparse — force a re-observe.
      if (step && step.action === "done") {
        const hasInteraction = history.some((h) => h.action === "type" || h.action === "click");
        if (!hasInteraction) continue;
        return step;
      }
    }
    return null;
  }

  /**
   * Verify assertions against the live page state. Takes a snapshot, builds a
   * compact element list, and asks the LLM to confirm each assertion. Returns
   * ok:true only if ALL assertions pass.
   */
  private async verifyAssertions(
    goal: string,
    assertions: Array<Record<string, any>>,
    currentUrl: string,
    elements: bt.SnapshotElement[],
    emit: EventSink,
  ): Promise<{ ok: boolean; reason: string; results: Array<{ index: number; pass: boolean; reason: string }> }> {
    if (!assertions.length) return { ok: true, reason: "", results: [] };
    const elemLines = elements
      .slice(0, 30)
      .map((e) => `- ${e.ref} ${e.role}|${e.name}`)
      .join("\n") || "(no interactive elements)";
    const assertLines = assertions
      .map((a, i) => `${i + 1}. ${a.type}${a.target ? ` on "${a.target}"` : ""}${a.value ? ` expecting "${a.value}"` : ""}`)
      .join("\n");
    const prompt = `Verify test assertions against the CURRENT PAGE STATE. For each assertion, determine if it is satisfied.

RULES:
- "element_exists" on "flight results" means there must be elements that are actual flight listings (e.g. "Flight 123 — $245 — 2h 15m"). Generic UI options like "Round trip", "One way", "Economy" do NOT satisfy "flight results".
- "url_contains" checks the URL path/query.
- "text_assertion" checks that exact text is visible.
- "custom" checks the description literally.

GOAL: ${goal}
CURRENT URL: ${currentUrl}
ASSERTIONS:
${assertLines}
PAGE ELEMENTS:
${elemLines}

Output ONLY a JSON object: {"ok": true/false, "results": [{"index": 1, "pass": true/false, "reason": "brief why"}]}`;

    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sysPrompt = attempt === 0
        ? "Output ONLY a JSON object. No prose, no code, no markdown. Start with { and end with }."
        : "CRITICAL: Your previous response was not valid JSON. You MUST output ONLY a raw JSON object starting with { and ending with }. No other text whatsoever.";
      const [_, out] = await this.llm.streamInfer(prompt, {
        onDelta: (kind, text) => emit("thinking_delta", { text, kind }),
      }, 2048, 0, sysPrompt);
      const parsed = extractJsonObject(out) as { ok?: boolean; results?: Array<{ index: number; pass: boolean; reason: string }> } | null;
      if (parsed && typeof parsed.ok === "boolean") {
        const results = parsed.results ?? [];
        if (!parsed.ok) {
          const failed = results.filter((r) => !r.pass).map((r) => `#${r.index}: ${r.reason}`).join("; ");
          return { ok: false, reason: failed || "some assertions failed", results };
        }
        return { ok: true, reason: "", results };
      }
    }
    return { ok: false, reason: "Could not parse assertion verification response", results: [] };
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

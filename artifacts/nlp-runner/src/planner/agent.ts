import type { LLMClient } from "../llm/client.js";
import type { SaveTestResult } from "../cache/queries.js";
import { type SnapshotElement, type SnapshotPayload } from "./snapshot.js";
import { extractQuerySlots, type QuerySlot } from "./slots.js";
import type { SlotKind } from "../embeddings/normalize.js";
import { Planner, PlanParseError, type AskPlanResult } from "./planner.js";
import type { PlanTurn, Action, AssertAction } from "./schema.js";
import type { RecordedStep, RecordedSlot } from "../recorder/recorder.js";
import { HappyPathDoneChecker, type DoneChecker } from "./done-checker.js";

export interface RecordingDriver {
  snapshot(): Promise<SnapshotPayload>;
  signature(): Promise<string>;
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  scroll(selector?: string): Promise<void>;
  assertVisible(selector: string): Promise<void>;
  assertText(selector: string, expected: string): Promise<void>;
  assertUrl(contains: string): Promise<void>;
  extract(selector: string, name: string): Promise<string | undefined>;
  wait(ms?: number): Promise<void>;
  saveTest(
    name: string,
    opts: {
      query?: string | null;
      normalizedQuery?: string | null;
      description?: string | null;
      extraSlots?: RecordedSlot[];
    },
  ): Promise<SaveTestResult>;
  getSteps(): RecordedStep[];
  getSlots(): RecordedSlot[];
}

export interface RecordAgentEvent {
  type: "milestones" | "plan" | "step" | "guard" | "error";
  turn: number;
  milestones?: string[];
  actions?: Action[];
  done?: boolean;
  currentMilestone?: string;
  hint?: string;
  stepIndex?: number;
  action?: Action;
  ok?: boolean;
  error?: string;
  reason?: string;
}

export interface RecordAgentOptions {
  maxTurns?: number;
  maxSteps?: number;
  staleThreshold?: number;
  /** QF-55: human confirmation at each milestone boundary. Return false to abort. */
  onMilestone?: (milestone: string, index: number, total: number) => Promise<boolean>;
  /** QF-56: hint fed into the first plan prompt when re-recording after a dry-run failure. */
  resumeHint?: string;
  skeleton?: import("./site-memory.js").Skeleton;
  /** SSE streaming hook: called for each planning/execution event during record. */
  onEvent?: (event: RecordAgentEvent) => void;
  /** Happy-path done checker (browser-use style): after a click batch navigates,
   *  decide whether the task is done without another planning turn. Defaults to
   *  a rules-only checker (no extra LLM call). */
  doneChecker?: DoneChecker;
  /** Variable values (e.g. a JSON config from the CLI) seeded as planner slots,
   *  so the LLM fills "{email}"/"{name}"/... from these instead of inventing
   *  its own literal values each turn. */
  variables?: Record<string, string>;
}

export interface ReplanHint {
  turn: number;
  reason: string;
  hint: string;
}

export interface RecordMetrics {
  turns: number;
  steps: number;
  llmCalls: number;
  backtracks: number;
  guardFires: number;
  replanHints: ReplanHint[];
}

export interface RecordResult extends RecordMetrics {
  ok: boolean;
  testName: string;
  testId?: number;
  milestones?: string[];
  error?: string;
}

export class StepExecutionError extends Error {
  override name = "StepExecutionError";
  constructor(
    public readonly action: Action,
    public readonly inner: unknown,
  ) {
    super(
      `step ${action.type} failed: ${inner instanceof Error ? inner.message : String(inner)}`,
    );
  }
}

// Heuristic: detect whether a clicked element looks like a form submit button.
// Matches common submit button names/roles so the agent can auto-terminate after
// a submit click that navigates the page — the user no longer needs to say
// "declare done on submit" in every query.
const SUBMIT_NAME_RE =
  /\b(submit|sign\s*[\s-]?up|register|log\s*[\s-]?in|login|sign\s*[\s-]?in|join|create\s*[\s-]?account|checkout|place\s*[\s-]?order|complete|confirm|send|enroll|subscribe|get\s*[\s-]?started|try\s*[\s-]?(it|free)|start\s*[\s-]?(now|free)|continue|next)\b/i;

function isSubmitLike(element: { role: string; name: string }): boolean {
  if (element.role === "button" && SUBMIT_NAME_RE.test(element.name)) return true;
  // Some sites use role="link" for primary CTA links
  if (element.role === "link" && SUBMIT_NAME_RE.test(element.name)) return true;
  return false;
}

export class RecordAgent {
  private readonly planner: Planner;
  private readonly maxTurns: number;
  private readonly maxSteps: number;
  private readonly staleThreshold: number;
  private readonly onMilestone?: (m: string, i: number, total: number) => Promise<boolean>;
  private readonly resumeHint?: string;
  private readonly skeleton?: import("./site-memory.js").Skeleton;
  private readonly onEvent?: (e: RecordAgentEvent) => void;
  private readonly doneChecker: DoneChecker;
  private readonly variables: Record<string, string>;

  constructor(
    llm: LLMClient,
    private readonly driver: RecordingDriver,
    options: RecordAgentOptions = {},
  ) {
    this.planner = new Planner(llm);
    this.maxTurns = options.maxTurns ?? 20;
    this.maxSteps = options.maxSteps ?? 80;
    this.staleThreshold = options.staleThreshold ?? 3;
    this.onMilestone = options.onMilestone;
    this.resumeHint = options.resumeHint;
    this.skeleton = options.skeleton;
    this.onEvent = options.onEvent;
    this.doneChecker = options.doneChecker ?? new HappyPathDoneChecker();
    this.variables = options.variables ?? {};
  }

  async record(query: string, testName: string): Promise<RecordResult> {
    // Variables (from a JSON config) seed the planner's slots ahead of any
    // values detected in the query itself, so the LLM reuses them instead of
    // inventing literals each turn. Explicit query values still win per kind.
    const extracted = extractQuerySlots(query);
    const variableSlots: QuerySlot[] = Object.entries(this.variables).map(
      ([name, defaultValue]) => ({ name: name as SlotKind, kind: name as SlotKind, defaultValue }),
    );
    const querySlots: QuerySlot[] = [
      ...variableSlots,
      ...extracted.slots.filter((s) => !(s.kind in this.variables)),
    ];
    const canonicalQuery = extracted.canonicalQuery;
    const history: Array<{ snapshot: SnapshotPayload; plan: PlanTurn }> = [];
    const replanHints: ReplanHint[] = [];
    let milestones: string[] | undefined;
    let steps = 0;
    let llmCalls = 0;
    let backtracks = 0;
    let guardFires = 0;
    let consecutiveStale = 0;
    let sig: string | null = null;
    let lastError: string | null = null;
    let lastMilestone: string | undefined;
    // Whether the previous turn clicked a submit-like button. Checked at the
    // start of the next turn: if the page changed since then, the form was
    // submitted — stop before another LLM call.
    let lastTurnSubmitClicked = false;
    // Consecutive turns whose batch aborted on an execution error. Mirrors
    // browser-use's max_failures cap: stop looping instead of burning turns.
    let consecutiveBacktracks = 0;

    // seed resume hint (QF-56 re-record after a dry-run failure)
    const initialLastError = this.resumeHint
      ? `RESUME after previous failure: ${this.resumeHint}`
      : null;

    // browser-use-inspired turn budget (maxTurns): warn the LLM at 75% and
    // force a conclusion on the final turn so recording never drags on.
    const budgetWarnTurn = Math.floor(this.maxTurns * 0.75);
    const lastTurn = this.maxTurns - 1;
    const backtrackLimit = 3;

    const result = (): RecordResult => ({
      ok: false,
      testName,
      turns: resultTurns,
      steps,
      llmCalls,
      backtracks,
      guardFires,
      replanHints,
      milestones,
    });
    let resultTurns = 0;

    // Conclude recording: emit a done plan event and persist the recorded test.
    // Used by auto-done (submit detected) and forced-done (budget/loop guard).
    const finish = async (hint: string): Promise<RecordResult> => {
      this.onEvent?.({
        type: "plan",
        turn: resultTurns - 1,
        actions: [],
        done: true,
        hint,
      });
      const saved = await this.driver.saveTest(testName, {
        query,
        normalizedQuery: canonicalQuery,
        description: `Recorded from query: ${query}`,
        extraSlots: querySlots as QuerySlot[] as RecordedSlot[],
      });
      return { ...result(), ok: true, testId: saved.id };
    };

    for (let turn = 0; turn < this.maxTurns; turn++) {
      resultTurns = turn + 1;
      const snapshot = await this.driver.snapshot();

      // loop guard (QF-52): stale page signature => likely repeating an element.
      const currentSig = await this.driver.signature();
      if (sig !== null) {
        if (currentSig === sig) {
          consecutiveStale++;
          if (consecutiveStale >= this.staleThreshold) {
            const hint: ReplanHint = {
              turn: turn + 1,
              reason: "stale_signature",
              hint: `page signature unchanged for ${consecutiveStale} turn(s); the last plan likely repeats an element. Re-plan with a different approach.`,
            };
            replanHints.push(hint);
            guardFires++;
            lastError = `LOOP GUARD: page signature unchanged for ${consecutiveStale} turn(s). ${hint.hint}`;
            // Escalate (browser-use loop-detection style): after several stale
            // turns, tell the LLM it may conclude rather than keep re-planning.
            if (consecutiveStale >= this.staleThreshold + 2) {
              lastError += ` This has persisted for many turns — if you cannot make further progress on this page, emit "done":true to conclude.`;
            }
            this.onEvent?.({ type: "guard", turn: turn + 1, reason: lastError });
          }
        } else {
          consecutiveStale = 0;
        }
      }

      // Auto-done (submit): the previous turn clicked a submit-like button and
      // the page changed since that turn — the form was submitted. Save the
      // test immediately instead of planning another turn (which would otherwise
      // loop for many more turns before the LLM emits done:true).
      if (lastTurnSubmitClicked && sig !== null && currentSig !== sig) {
        return await finish("auto-done: submit button clicked and page changed");
      }

      sig = currentSig;

      // Compose prompt context (browser-use budget nudges): last error, plus a
      // wrap-up warning at 75% of the turn budget and a hard "must finish" note
      // on the final turn.
      const contextMessages: string[] = [];
      if (turn === 0 && initialLastError) contextMessages.push(initialLastError);
      if (lastError) contextMessages.push(lastError);
      if (turn >= budgetWarnTurn) {
        contextMessages.push(
          `TURN BUDGET WARNING: you are at turn ${turn + 1}/${this.maxTurns}. Consolidate — if the goal is achieved or nearly so, emit "done":true now and stop. Do not plan further exploration.`,
        );
      }
      if (turn === lastTurn) {
        contextMessages.push(
          `FINAL TURN: this is your last allowed turn. You MUST emit "done":true now — either because the goal is complete, or to report the recorded state and stop. No further turns will follow.`,
        );
      }
      const promptError = contextMessages.length > 0 ? contextMessages.join("\n") : undefined;

      let ask: AskPlanResult;
      try {
        ask = await this.planner.askPlan({
          query,
          normalizedQuery: canonicalQuery,
          slots: querySlots,
          snapshot,
          milestones: turn === 0 ? undefined : milestones,
          history,
          lastError: promptError ?? undefined,
        });
      } catch (e) {
        if (e instanceof PlanParseError) {
          return { ...result(), ok: false, error: e.message };
        }
        return { ...result(), ok: false, error: `planner error: ${e instanceof Error ? e.message : String(e)}` };
      }
      llmCalls += ask.attempts;

      if (turn === 0) {
        milestones = ask.plan.milestones;
        this.onEvent?.({ type: "milestones", turn, milestones: ask.plan.milestones ?? [] });
      }
      this.onEvent?.({
        type: "plan",
        turn,
        actions: ask.plan.actions,
        done: ask.plan.done,
        currentMilestone: ask.plan.currentMilestone,
        hint: ask.plan.hint,
      });

      if (turn === 0) {
        if (!milestones || milestones.length === 0) {
          return { ...result(), ok: false, error: "planner did not emit milestones on the first turn" };
        }
      }

      // QF-55 confirm mode: prompt at each milestone boundary.
      if (this.onMilestone && ask.plan.currentMilestone && ask.plan.currentMilestone !== lastMilestone) {
        const milestonesTotal = milestones?.length ?? 0;
        const idx = (milestones?.indexOf(ask.plan.currentMilestone) ?? -1) + 1;
        const proceed = await this.onMilestone(ask.plan.currentMilestone, idx, milestonesTotal);
        lastMilestone = ask.plan.currentMilestone;
        if (!proceed) {
          return { ...result(), ok: false, error: `aborted by user at milestone: ${ask.plan.currentMilestone}` };
        }
      }
      history.push({ snapshot, plan: ask.plan });

      // QF-56: an execution error mid-batch aborts the batch (a "backtrack")
      // and re-plans next turn with the error context.
      let aborted = false;
      let submitClicked = false;
      let containsClick = false;
      let lastClick: { role: string; name: string } | undefined;
      for (const action of ask.plan.actions) {
        if (steps >= this.maxSteps) {
          return { ...result(), ok: false, error: `step budget (${this.maxSteps}) reached before goal` };
        }
        if (action.type === "click") containsClick = true;
        try {
          await this.execute(action, snapshot, querySlots);
          // A successful click on a submit-like element marks this turn as a
          // potential form submission (checked for auto-done below/next turn);
          // the last clicked element feeds the happy-path done-checker.
          if (action.type === "click") {
            const el = this.resolveRef(action.ref, snapshot);
            lastClick = { role: el.role, name: el.name };
            if (isSubmitLike(el)) submitClicked = true;
          }
          this.onEvent?.({ type: "step", turn, stepIndex: steps, action, ok: true });
        } catch (e) {
          lastError = `execution error: ${e instanceof Error ? e.message : String(e)}`;
          this.onEvent?.({ type: "step", turn, stepIndex: steps, action, ok: false, error: lastError });
          this.onEvent?.({ type: "error", turn, error: lastError });
          backtracks++;
          consecutiveBacktracks++;
          aborted = true;
          break; // abort batch, re-plan next turn
        }
        steps++;
        if (action.type === "navigate") break; // never batch across a page-load boundary (QF-51)
      }

      // browser-use max_failures cap: stop looping after consecutive execution
      // failures instead of burning the whole turn budget re-planning.
      if (consecutiveBacktracks >= backtrackLimit) {
        return {
          ...result(),
          ok: false,
          error: `stopped after ${backtrackLimit} consecutive execution failures`,
        };
      }
      if (!aborted) consecutiveBacktracks = 0;

      if (ask.plan.done && !aborted) {
        const saved = await this.driver.saveTest(testName, {
          query,
          normalizedQuery: canonicalQuery,
          description: `Recorded from query: ${query}`,
          extraSlots: querySlots as QuerySlot[] as RecordedSlot[],
        });
        return { ...result(), ok: true, testId: saved.id };
      }

      // Happy-path done (browser-use style): after a click batch executes and
      // the page visibly changed, consult the done-checker (rules first, LLM
      // fallback in production) to see whether the task is complete — so we
      // can conclude without another planning turn. Rules-only by default.
      if (containsClick && !aborted && !ask.plan.done) {
        await this.driver.wait(800);
        const postSig = await this.driver.signature();
        const pageChanged = postSig !== sig;
        if (pageChanged) {
          const postSnapshot = await this.driver.snapshot();
          const decision = await this.doneChecker.check({
            query,
            steps: this.driver.getSteps(),
            snapshot: postSnapshot,
            pageChanged,
            submitted: submitClicked,
            lastClick,
          });
          if (decision.done) {
            if (decision.attempts) llmCalls += decision.attempts;
            const reason = decision.reason ? `: ${decision.reason}` : "";
            return await finish(`happy-path done (${decision.source ?? "rule"})${reason}`);
          }
        }
      }

      // Forced-done (browser-use style): if the recording has made progress and
      // we've hit the final turn OR the page has been stale for several guard
      // fires, conclude with what was recorded rather than looping further.
      if (steps > 0 && (turn === lastTurn || consecutiveStale >= this.staleThreshold + 2)) {
        const reason =
          turn === lastTurn
            ? `final turn reached (${this.maxTurns}/${this.maxTurns})`
            : `page unchanged for ${consecutiveStale} turns`;
        return await finish(`forced done: ${reason} — concluding recording with ${steps} step(s)`);
      }

      lastTurnSubmitClicked = submitClicked;
    }

    return { ...result(), ok: false, error: `goal not reached after ${this.maxTurns} turns` };
  }

  private resolveRef(ref: number, snapshot: SnapshotPayload): SnapshotElement {
    const el = snapshot.elements[ref - 1];
    if (!el) {
      throw new StepExecutionError(
        { type: "click", ref } as Action,
        new Error(`ref ${ref} not found in current snapshot`),
      );
    }
    return el;
  }

  /** Substitutes "{slotName}" placeholders with a slot's default value (from the
   *  query or the variables config); returns literals unchanged. */
  private resolveSlotValue(value: string, slots: QuerySlot[]): string {
    const m = /^\{([^}]+)\}$/.exec(value);
    if (!m) return value;
    const slot = slots.find((s) => s.kind === m[1] || s.name === m[1]);
    return slot ? slot.defaultValue : value;
  }

  private async execute(action: Action, snapshot: SnapshotPayload, querySlots: QuerySlot[]): Promise<void> {
    switch (action.type) {
      case "navigate":
        await this.driver.navigate(action.url);
        return;
      case "click":
        await this.driver.click(this.resolveRef(action.ref, snapshot).ref);
        return;
      case "fill": {
        const value = this.resolveSlotValue(action.value, querySlots);
        await this.driver.fill(this.resolveRef(action.ref, snapshot).ref, value);
        return;
      }
      case "select":
        await this.driver.select(this.resolveRef(action.ref, snapshot).ref, this.resolveSlotValue(action.value, querySlots));
        return;
      case "scroll":
        if (action.ref) await this.driver.scroll(this.resolveRef(action.ref, snapshot).ref);
        else await this.driver.scroll();
        return;
      case "wait":
        await this.driver.wait(action.ms);
        return;
      case "assert":
        await this.runAssert(action, snapshot);
        return;
      case "extract":
        await this.driver.extract(this.resolveRef(action.ref, snapshot).ref, action.name);
        return;
    }
  }

  private async runAssert(action: AssertAction, snapshot: SnapshotPayload): Promise<void> {
    switch (action.kind) {
      case "url":
        await this.driver.assertUrl(action.value as string);
        return;
      case "visible":
        await this.driver.assertVisible(this.resolveRef(action.ref as number, snapshot).ref);
        return;
      case "text":
        await this.driver.assertText(
          this.resolveRef(action.ref as number, snapshot).ref,
          action.value as string,
        );
        return;
    }
  }
}

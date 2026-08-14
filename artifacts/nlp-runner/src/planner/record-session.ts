/**
 * RecordSession — the QF-54 quality-gate orchestrator.
 *
 * Wraps `RecordAgent` with the gates required by the story:
 *  - QF-55 confirm mode (human y/n at each milestone; auto/known-domain skips).
 *  - QF-56 dry-run replay gate before caching; on failure, re-record from the
 *        failing step up to `maxDryRunAttempts` (default 2); persistent
 *        failure => no test cached, error explains why.
 *  - QF-57 macro minimizer (drop steps whose removal still passes dry-run).
 *  - QF-58 record report with full metrics.
 *  - QF-59 site-memory seeding/transfer + `clear`.
 *
 * Deps (`DriverFactory`, `DryRunGate`, `LLMClient`) are injected so every gate
 * is unit-testable without a browser; the real CLI wires headless Chrome + the
 * `ReplayRunner` dry-run gate.
 */
import type { Page } from "../browser/session.js";
import type { DataStore } from "../cache/queries.js";
import type { NewStep, Step, StepAction, Test, TestWithSteps, Slot } from "../cache/types.js";
import type { LLMClient } from "../llm/client.js";
import type { RecordingDriver, RecordAgentOptions, RecordResult } from "./agent.js";
import { RecordAgent } from "./agent.js";
import { HappyPathDoneChecker } from "./done-checker.js";
import {
  seedSiteMemory,
  getSkeleton,
  clearSiteMemory,
  type Skeleton,
} from "./site-memory.js";
import { hashSteps } from "../recorder/recorder.js";
import type { RecordedStep, RecordedSlot } from "../recorder/recorder.js";

export interface DryRunResult {
  success: boolean;
  error?: string;
  failingStep?: number;
  failingIntent?: string;
}

export interface DryRunGate {
  dryRun(
    test: TestWithSteps,
    opts?: { variables?: Record<string, string>; timeoutMs?: number },
  ): Promise<DryRunResult>;
  /** Release the gate's browser session (idempotent). */
  close(): Promise<void>;
}

export interface DriverBundle {
  driver: RecordingDriver;
  page: Page;
  close(): Promise<void>;
}

export interface DriverFactory {
  create(): Promise<DriverBundle>;
}

export interface RecordSessionOptions {
  /** QF-55 */
  confirm?: (milestone: string, index: number, total: number) => Promise<boolean>;
  auto?: boolean;
  /** QF-56 */
  dryRun?: boolean;
  maxDryRunAttempts?: number;
  /** QF-57 */
  minimize?: boolean;
  minimizeKinds?: StepAction[];
  /** slot variables to apply during dry-run */
  variables?: Record<string, string>;
  /** QF-59: known target site (origin+path root) for memory seeding/transfer. */
  site?: string;
  /** QF-61: starting URL to navigate the recorder to before planning, used when
   *  the query contains no URL of its own (avoids an ungrounded first action). */
  entryUrl?: string;
  /** SSE streaming hook: forwarded to the underlying RecordAgent. */
  onEvent?: (event: import("./agent.js").RecordAgentEvent) => void;
}

export interface RecordReport {
  testName: string;
  query: string;
  cached: boolean;
  milestones: string[];
  metrics: RecordMetrics;
  dryRun: { passed: boolean; attempts: number; error?: string };
  minimized: { before: number; after: number };
  error?: string;
}

export interface RecordOutcome {
  ok: boolean;
  testId?: number;
  report: RecordReport;
}

const DEFAULT_MINIMIZE_KINDS: StepAction[] = ["wait", "scroll", "extract", "assert"];

export class RecordSession {
  private readonly llm: LLMClient;
  private readonly store: DataStore;
  private readonly factory: DriverFactory;
  private readonly gate: DryRunGate;
  private readonly opts: Required<
    Pick<
      RecordSessionOptions,
      "dryRun" | "maxDryRunAttempts" | "minimize" | "minimizeKinds" | "variables" | "site" | "entryUrl"
    >
  > &
    Pick<RecordSessionOptions, "confirm" | "auto" | "onEvent">;

  constructor(llm: LLMClient, store: DataStore, factory: DriverFactory, gate: DryRunGate, options: RecordSessionOptions = {}) {
    this.llm = llm;
    this.store = store;
    this.factory = factory;
    this.gate = gate;
    this.opts = {
      dryRun: options.dryRun !== false,
      maxDryRunAttempts: options.maxDryRunAttempts ?? 2,
      minimize: options.minimize !== false,
      minimizeKinds: options.minimizeKinds ?? DEFAULT_MINIMIZE_KINDS,
      variables: options.variables ?? {},
      site: options.site ?? "",
      entryUrl: options.entryUrl ?? "",
      confirm: options.confirm,
      auto: options.auto ?? false,
      onEvent: options.onEvent,
    };
  }

  async record(query: string, testName: string): Promise<RecordOutcome> {
    try {
      return await this.recordFlow(query, testName);
    } finally {
      // The dry-run gate owns a browser session it lazily spawned; make sure
      // every record path (success, re-record, abort) releases it.
      await this.gate.close();
    }
  }

  private async recordFlow(query: string, testName: string): Promise<RecordOutcome> {
    const skeleton: Skeleton | null = this.opts.site ? getSkeleton(this.store, this.opts.site) : null;
    const resumeHint = skeleton
      ? `reuse skeleton from test #${skeleton.testId} (${skeleton.stepCount} steps, slots ${skeleton.slotKinds.join(",")})`
      : undefined;

    let lastDryRunError: string | undefined;
    let attempt = 0;
    let result: RecordResult | undefined;
    let testId: number | undefined;
    let driver: DriverBundle | undefined;

    for (attempt = 1; attempt <= this.opts.maxDryRunAttempts; attempt++) {
      const bundle = await this.factory.create();
      driver = bundle;
      // QF-61: prime the recorder with a known starting URL when the query
      // gives no URL of its own, so the agent's first plan is grounded.
      if (this.opts.entryUrl) {
        await bundle.driver.navigate(this.opts.entryUrl);
      }
      const agentOpts: RecordAgentOptions = {
        staleThreshold: 3,
        onMilestone: this.opts.confirm && !this.opts.auto ? (m, i, t) => this.opts.confirm!(m, i, t) : undefined,
        resumeHint: attempt > 1 ? lastDryRunError : resumeHint,
        onEvent: this.opts.onEvent,
        // happy-path done checking (browser-use style): rules first, LLM
        // fallback — concludes the record right after the completion click.
        doneChecker: new HappyPathDoneChecker(this.llm),
        // the same variables JSON used for dry-run replay also seeds the
        // planner's slots, so the LLM fills from them instead of inventing values.
        variables: this.opts.variables,
      };
      const agent = new RecordAgent(this.llm, bundle.driver, agentOpts);
      result = await agent.record(query, testName);
      testId = result.testId;
      await bundle.close();
      if (!result.ok) {
        return this.fail({ testName, query }, result, { passed: false, attempts: attempt, error: result.error });
      }
      if (!this.opts.dryRun) break;

      const test = this.store.getTestWithSteps(testId!);
      if (!test) {
        return this.fail(
          { testName, query },
          result,
          { passed: false, attempts: attempt, error: `test #${testId} not found after save` },
        );
      }
      const dr = await this.gate.dryRun(test, { variables: this.opts.variables });
      if (dr.success) {
        // minimize, then cache
        const minimized = await this.minimize(test, result);
        const saved = this.store.getTestWithSteps(testId!);
        // QF-59: seed site memory from the cached, minimized test
        if (this.opts.site && saved) {
          const storeSlots = this.store.listSlotsByTest(testId!);
          seedSiteMemory(this.store, saved, saved.steps, storeSlots, result.milestones ?? []);
        }
        return {
          ok: true,
          testId,
          report: {
            testName,
            query,
            cached: true,
            milestones: result.milestones ?? [],
            metrics: result,
            dryRun: { passed: true, attempts: attempt },
            minimized,
          },
        };
      }
      lastDryRunError = dr.error ?? "dry-run replay failed";
      // don't cache a test that doesn't replay; drop it and re-record
      this.store.deleteTest(testId!);
      driver = undefined;
    }

    // persistent dry-run failure
    return {
      ok: false,
      report: this.failBase({ testName, query }, result, {
        passed: false,
        attempts: this.opts.maxDryRunAttempts,
        error: `dry-run failed after ${this.opts.maxDryRunAttempts} attempts: ${lastDryRunError}`,
      }),
    };
  }

  private async minimize(test: TestWithSteps, rec: RecordResult): Promise<{ before: number; after: number }> {
    if (!this.opts.minimize) return { before: test.steps.length, after: test.steps.length };
    const removable = new Set(this.opts.minimizeKinds);
    const steps = test.steps;
    const kept: Step[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (removable.has(step.action) && kept.length + (steps.length - i - 1) >= 0) {
        // tentatively drop `step`; dry-run everything we keep so far + the rest
        const candidate = { ...test, steps: [...kept, ...steps.slice(i + 1)] };
        const dr = await this.gate.dryRun(candidate, { variables: this.opts.variables });
        if (dr.success) {
          continue; // drop it
        }
      }
      kept.push(step);
    }
    const before = test.steps.length;
    const after = kept.length;
    if (after < before) {
      this.store.replaceSteps(test.id, {
        stepHash: hashSteps(kept as RecordedStep[]),
        steps: kept as NewStep[],
      });
    }
    return { before, after };
  }

  private fail(
    base: { testName: string; query: string },
    rec: RecordResult | undefined,
    dryRun: { passed: boolean; attempts: number; error?: string },
  ): RecordOutcome {
    return { ok: false, report: this.failBase(base, rec, dryRun) };
  }

  private failBase(
    base: { testName: string; query: string },
    rec: RecordResult | undefined,
    dryRun: { passed: boolean; attempts: number; error?: string },
  ): RecordReport {
    return {
      testName: base.testName,
      query: base.query,
      cached: false,
      milestones: rec?.milestones ?? [],
      metrics: rec ?? emptyMetrics(),
      dryRun,
      minimized: { before: rec?.steps ?? 0, after: rec?.steps ?? 0 },
      error: dryRun.error,
    };
  }

  /** QF-59: seed / clear site memory. */
  seedMemory(test: Test, steps: Step[], slots: Array<Pick<Slot, 'kind' | 'defaultValue'>>, milestones: string[]): void {
    seedSiteMemory(this.store, test, steps, slots as Slot[], milestones);
  }
  clearMemory(): number {
    return this.opts.site ? clearSiteMemory(this.store, this.opts.site) : clearSiteMemory(this.store);
  }
}

function emptyMetrics(): RecordResult {
  return {
    ok: false,
    testName: "",
    turns: 0,
    steps: 0,
    llmCalls: 0,
    backtracks: 0,
    guardFires: 0,
    replanHints: [],
  };
}

type RecordMetrics = Omit<RecordResult, "ok" | "testName" | "testId" | "error" | "milestones">;
type NewStepBag = Step[];

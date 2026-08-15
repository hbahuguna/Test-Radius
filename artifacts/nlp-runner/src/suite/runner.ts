import { join } from "node:path";
import type { Page } from "../browser/session.js";
import type { DataStore } from "../cache/queries.js";
import type {
  SuiteMode,
  SuiteRun,
  TestWithSteps,
  TrainRun,
} from "../cache/types.js";
import { ReplayRunner, type ReplayOptions, type ReplayResult } from "../replay/engine.js";
import type { StepHealer } from "../replay/heal.js";
import { Semaphore } from "../util/concurrency.js";

export type StepStatus = "passed" | "failed" | "skipped";

/** Resolve a run's execution mode from its members' per-member parallel flags. */
export function resolveMode(members: readonly { parallel: boolean }[]): SuiteMode {
  const hasParallel = members.some((m) => m.parallel);
  const hasSequential = members.some((m) => !m.parallel);
  if (hasParallel && hasSequential) return "mixed";
  return hasParallel ? "parallel" : "sequential";
}

/**
 * Partition ordered members into execution groups. A suite/train is a sequence
 * of groups: a member with `parallel: false` is its own group of one; runs of
 * consecutive `parallel: true` members form a single parallel group. Groups
 * execute strictly one after another, so a parallel group behaves as one unit
 * placed inside the surrounding sequence.
 */
export function partitionIntoGroups<T>(members: readonly T[], isParallel: (member: T) => boolean): T[][] {
  const groups: T[][] = [];
  let parallelGroup: T[] | null = null;
  for (const member of members) {
    if (isParallel(member)) {
      (parallelGroup ??= []).push(member);
    } else {
      if (parallelGroup !== null) {
        groups.push(parallelGroup);
        parallelGroup = null;
      }
      groups.push([member]);
    }
  }
  if (parallelGroup !== null) groups.push(parallelGroup);
  return groups;
}

export interface SuiteStepEvent {
  type: "step";
  suiteRunId: number;
  testId: number;
  runId: number;
  idx: number;
  status: StepStatus;
  intent: string;
  detail: Record<string, unknown>;
}

export interface SuiteTestDoneEvent {
  type: "test-done";
  suiteRunId: number;
  testId: number;
  runId: number;
  success: boolean;
  error?: string;
}

export interface SuiteDoneEvent {
  type: "suite-done";
  suiteRunId: number;
  success: boolean;
  error?: string;
}

export type SuiteRunnerEvent = SuiteStepEvent | SuiteTestDoneEvent | SuiteDoneEvent;

export interface TrainStepEvent extends SuiteStepEvent {
  trainRunId: number;
}
export interface TrainTestDoneEvent extends SuiteTestDoneEvent {
  trainRunId: number;
}
export interface TrainSuiteDoneEvent extends SuiteDoneEvent {
  trainRunId: number;
}
export interface TrainSuiteStartEvent {
  type: "suite-start";
  trainRunId: number;
  suiteRunId: number;
  suiteId: number;
  suiteName: string;
}
export interface TrainDoneEvent {
  type: "done";
  trainRunId: number;
  success: boolean;
  error?: string;
}

export type TrainRunnerEvent =
  | TrainSuiteStartEvent
  | TrainStepEvent
  | TrainTestDoneEvent
  | TrainSuiteDoneEvent
  | TrainDoneEvent;

export interface BrowserHandle {
  page: Page;
  close: () => Promise<void>;
}

export interface SuiteRunnerOptions {
  /** Headless browser factory; one handle (page + teardown) is used per test run. */
  launch: () => Promise<BrowserHandle>;
  /** Root directory for suite-run screenshots; per-test subdirs are created under it. */
  screenshotBaseDir: string;
  /** Max concurrently running tests for `parallel` suites. */
  concurrency: number;
  /** Optional self-healer shared across member test runs. */
  healer?: StepHealer;
}

export interface RunSuiteInput {
  variables?: Record<string, string>;
  onEvent?: (event: SuiteRunnerEvent) => void;
  signal?: AbortSignal;
  /** Use a caller-created suite-run row (train runs pre-create it to learn the id). */
  suiteRunId?: number;
  /** Test override for unit tests; defaults to a browser-backed ReplayRunner. */
  runTestFn?: RunTestFn;
}

export type RunTestFn = (
  test: TestWithSteps,
  suiteRunId: number,
  screenshotDir: string,
  onEvent: (event: SuiteStepEvent) => void,
  signal?: AbortSignal,
) => Promise<ReplayResult>;

const aborted = (reason: unknown): Error =>
  new Error(reason instanceof Error ? reason.message : String(reason));

export class SuiteRunner {
  private readonly store: DataStore;

  constructor(
    store: DataStore,
    private readonly options: SuiteRunnerOptions,
  ) {
    this.store = store;
  }

  async runSuite(suiteId: number, input: RunSuiteInput = {}): Promise<SuiteRun> {
    const suite = this.store.getSuiteWithTests(suiteId);
    if (!suite) throw new Error(`No suite with id ${suiteId}`);
    if (suite.tests.length === 0) {
      throw new Error(`Suite "${suite.name}" has no tests`);
    }
    const onEvent = input.onEvent;
    const signal = input.signal;
    const mode = resolveMode(suite.tests);
    const suiteRun =
      input.suiteRunId !== undefined
        ? this.store.getSuiteRun(input.suiteRunId)!
        : this.store.createSuiteRun({ suiteId, status: "running", mode });
    const suiteScreenshotDir = join(this.options.screenshotBaseDir, String(suiteRun.id));

    const runOne = async (test: TestWithSteps): Promise<void> => {
      if (signal?.aborted) throw aborted(signal.reason);
      const result = await (input.runTestFn ?? this.defaultRunTest)(
        test,
        suiteRun.id,
        join(suiteScreenshotDir, String(test.id)),
        (event) => onEvent?.({ ...event, suiteRunId: suiteRun.id }),
        signal,
      );
      onEvent?.({
        type: "test-done",
        suiteRunId: suiteRun.id,
        testId: test.id,
        runId: result.runId,
        success: result.success,
        error: result.error,
      });
    };

    const fail = (err: unknown): SuiteRun => {
      const message = err instanceof Error ? err.message : String(err);
      this.store.finishSuiteRun(suiteRun.id, "failed", message);
      const done = this.store.getSuiteRun(suiteRun.id)!;
      onEvent?.({ type: "suite-done", suiteRunId: done.id, success: false, error: message });
      return done;
    };

    try {
      // The suite is a sequence of groups. A parallel group's members run
      // concurrently (capped); each group must fully complete before the next
      // group in the sequence starts.
      const semaphore = new Semaphore(this.options.concurrency);
      const groups = partitionIntoGroups(suite.tests, (st) => st.parallel);
      for (const group of groups) {
        if (signal?.aborted) throw aborted(signal.reason);
        const tests = group.map((st) => {
          const test = this.store.getTestWithSteps(st.testId);
          if (!test) throw new Error(`Test #${st.testId} not found`);
          return test;
        });
        const settled = await Promise.allSettled(tests.map((test) => semaphore.run(() => runOne(test))));
        const firstError = settled.find((r) => r.status === "rejected")?.reason;
        if (firstError !== undefined) return fail(firstError);
      }
    } catch (err) {
      return fail(err);
    }

    const failed = this.failedCount(suiteRun.id) > 0;
    this.store.finishSuiteRun(suiteRun.id, failed ? "failed" : "passed");
    const done = this.store.getSuiteRun(suiteRun.id)!;
    onEvent?.({ type: "suite-done", suiteRunId: done.id, success: !failed });
    return done;
  }

  private defaultRunTest: RunTestFn = async (test, suiteRunId, screenshotDir, onEvent, signal) => {
    const handle = await this.options.launch();
    try {
      const runner = new ReplayRunner(handle.page);
      const replayOptions: ReplayOptions = {
        screenshotDir,
        healer: this.options.healer,
        completionHint: test.completionHint ?? undefined,
        suiteRunId,
        signal,
        onEvent: (event) => {
          if (event.type !== "step") return;
          onEvent({
            type: "step",
            suiteRunId,
            testId: test.id,
            runId: event.runId ?? 0,
            idx: event.idx,
            status: event.status,
            intent: event.intent,
            detail: event.detail,
          });
        },
      };
      return await runner.runTest(this.store, test, replayOptions);
    } finally {
      await handle.close().catch(() => {});
    }
  };

  private failedCount(suiteRunId: number): number {
    const run = this.store.getSuiteRunWithRuns(suiteRunId);
    return run?.runs.filter((r) => r.status === "failed").length ?? 0;
  }
}

export interface RunTrainInput {
  onEvent?: (event: TrainRunnerEvent) => void;
  signal?: AbortSignal;
  /** Test override forwarded to each suite run (unit tests). */
  runTestFn?: RunTestFn;
}

export class TrainRunner {
  private readonly store: DataStore;

  constructor(
    store: DataStore,
    private readonly suiteRunner: SuiteRunner,
  ) {
    this.store = store;
  }

  async runTrain(trainId: number, input: RunTrainInput = {}): Promise<TrainRun> {
    const train = this.store.getTrainWithSuites(trainId);
    if (!train) throw new Error(`No train with id ${trainId}`);
    if (train.suites.length === 0) {
      throw new Error(`Train "${train.name}" has no suites`);
    }
    const trainRun = this.store.createTrainRun({ trainId, status: "running", mode: resolveMode(train.suites) });
    const onEvent = input.onEvent;
    const signal = input.signal;

    const runSuite = async (suiteId: number): Promise<void> => {
      const suite = this.store.getSuiteWithTests(suiteId);
      if (!suite) throw new Error(`Suite #${suiteId} not found`);
      if (signal?.aborted) throw aborted(signal.reason);

      const suiteRun = this.store.createSuiteRun({
        suiteId,
        status: "running",
        mode: resolveMode(suite.tests),
        trainRunId: trainRun.id,
      });
      onEvent?.({
        type: "suite-start",
        trainRunId: trainRun.id,
        suiteRunId: suiteRun.id,
        suiteId: suite.id,
        suiteName: suite.name,
      });

      const forward = (event: SuiteRunnerEvent): void => {
        // SuiteRunner already reports suite completion; TrainRunner emits its
        // own suite-done (with the linked suite-run id) after runSuite returns.
        if (event.type === "suite-done") return;
        onEvent?.({ ...event, trainRunId: trainRun.id } as TrainRunnerEvent);
      };

      const result = await this.suiteRunner.runSuite(suiteId, {
        suiteRunId: suiteRun.id,
        onEvent: forward,
        signal,
        runTestFn: input.runTestFn,
      });
      this.store.linkSuiteRunToTrain(result.id, trainRun.id);
      onEvent?.({
        type: "suite-done",
        trainRunId: trainRun.id,
        suiteRunId: result.id,
        success: result.status === "passed",
        error: result.error !== null ? String(result.error) : undefined,
      });
    };

    const fail = (err: unknown): TrainRun => {
      const message = err instanceof Error ? err.message : String(err);
      this.store.finishTrainRun(trainRun.id, "failed", message);
      return this.store.getTrainRun(trainRun.id)!;
    };

    try {
      // The train is a sequence of groups; parallel suites in a group run
      // concurrently (capped) and each group completes before the next starts.
      const semaphore = new Semaphore(this.trainConcurrency(train.suites.length));
      const groups = partitionIntoGroups(train.suites, (entry) => entry.parallel);
      for (const group of groups) {
        if (signal?.aborted) throw aborted(signal.reason);
        const settled = await Promise.allSettled(group.map((entry) => semaphore.run(() => runSuite(entry.suiteId))));
        const firstError = settled.find((r) => r.status === "rejected")?.reason;
        if (firstError !== undefined) return fail(firstError);
      }
    } catch (err) {
      return fail(err);
    }

    const suiteRuns = this.store.getTrainRunWithSuiteRuns(trainRun.id).suiteRuns;
    const abortedNow = signal?.aborted === true;
    const failed = abortedNow || suiteRuns.some((r) => r.status === "failed");
    const error = abortedNow ? aborted(signal?.reason).message : undefined;
    this.store.finishTrainRun(trainRun.id, failed ? "failed" : "passed", error);
    const done = this.store.getTrainRun(trainRun.id)!;
    onEvent?.({ type: "done", trainRunId: done.id, success: !failed, error });
    return done;
  }

  private trainConcurrency(suiteCount: number): number {
    return Math.max(1, Math.min(4, suiteCount));
  }
}

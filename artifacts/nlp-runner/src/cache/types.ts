export type TestSource = "nlp" | "recorder" | "template";

export interface Test {
  id: number;
  name: string;
  source: TestSource;
  query: string | null;
  normalizedQuery: string | null;
  queryEmbedding: Uint8Array | null;
  entryUrl: string | null;
  stepHash: string | null;
  description: string | null;
  /**
   * A short phrase (e.g. "Thanks for signing up") extracted from the
   * browser-use agent's done message at record time. During replay the engine
   * checks `document.body.innerText` for this phrase before each step; if
   * found, remaining steps are skipped and the run is marked as passed.
   */
  completionHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTest {
  name: string;
  source: TestSource;
  query?: string | null;
  normalizedQuery?: string | null;
  queryEmbedding?: Uint8Array | null;
  entryUrl?: string | null;
  stepHash?: string | null;
  description?: string | null;
  completionHint?: string | null;
}

export type StepAction =
  | "navigate"
  | "click"
  | "fill"
  | "select"
  | "scroll"
  | "assert"
  | "extract"
  | "wait"
  | "go_back";

export type WaitConditionKind = "url" | "element" | "signature" | "manual";

export interface WaitCondition {
  kind: WaitConditionKind;
  contains?: string;
  ref?: string;
  hash?: string;
  /** Pre-action page signature recorded alongside `hash`. When present, replay
   * accepts the wait as satisfied once the page moves off this state (the
   * action had an effect), since async rendering (mega-menus, tab panels)
   * rarely reproduces the exact recorded snapshot. */
  before?: string;
  timeoutMs?: number;
  pollMs?: number;
  desc?: string;
}

export interface Assertion {
  op: string;
  expected?: unknown;
  actual?: unknown;
}

export interface Step {
  id: number;
  testId: number;
  idx: number;
  action: StepAction;
  selector: string | null;
  value: string | null;
  locators: string[] | null;
  elementFingerprint: string | null;
  pageSignatureBefore: string | null;
  pageSignatureAfter: string | null;
  waitCondition: WaitCondition | null;
  assertion: Assertion | null;
  /**
   * When true, the replay engine skips this step gracefully (with a "skipped"
   * status) instead of failing when the target element is not found after the
   * full resolution timeout. Use for cookie banners, consent overlays, tour
   * modals, and any UI that only appears under certain browser state conditions.
   */
  optional?: boolean;
}

export interface NewStep {
  action: StepAction;
  selector?: string | null;
  value?: string | null;
  locators?: string[] | null;
  elementFingerprint?: string | null;
  pageSignatureBefore?: string | null;
  pageSignatureAfter?: string | null;
  waitCondition?: WaitCondition | null;
  assertion?: Assertion | null;
  optional?: boolean;
}

export type SlotKind = "email" | "name" | "number" | "text";

export interface Slot {
  id: number;
  testId: number;
  name: string;
  kind: SlotKind;
  defaultValue: string | null;
}

export interface NewSlot {
  name: string;
  kind: SlotKind;
  defaultValue?: string | null;
}

export type RunStatus = "running" | "passed" | "failed" | "skipped";

export interface Run {
  id: number;
  testId: number;
  status: RunStatus;
  llmCalls: number;
  startedAt: string;
  finishedAt: string | null;
  error: unknown | null;
  /** Grouping key for suite execution (nullable for standalone runs). */
  suiteRunId: number | null;
}

export interface NewRun {
  testId: number;
  status: RunStatus;
  llmCalls?: number;
  startedAt?: string;
  error?: unknown | null;
  suiteRunId?: number | null;
}

export type RunStepStatus = "passed" | "failed" | "skipped";

export interface RunStep {
  id: number;
  runId: number;
  stepId: number | null;
  idx: number;
  status: RunStepStatus;
  detail: unknown | null;
  createdAt: string;
}

export interface NewRunStep {
  stepId?: number | null;
  idx: number;
  status: RunStepStatus;
  detail?: unknown | null;
}

export interface TestVersion {
  id: number;
  testId: number;
  version: number;
  steps: unknown[];
  slots: unknown[];
  reason: string | null;
  createdAt: string;
}

export interface NewTestVersion {
  testId: number;
  version: number;
  steps: unknown[];
  slots: unknown[];
  reason?: string | null;
}

export interface SiteMemory {
  id: number;
  site: string;
  kind: string;
  key: string;
  value: unknown;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewSiteMemory {
  site: string;
  kind: string;
  key: string;
  value: unknown;
  confidence?: number;
}

export interface TestWithSteps extends Test {
  steps: Step[];
}

export interface RunWithSteps extends Run {
  steps: RunStep[];
}

// ----- suites & trains --------------------------------------------------------

/** Execution mode of a run; "mixed" when some members run parallel and others sequential. */
export type SuiteMode = "sequential" | "parallel" | "mixed";

/** Whether a suite groups UI (browser) tests or API (HTTP recording) sessions. */
export type SuiteType = "ui" | "api";

export interface Suite {
  id: number;
  name: string;
  description: string | null;
  mode: SuiteMode;
  type: SuiteType;
  createdAt: string;
  updatedAt: string;
}

export interface NewSuite {
  name: string;
  description?: string | null;
  mode?: SuiteMode;
  type?: SuiteType;
}

export interface NewSuiteTest {
  testId: number;
  position: number;
  /** Run this test concurrently with other parallel members (default sequential). */
  parallel?: boolean;
}

export interface SuiteTest {
  id: number;
  suiteId: number;
  testId: number;
  position: number;
  parallel: boolean;
}

export interface SuiteWithTests extends Suite {
  tests: SuiteTest[];
}

export interface SuiteApiSession {
  id: number;
  suiteId: number;
  sessionId: number;
  position: number;
}

export interface SuiteWithApiSessions extends Suite {
  apiSessions: SuiteApiSession[];
}

export interface Train {
  id: number;
  name: string;
  description: string | null;
  mode: SuiteMode;
  createdAt: string;
  updatedAt: string;
}

export interface NewTrain {
  name: string;
  description?: string | null;
  mode?: SuiteMode;
}

export interface NewTrainSuite {
  suiteId: number;
  position: number;
  /** Run this suite concurrently with other parallel members (default sequential). */
  parallel?: boolean;
}

export interface TrainSuite {
  id: number;
  trainId: number;
  suiteId: number;
  position: number;
  parallel: boolean;
}

export interface TrainWithSuites extends Train {
  suites: TrainSuite[];
}

export interface SuiteRun {
  id: number;
  suiteId: number;
  trainRunId: number | null;
  status: RunStatus;
  mode: SuiteMode;
  startedAt: string;
  finishedAt: string | null;
  error: unknown | null;
}

export interface NewSuiteRun {
  suiteId: number;
  status: RunStatus;
  mode: SuiteMode;
  startedAt?: string;
  error?: unknown | null;
  trainRunId?: number | null;
}

export interface TrainRun {
  id: number;
  trainId: number;
  status: RunStatus;
  mode: SuiteMode;
  startedAt: string;
  finishedAt: string | null;
  error: unknown | null;
}

export interface NewTrainRun {
  trainId: number;
  status: RunStatus;
  mode: SuiteMode;
  startedAt?: string;
  error?: unknown | null;
}

/** A suite run with its member test runs. */
export interface SuiteRunWithRuns extends SuiteRun {
  runs: Run[];
}

/** One page of run rows, newest first. `hasMore` is true when more rows exist. */
export interface PagedRuns<T> {
  runs: T[];
  hasMore: boolean;
}

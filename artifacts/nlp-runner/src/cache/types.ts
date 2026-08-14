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
}

export interface NewRun {
  testId: number;
  status: RunStatus;
  llmCalls?: number;
  startedAt?: string;
  error?: unknown | null;
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

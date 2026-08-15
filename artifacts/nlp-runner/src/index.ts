export { DataStore } from "./cache/queries.js";
export type { SaveTestInput, SaveTestResult } from "./cache/queries.js";
export { DB_FILENAME, journalMode, openDatabase, runMigrations } from "./cache/db.js";
export type { MigrationResult, OpenDatabaseOptions } from "./cache/db.js";
export { MIGRATIONS, SCHEMA_VERSION } from "./cache/schema.js";
export type { Migration } from "./cache/schema.js";
export {
  DEFAULT_EMBED_MODEL,
  EMBEDDING_DIM,
  bytesToEmbedding,
  embed,
  embedCached,
  embedMany,
  embedStats,
  embeddingDim,
  embeddingToBytes,
} from "./embeddings/embed.js";
export type { EmbedCacheStats } from "./embeddings/memoize.js";
export { cosine, createMatcher } from "./embeddings/matcher.js";
export type { Matcher, MatchOptions, MatchResult } from "./embeddings/matcher.js";
export { normalizeQuery, slotNormalize, detectQuerySlots } from "./embeddings/normalize.js";
export type { DetectedSlot, SlotKind as QuerySlotKind } from "./embeddings/normalize.js";
export { Recorder, hashSteps } from "./recorder/recorder.js";
export type { RecordedSlot, RecordedStep, RecorderOptions } from "./recorder/recorder.js";
export { detectSlot, detectSlotKind } from "./recorder/slots.js";
export { ReplayError, ReplayRunner, applyVariables } from "./replay/engine.js";
export type { ReplayOptions, ReplayResult, ReplayStepResult } from "./replay/engine.js";
export { LLMStepHealer, HealError } from "./replay/heal.js";
export type { StepHealer, HealResult } from "./replay/heal.js";
export { main as cliMain, parseRunArgs, resolveRunTarget, parseBrowseArgs, runBrowse } from "./cli.js";
export { stepToEnglish, describeLocator, renderChecklist } from "./util/describe.js";
export { resolveChromePath } from "./config.js";
export type { RunCommandArgs, BrowseCommandArgs, BrowseEvent } from "./cli.js";
export type {
  Assertion,
  NewRun,
  NewRunStep,
  NewSiteMemory,
  NewSlot,
  NewStep,
  NewSuite,
  NewSuiteTest,
  NewTest,
  NewTestVersion,
  NewTrain,
  NewTrainRun,
  NewSuiteRun,
  Run,
  RunStep,
  RunStatus,
  RunStepStatus,
  RunWithSteps,
  SiteMemory,
  Slot,
  SlotKind,
  Step,
  StepAction,
  Suite,
  SuiteMode,
  SuiteRun,
  SuiteRunWithRuns,
  SuiteTest,
  SuiteWithTests,
  Test,
  TestSource,
  TestVersion,
  TestWithSteps,
  Train,
  TrainRun,
  TrainSuite,
  TrainWithSuites,
  WaitCondition,
} from "./cache/types.js";
export * from "./config.js";
export { CdpClient, CdpError, connect } from "./browser/cdp.js";
export type { CdpEventHandler } from "./browser/cdp.js";
export { BrowserSession, ElementNotFoundError, EvaluationError, NavigationError, Page, WaitTimeoutError } from "./browser/session.js";
export type { AccessibilityNode, ElementLocation, PageInfo, ScreenshotOptions, WaitForOptions } from "./browser/session.js";
export {
  ChromeLaunchError,
  buildLaunchArgs,
  launch,
  parseDevToolsUrl,
} from "./browser/launch.js";
export type { LaunchedBrowser, LaunchOptions } from "./browser/launch.js";
export {
  MAX_NAME_CHARS,
  MAX_NAME_WORDS,
  summarizeTestName,
  summarizeTestNameFallback,
  uniqueTestName,
} from "./util/test-name.js";
export { mapWithConcurrency, Semaphore, type Settled } from "./util/concurrency.js";
export {
  SuiteRunner,
  TrainRunner,
  resolveMode,
  type RunSuiteInput,
  type RunTestFn,
  type RunTrainInput,
  type SuiteRunnerOptions,
  type BrowserHandle,
  type SuiteRunnerEvent,
  type SuiteStepEvent,
  type SuiteTestDoneEvent,
  type SuiteDoneEvent,
  type TrainRunnerEvent,
  type TrainStepEvent,
  type TrainTestDoneEvent,
  type TrainSuiteDoneEvent,
  type TrainSuiteStartEvent,
  type TrainDoneEvent,
  type StepStatus,
} from "./suite/runner.js";

// Live agent (PLAN-live-agent.md Phases 1–4).
export { LiveAgent } from "./live/agent.js";
export type { LiveAgentOptions } from "./live/agent.js";
export { ActionRegistry } from "./live/registry.js";
export {
  NAVIGATE,
  GO_BACK,
  CLICK,
  INPUT_TEXT,
  SCROLL,
  WAIT,
  OPEN_TAB,
  SWITCH_TAB,
  CLOSE_TAB,
  EXTRACT,
  FIND_TEXT,
  SCREENSHOT,
  EVALUATE,
  doneAction,
  builtinActions,
  registerBuiltins,
} from "./live/actions.js";
export { buildSystemPrompt } from "./live/system-prompt.js";
export { MessageManager } from "./live/message-manager.js";
export { ActionLoopDetector, PageFingerprint } from "./live/loop-detector.js";
export {
  captureDomSnapshot,
  collectDomSnippet,
  formatDom,
} from "./live/dom-snapshot.js";
export type {
  DomEntry,
  DomSnapshot,
  FormattedDom,
  CaptureDomOptions,
} from "./live/dom-snapshot.js";
export type {
  ActionResult,
  ActionCall,
  LiveContext,
  LiveTab,
  RegisteredAction,
} from "./live/types.js";
export {
  validateParams,
  toJsonSchema,
  describeActionParams,
} from "./live/schema.js";
export type { ActionParamsSchema, Params, ValidationResult, ParamSchema } from "./live/schema.js";
export type {
  AgentOutput,
  ParsedAction,
  AgentStepInfo,
  HistoryItem,
  BrowseResult,
  BrowseAgentEvent,
  MessageCompactionSettings,
} from "./live/views.js";
export { DEFAULT_COMPACTION } from "./live/views.js";

// A11y LLM planner (Story QF-48) — natural-language-driven recording.
export {
  Planner,
  PlanParseError,
  OpenAIChatClient,
  LLMError,
  RecordAgent,
  StepExecutionError,
  RecorderDriver,
  canonicalizeQuery,
  decideRun,
  refillVariables,
  disambiguatePrompt,
  extractStartUrl,
  extractQuerySlots,
  parsePlan,
  validateAction,
  formatSnapshot,
  buildSnapshot,
  RecordSession,
  BrowserDriverFactory,
  ReplayDryRunGate,
  runRecord,
  formatRecordReport,
  parseRecordArgs,
} from "./planner/index.js";
export type {
  RecordSessionOptions,
  RecordReport,
  RecordOutcome,
  DriverFactory,
  DriverBundle,
  DryRunGate,
  DryRunResult,
  RecordCliOptions,
} from "./planner/index.js";
export type { RecordAgentEvent } from "./planner/agent.js";
export type { ReplayEvent } from "./replay/engine.js";
export type {
  LLMClient,
  LLMMessage,
  LLMResult,
  LLMRole,
  LLMUsage,
  LLMChatOptions,
  OpenAIConfig,
  Action,
  ActionType,
  PlanTurn,
  AssertAction,
  QuerySlot,
  RunMode,
  RefillResult,
  SnapshotPayload,
  SnapshotElement,
  RecordingDriver,
  RecordResult,
  RecordAgentOptions,
  ReplanHint,
  PlannerOptions,
  AskPlanResult,
  HistoryEntry,
} from "./planner/index.js";

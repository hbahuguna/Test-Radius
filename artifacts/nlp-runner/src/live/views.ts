/**
 * Agent output / history / run types for the live agent
 * (PLAN-live-agent.md Phase 3) — a pragmatic port of browser-use
 * `agent/views.py` (`AgentBrain`, `AgentOutput`, `AgentStepInfo`,
 * `AgentHistory`, `MessageCompactionSettings`).
 */
import type { ActionCall, ActionResult } from "./types.js";

/** What the LLM emits each step (the `AgentBrain` fields + action list). */
export interface AgentOutput {
  thinking?: string;
  evaluation_previous_goal?: string;
  memory?: string;
  next_goal?: string;
  /** 0-indexed plan item being worked on (planning is optional in v1). */
  current_plan_item?: number;
  plan_update?: string[];
  action: ParsedAction[];
}

/**
 * A single action as emitted by the model. The wire form is
 * `[{ "navigate": { "url": "..." } }]` (browser-use `ActionModel` union),
 * but we normalize to `{ name, params }` (`ActionCall`) right after parsing
 * so the registry stays the single dispatch surface.
 */
export type ParsedAction = ActionCall;

/** Mirrors browser-use `AgentStepInfo`. */
export interface AgentStepInfo {
  stepNumber: number;
  maxSteps: number;
}

/** One entry in the agent history (browser-use `AgentHistory`). */
export interface HistoryItem {
  step: number;
  evaluationPreviousGoal: string;
  memory: string;
  nextGoal: string;
  actionResults: ActionResult[];
}

/** Result of a full `browse()` run (browser-use `AgentHistoryList` subset). */
export interface BrowseResult {
  success: boolean;
  finalText: string;
  steps: number;
  actions: number;
  urls: string[];
  screenshots: string[];
  durationMs: number;
  llmCalls: number;
  errors: string[];
}

export interface MessageCompactionSettings {
  enabled: boolean;
  /** Compact when history exceeds this many chars (floor). */
  triggerCharCount: number;
  /** Compact at most every N steps (cadence gate). */
  compactEveryNSteps: number;
  /** Keep this many most-recent items verbatim after compaction. */
  keepLastItems: number;
  summaryMaxChars?: number;
}

export const DEFAULT_COMPACTION: MessageCompactionSettings = {
  enabled: true,
  triggerCharCount: 40_000,
  compactEveryNSteps: 20,
  keepLastItems: 6,
  summaryMaxChars: 4000,
};

/**
 * Streaming events emitted by `LiveAgent.browse()` so callers (CLI, HTTP SSE
 * routes) can surface progress to the user in real time.
 */
export type BrowseAgentEvent =
  | {
      type: "step_start";
      step: number;
      maxSteps: number;
      thinking?: string;
      evaluation?: string;
      memory?: string;
      nextGoal?: string;
    }
  | {
      type: "action";
      step: number;
      actionIndex: number;
      name: string;
      params: Record<string, unknown>;
      ok: boolean;
      error?: string;
    }
  | { type: "guard"; step: number; message: string }
  | {
      type: "done";
      success: boolean;
      text: string;
      steps: number;
      actions: number;
      llmCalls: number;
      errors: string[];
    };
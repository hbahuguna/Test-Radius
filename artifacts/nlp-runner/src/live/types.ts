/**
 * Shared types for the browser-use-style live agent (PLAN-live-agent.md).
 */
import type { Page, BrowserSession } from "../browser/session.js";
import type { LLMClient } from "../llm/client.js";
import type { ActionParamsSchema } from "./schema.js";

/** Result of executing a single action, fed back to the LLM. */
export interface ActionResult {
  isDone: boolean;
  /** `success: true` is only meaningful with `isDone: true`. */
  success?: boolean;
  error?: string;
  extractedContent?: string;
  /** Content shown once in the next state message, then dropped. */
  includeExtractedContentOnlyOnce?: boolean;
  images?: { name: string; data: string }[];
  /** Long-term memory appended to the agent history (browser-use parity). */
  longTermMemory?: string;
}

/** What the LLM emitted for one action. */
export interface ActionCall {
  name: string;
  params: Record<string, unknown>;
}

export interface RegisteredAction<P = Record<string, unknown>> {
  name: string;
  description: string;
  /** Optional URL glob filter; action only offered on matching pages. */
  domains?: string[];
  /** Page-changing actions end the batch (browser-use `terminates_sequence`). */
  terminatesSequence: boolean;
  params: ActionParamsSchema;
  execute(ctx: LiveContext, params: P): Promise<ActionResult>;
}

/**
 * Everything a built-in action needs. `LiveAgent` implements this, wiring the
 * current focused page, the snapshot selector map, and multi-tab operations.
 */
export interface LiveContext {
  /** The currently focused page (last opened/switched/navigated tab). */
  page: Page;
  browserSession: BrowserSession;
  /** Optional LLM for `extract`/`find_text`-style semantic actions. */
  llm?: LLMClient;
  /** Resolve a DOM index from the latest snapshot to a CSS selector. */
  resolveSelector(index: number): string;
  /** Open a new tab (optionally at a URL) and focus it. */
  openTab(url?: string): Promise<void>;
  /** Focus an existing tab by its 4-char short id. */
  switchTab(tabId: string): Promise<void>;
  /** Close a tab by its short id. */
  closeTab(tabId: string): Promise<void>;
  listTabs(): Promise<LiveTab[]>;
}

export interface LiveTab {
  tabId: string;
  url: string;
  title: string;
}

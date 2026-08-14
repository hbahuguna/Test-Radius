/**
 * Happy-path done checking (browser-use style).
 *
 * After a turn's click batch executes and the page visibly changed, the
 * recorder consults a `DoneChecker` to decide whether the task is complete —
 * so it can conclude without another planning turn or waiting for the LLM to
 * emit "done":true. The happy-path checker tries cheap rules first (no extra
 * LLM call for common completion signals) and only then falls back to an LLM
 * yes/no judgement when the rules are inconclusive.
 */
import type { LLMClient, LLMMessage } from "../llm/client.js";
import type { RecordedStep } from "../recorder/recorder.js";
import type { SnapshotPayload } from "./snapshot.js";

export interface DoneDecision {
  done: boolean;
  reason?: string;
  /** "rule" | "llm" — which path produced the decision. */
  source?: "rule" | "llm";
  /** LLM calls consumed to reach the decision (counted into record metrics). */
  attempts?: number;
}

export interface DoneCheckInput {
  query: string;
  steps: RecordedStep[];
  /** The page state after the batch executed (post-navigation). */
  snapshot: SnapshotPayload;
  /** True when the post-click page signature differs from the pre-batch one. */
  pageChanged: boolean;
  /** True when the batch clicked a submit-like button. */
  submitted: boolean;
  /** The last element clicked in the batch, if any. */
  lastClick?: { role: string; name: string };
}

export interface DoneChecker {
  check(input: DoneCheckInput): Promise<DoneDecision>;
}

// R2 — queries that name a single, self-contained action. A click that advances
// one of these is the whole task (search, sign up, log in, subscribe, ...).
const SINGLE_SHOT_INTENT_RE =
  /\b(sign\s*[-\s]?up|register|create\s*[-\s]?an\s+account|log\s*[-\s]?in|login|sign\s*[-\s]?in|search|subscribe|enroll|submit|send|join|confirm|book|reserve|find|look\s+up|get\s*[-\s]?started)\b/i;

// R3 — a destination named in the query (absolute URL or bare path).
const DESTINATION_RE = /(https?:\/\/[^\s)]+|\/[a-z0-9][a-z0-9._/-]*)/i;

// R4 — confirmation content on the landed page.
const CONFIRMATION_RE =
  /\b(thank you|thanks for|confirmation|confirmed|success|successfully|order (received|confirmed|placed)|account (created|activated|verified)|you.?re all set|you are in|welcome|enrolled|subscribed|booked|reservation (confirmed|made)|submitted|signed up|signed in|checkout complete)\b/i;

export function ruleCheck(input: DoneCheckInput): DoneDecision {
  const { submitted, pageChanged, lastClick, query, snapshot } = input;
  const headings = snapshot.elements
    .filter((e) => e.role === "heading" || e.role === "status")
    .map((e) => e.name)
    .join(" ");

  // R1 — the batch clicked a submit-like button and the page changed.
  if (submitted && pageChanged) {
    return { done: true, source: "rule", reason: "form submitted (submit-like button clicked and page changed)" };
  }

  // R2 — a single-shot query intent was satisfied by a button click.
  if (pageChanged && lastClick?.role === "button" && SINGLE_SHOT_INTENT_RE.test(query)) {
    return { done: true, source: "rule", reason: `single-shot intent matched (clicked "${lastClick.name}")` };
  }

  // R3 — the query named a destination and we landed on it.
  const dest = DESTINATION_RE.exec(query)?.[1];
  if (pageChanged && dest && snapshot.url.toLowerCase().includes(dest.toLowerCase())) {
    return { done: true, source: "rule", reason: `landed on query destination ${dest}` };
  }

  // R4 — the landed page shows confirmation content.
  if (pageChanged && lastClick && CONFIRMATION_RE.test(`${snapshot.url} ${snapshot.title} ${headings}`)) {
    return { done: true, source: "rule", reason: "confirmation content on the resulting page" };
  }

  return { done: false };
}

interface DoneAnswer {
  done: boolean;
  reason?: string;
}

export function parseDoneAnswer(text: string): DoneAnswer | null {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.done !== "boolean") return null;
  return { done: p.done, reason: typeof p.reason === "string" ? p.reason : undefined };
}

const DONE_SYSTEM =
  'You decide whether a web-automation task is complete given the task, the steps already executed, and the page state after the last action. Output ONLY a strict JSON object: {"done": true|false, "reason": "<short explanation>"}';

function renderSteps(steps: RecordedStep[]): string {
  if (steps.length === 0) return "  (none)";
  return steps.map((s, i) => `  ${i + 1}. ${s.action} ${s.selector}`).join("\n");
}

function renderElements(s: SnapshotPayload): string {
  if (s.elements.length === 0) return "  (none)";
  return s.elements.map((e) => `  ${e.index}: [${e.role}] "${e.name}"`).join("\n");
}

export class HappyPathDoneChecker implements DoneChecker {
  constructor(private readonly llm?: LLMClient) {}

  async check(input: DoneCheckInput): Promise<DoneDecision> {
    const rule = ruleCheck(input);
    if (rule.done) return rule;
    if (!this.llm) return { done: false };
    return this.askLLM(input);
  }

  private async askLLM(input: DoneCheckInput): Promise<DoneDecision> {
    const messages: LLMMessage[] = [
      { role: "system", content: DONE_SYSTEM },
      {
        role: "user",
        content: [
          `Task: "${input.query}"`,
          "",
          "Steps executed (most recent last):",
          renderSteps(input.steps),
          "",
          "Page after the last action:",
          `URL: ${input.snapshot.url}`,
          `TITLE: ${input.snapshot.title}`,
          "ELEMENTS:",
          renderElements(input.snapshot),
          "",
          'OUTPUT (strict JSON, nothing else): {"done": true|false, "reason": "..."}',
        ].join("\n"),
      },
    ];
    try {
      const res = await this.llm!.chat(messages, {
        temperature: 0,
        maxTokens: 120,
        responseFormat: { type: "json_object" },
      });
      const answer = parseDoneAnswer(res.text);
      if (answer) {
        return { done: answer.done, reason: answer.reason, source: "llm", attempts: 1 };
      }
      return { done: false, reason: "llm fallback unparseable", source: "llm", attempts: 1 };
    } catch {
      return { done: false, reason: "llm fallback error", source: "llm", attempts: 1 };
    }
  }
}

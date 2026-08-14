/**
 * Prompt construction for the A11y LLM planner (Story QF-48 / QF-50).
 *
 * The system prompt pins down the exact JSON schema the LLM must emit, the
 * milestone-first planning discipline, the batching rule (multiple actions per
 * snapshot, but never across a page-load boundary), and the loop/budget
 * guidance. The user message carries the current snapshot, prior milestones,
 * recent history and any error context from a failed retry.
 */
import type { LLMMessage } from "../llm/client.js";
import type { SnapshotPayload } from "./snapshot.js";
import type { PlanTurn } from "./schema.js";
import type { QuerySlot } from "./slots.js";
import type { Skeleton } from "./site-memory.js";

export interface BuildMessagesParams {
  query: string;
  normalizedQuery: string;
  slots: QuerySlot[];
  snapshot: SnapshotPayload;
  milestones?: string[];
  history: HistoryEntry[];
  lastError?: string | null;
  skeleton?: Skeleton;
}

export interface HistoryEntry {
  snapshot: SnapshotPayload;
  plan: PlanTurn;
}

const SYSTEM = `You are an accessibility-aware web test planner. Given a natural-language query, the current page's accessibility snapshot, and any prior plan history, output a SINGLE strict JSON object describing how to reach the goal. Do NOT include any prose, markdown, or leading text outside the JSON.

Schema (exact):
{
  "milestones": ["brief, ordered outcome phrases — REQUIRED on the FIRST turn to decompose the query into achievable checkpoints"],
  "currentMilestone": "<the milestone this turn advances toward — REQUIRED on the first turn, echoed thereafter>",
  "actions": [ <action>, ... ],
  "done": <boolean — true only when the milestone/goal is fully achieved on this page>,
  "hint": <optional string note, e.g. an explanation when re-planning after an error>
}

Action schema. Each action targets an element by its 1-based "ref" index into the current snapshot's "elements" array — NEVER a raw CSS selector:
- {"type":"navigate","url":"https://..."}
- {"type":"click","ref":<int >= 1>}
- {"type":"fill","ref":<int >= 1>,"value":"text"}
- {"type":"select","ref":<int >= 1>,"value":"option"}
- {"type":"scroll","ref":<int >= 1>}
- {"type":"wait","ms":<int>}
- {"type":"assert","kind":"url"|"text"|"visible","value":"<expected>"}   (kind url uses value as a substring; text/visible require "ref")
- {"type":"extract","ref":<int >= 1>,"name":"slotName"}

Rules:
- Emit "currentMilestone" on the first turn (the milestone this turn works on) and echo it on later turns; the human may be asked to confirm before each milestone.
- Emit milestones on the FIRST turn only; on later turns set "milestones" to the prior list unchanged.
- Batch multiple independent actions for the SAME snapshot into one turn (e.g. fill then click submit). Do NOT emit actions that target a page state that hasn't loaded yet — a "navigate" ends the turn; re-plan after the new page loads.
- Use placeholder slot values "{email}", "{name}", "{number}" in fill/select when the value matches an extracted slot; the executor substitutes the concrete value.
- Set "done":true ONLY when the goal is actually achieved (e.g. URL/path milestone reached, dashboard visible, confirmation text present).
- You do NOT need to emit "done":true after a completion click — the system auto-detects when a task is finished once the page changes: submit-like button clicks, single-shot intents (search/sign up/log in/subscribe...), a destination URL named in the query, and confirmation pages are all recognized automatically. Focus on executing the steps correctly.
- Never re-click the same element repeatedly without the page changing state — that loops. If you sense a loop, emit a "hint" explaining what to try differently.
- Elements marked [expanded] or [collapsed] are toggle controls (menus, accordions, tabs). Clicking an [expanded] element will collapse it; clicking a [collapsed] element will expand it. Do NOT click a collapsed toggle if it's already expanded — the element list changes next turn.
- Elements marked [hidden-until-menu-opens] are present in the DOM but not yet visible. They typically appear after clicking their parent menu toggle. If you need to click a hidden element, first click its parent toggle (look for a [collapsed] button/link with a matching name), then re-snapshot next turn to reveal it.
- When a menu toggle is [expanded], its submenu items should be visible — look for them in the element list and click the target directly. Do NOT toggle the menu closed by clicking it again.`;

function renderSnapshot(s: SnapshotPayload): string {
  const rows = s.elements
    .map((e) => {
      let line = `${e.index}: [${e.role}] "${e.name}" (ref=${e.ref})`;
      if (e.expanded === true) line += " [expanded]";
      else if (e.expanded === false) line += " [collapsed]";
      if (e.hidden) line += " [hidden-until-menu-opens]";
      return line;
    })
    .join("\n");
  return `URL: ${s.url}\nTITLE: ${s.title}\nELEMENTS:\n${rows || "  (none)"}`;
}

function renderHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return "  (no prior turns)";
  return history
    .map((h) => `TURN: ${renderSnapshot(h.snapshot)}\nPLAN: ${JSON.stringify(h.plan)}`)
    .join("\n---\n");
}

function renderSlots(slots: QuerySlot[]): string {
  if (slots.length === 0) return "  (none)";
  return slots.map((s) => `${s.name} (${s.kind}) = ${JSON.stringify(s.defaultValue)}`).join("\n");
}

export function buildMessages(params: BuildMessagesParams): LLMMessage[] {
  const {
    query,
    normalizedQuery,
    slots,
    snapshot,
    milestones,
    history,
    lastError,
    skeleton,
  } = params;
  const userParts: string[] = [];
  userParts.push(
    `Query: "${query}"`,
    `Canonical query: "${normalizedQuery}"`,
    `Extracted slots:\n${renderSlots(slots)}`,
    ...(skeleton ? [`SKELETON — a prior similar test on this domain (reuse/skip as appropriate): milestones ${JSON.stringify(skeleton.milestones)}; ${skeleton.stepCount} steps; slots ${JSON.stringify(skeleton.slotKinds)}; entry ${skeleton.entryUrl}`] : []),
    `Milestones so far: ${milestones ? JSON.stringify(milestones) : "(not yet planned)"}`,
    `Recent history:\n${renderHistory(history)}`,
    `Current page:\n${renderSnapshot(snapshot)}`,
  );
  if (lastError) {
    userParts.push(`CONTEXT — last failure to recover from: ${lastError}`);
  }
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        "Goal:",
        `> ${query}`,
        "",
        ...userParts,
        "",
        "OUTPUT (strict JSON, nothing else):",
      ].join("\n"),
    },
  ];
}

/**
 * Natural-language query entry point (Story QF-60).
 *
 * Decides, for a free-text `run "<query>"`, whether to replay an existing
 * cached test, prompt the user to pick among several similar tests, or fall
 * back to recording a new test (QF-61 / QF-62 / QF-63):
 *
 *   - embed + similarity match against cached tests
 *   - high-confidence single match  -> replay (with slot re-fill from the new
 *     query values, heuristic first and an LLM fallback only when needed)
 *   - multiple high-confidence matches -> disambiguate prompt (unless `--test`)
 *   - no match (below threshold)      -> record
 *
 * All decision/refill/prompt logic is kept pure (an injectable `Matcher` and
 * `LLMClient`) so it is unit-testable without a browser or embedding model.
 */
import type { DataStore } from "../cache/queries.js";
import type { Slot, SlotKind, TestWithSteps } from "../cache/types.js";
import { detectQuerySlots, type DetectedSlot } from "../embeddings/normalize.js";
import type { MatchResult, Matcher } from "../embeddings/matcher.js";
import type { LLMClient } from "../llm/client.js";

export type RunMode =
  | { mode: "replay"; test: TestWithSteps; score: number; ambiguous: false }
  | { mode: "disambiguate"; candidates: MatchResult[] }
  | { mode: "record"; query: string };

export interface DecideRunOptions {
  /** Max number of candidates to offer in the disambiguate prompt. */
  maxCandidates?: number;
  /** Two matches within this score margin of the top are considered ambiguous. */
  ambiguityMargin?: number;
}

/** Default embedding-similarity threshold below which a query is "no match". */
export const DEFAULT_THRESHOLD = 0.85;

const URL_RE = /\bhttps?:\/\/[^\s)]+/i;

/**
 * Embed the query and decide replay vs. disambiguate vs. record against the
 * cached tests the matcher knows about.
 */
export async function decideRun(
  query: string,
  store: DataStore,
  matcher: Matcher,
  options: DecideRunOptions = {},
): Promise<RunMode> {
  const max = options.maxCandidates ?? 5;
  const margin = options.ambiguityMargin ?? 0.05;
  const scored = await matcher.matchAll(query);
  if (scored.length === 0) return { mode: "record", query };

  const [top, ...rest] = scored;
  // candidates within the ambiguity margin of the top score
  const ambiguousSet = rest.filter((c) => top.score - c.score < margin).sort((a, b) => b.score - a.score);
  const candidates = [top, ...ambiguousSet].slice(0, max);

  if (candidates.length <= 1) {
    const test = store.getTestWithSteps(top.test.id);
    if (!test) return { mode: "record", query };
    return { mode: "replay", test, score: top.score, ambiguous: false };
  }

  return { mode: "disambiguate", candidates };
}

export interface RefillResult {
  variables: Record<string, string>;
  usedLlm: boolean;
}

type SlottedSlot = Pick<Slot, "name" | "kind" | "defaultValue">;

const EMAIL_FILL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Build replay `variables` from a new query against a test's recorded slots.
 *
 * Heuristic: for each slot kind, if the query contains exactly one detected
 * value of that kind, pair it with the slot of the same kind. When any slot is
 * left unresolved (no, or more than one, matching value) and an LLM is
 * available, fall back to the LLM to map slot -> value (counts as one LLM call;
 * the pure-heuristic path uses zero LLM calls).
 */
export async function refillVariables(
  slots: SlottedSlot[],
  query: string,
  llm?: LLMClient,
): Promise<RefillResult> {
  const detected = detectQuerySlots(query);
  const byKind = new Map<SlotKind, DetectedSlot[]>();
  for (const d of detected) {
    const arr = byKind.get(d.kind);
    if (arr) arr.push(d);
    else byKind.set(d.kind, [d]);
  }

  const variables: Record<string, string> = {};
  const unresolved: SlottedSlot[] = [];
  for (const slot of slots) {
    const arr = byKind.get(slot.kind) ?? [];
    if (arr.length === 1) {
      variables[slot.name] = arr[0].value;
    } else {
      unresolved.push(slot);
    }
  }

  if (unresolved.length === 0) return { variables, usedLlm: false };
  if (!llm) return { variables, usedLlm: false };

  const mapped = await refillWithLLM(llm, slots, query, unresolved);
  for (const [k, v] of Object.entries(mapped)) variables[k] = v;
  return { variables, usedLlm: true };
}

async function refillWithLLM(
  llm: LLMClient,
  slots: SlottedSlot[],
  query: string,
  unresolved: SlottedSlot[],
): Promise<Record<string, string>> {
  const slotDesc = slots
    .map((s) => `${s.name} (kind=${s.kind}, default="${s.defaultValue ?? ""}")`)
    .join("; ");
  const unresolvedDesc = unresolved.map((s) => `${s.name} (${s.kind})`).join(", ");
  const prompt = [
    "You are replaying a cached test with new input values.",
    `Test slots: ${slotDesc}.`,
    `The user's new query: "${query}".`,
    `For each unresolved slot below, extract the new value the user intends, based on the query.`,
    `Unresolved slots: ${unresolvedDesc}.`,
    'Output only a JSON object mapping slot name to new value, e.g. {"name":"Jane"}.',
  ].join(" ");
  const res = await llm.chat([{ role: "user", content: prompt }], { temperature: 0 });
  const text = res.text.trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return {};
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // fall through to empty
  }
  return {};
}

/** Human-readable disambiguation prompt text (QF-63). */
export function disambiguatePrompt(candidates: MatchResult[]): string {
  const lines = ["Multiple similar tests found:"];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    lines.push(`  (${i + 1}) ${c.test.name}  (match ${Math.round(c.score * 100)}%)  ${c.test.entryUrl ?? ""}`);
  }
  lines.push("Enter the number to run (or press Enter to cancel): ");
  return lines.join("\n");
}

/** Extract a starting URL from a free-text query, if present. */
export function extractStartUrl(query: string): string | null {
  const m = query.match(URL_RE);
  if (!m) return null;
  return m[0].replace(/[.,;:]$/, "");
}


/** QF-63: pick a candidate from the disambiguation prompt by 1-based index. */
export function chooseCandidate(candidates: MatchResult[], input: string): MatchResult | null {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) return null;
  return candidates[n - 1]!;
}

/**
 * QF-61: resolve the starting URL for a record flow from the supplied options,
 * in priority order: explicit entry URL -> URL embedded in the query -> site.
 * Returns null when no starting URL is available (caller should prompt).
 */
export function resolveStartUrl(
  entryUrl: string | undefined,
  query: string,
  site: string | undefined,
): string | null {
  return entryUrl ?? extractStartUrl(query) ?? site ?? null;
}

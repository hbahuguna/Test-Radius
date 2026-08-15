/**
 * Test-name generation (QueryFirst suites/trains).
 *
 * `summarizeTestName` condenses a long natural-language recording query into a
 * short, human-readable test name using the configured LLM, falling back to a
 * deterministic keyword slug when the LLM is unavailable or fails. The numeric
 * test id stays the canonical identifier; `uniqueTestName` guarantees the
 * display name is unique across existing tests.
 */

import type { LLMClient } from "../llm/client.js";

export const MAX_NAME_WORDS = 7;
export const MAX_NAME_CHARS = 64;

/** Deterministic fallback: first few meaningful words of the query. */
export function summarizeTestNameFallback(query: string): string {
  const cleaned = query.replace(/\s+/g, " ").trim();
  if (!cleaned) return "untitled test";
  const words = cleaned.split(" ");
  const truncated = words.slice(0, MAX_NAME_WORDS).join(" ").trim();
  if (truncated.length <= MAX_NAME_CHARS) return truncated;
  return truncated.slice(0, MAX_NAME_CHARS).replace(/\s\S*$/, "").trim() || truncated.slice(0, MAX_NAME_CHARS).trim();
}

/**
 * Summarize a recording query into a short test name. One tiny LLM chat call;
 * any failure (or empty response) falls back to the heuristic slug.
 */
export async function summarizeTestName(
  llm: LLMClient | undefined,
  query: string,
): Promise<string> {
  if (!llm || !query.trim()) return summarizeTestNameFallback(query);

  try {
    const result = await llm.chat(
      [
        {
          role: "system",
          content:
            "You name end-to-end browser test scenarios for a test suite. " +
            `Reply with only the test name: at most ${MAX_NAME_WORDS} words, ` +
            "no quotes, no trailing punctuation, no explanation.",
        },
        { role: "user", content: query },
      ],
      { temperature: 0, maxTokens: 32 },
    );
    const name = sanitizeName(result.text);
    return name || summarizeTestNameFallback(query);
  } catch {
    return summarizeTestNameFallback(query);
  }
}

function sanitizeName(text: string): string {
  const cleaned = text.replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const words = cleaned.split(" ").slice(0, MAX_NAME_WORDS).join(" ");
  if (words.length <= MAX_NAME_CHARS) return words;
  return words.slice(0, MAX_NAME_CHARS).replace(/\s\S*$/, "").trim() || words.slice(0, MAX_NAME_CHARS).trim();
}

/** Return `base`, or `base (2)` / `base (3)` / … if it collides with an existing name. */
export function uniqueTestName(existingNames: Iterable<string>, base: string): string {
  const names = new Set(existingNames);
  const candidate = base.trim() || "untitled test";
  if (!names.has(candidate)) return candidate;
  for (let n = 2; ; n++) {
    const next = `${candidate} (${n})`;
    if (!names.has(next)) return next;
  }
}

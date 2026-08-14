import type { DataStore } from "../cache/queries.js";
import type { Test } from "../cache/types.js";
import { bytesToEmbedding, embedCached } from "./embed.js";
import { slotNormalize } from "./normalize.js";

export interface MatchOptions {
  threshold?: number;
  topK?: number;
  ambiguityMargin?: number;
  embed?: (text: string) => Promise<Float32Array>;
}

export interface MatchResult {
  test: Test;
  score: number;
  ambiguous: boolean;
}

export interface Matcher {
  /** Top match (score >= threshold) or null. `ambiguous` is true when the top
   *  two matches are within `ambiguityMargin` of each other. */
  match(query: string): Promise<MatchResult | null>;
  /** All matches within `threshold`, sorted by descending score (top already
   *  first). Used by the QF-63 ambiguity prompt to offer several candidates. */
  matchAll(query: string): Promise<MatchResult[]>;
  cosine(a: Float32Array, b: Float32Array): number;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function createMatcher(store: DataStore, options: MatchOptions = {}): Matcher {
  const threshold = options.threshold ?? 0.85;
  const topK = options.topK ?? 3;
  const ambiguityMargin = options.ambiguityMargin ?? 0.05;
  const embedFn = options.embed ?? embedCached;

  async function matchAll(query: string): Promise<MatchResult[]> {
    const normalized = slotNormalize(query);
    const vector = await embedFn(normalized);

    const scored = store
      .listTests()
      .filter((t) => t.queryEmbedding)
      .map((t) => ({ test: t, score: cosine(vector, bytesToEmbedding(t.queryEmbedding!)) }))
      .sort((a, b) => b.score - a.score)
      .filter((entry) => entry.score >= threshold)
      .slice(0, topK);

    return scored.map((entry, i) => {
      const next = scored[i + 1];
      return {
        test: entry.test,
        score: entry.score,
        ambiguous: next !== undefined && entry.score - next.score < ambiguityMargin,
      };
    });
  }

  async function match(query: string): Promise<MatchResult | null> {
    const scored = await matchAll(query);
    if (scored.length === 0) return null;
    return scored[0];
  }

  return { match, matchAll, cosine };
}

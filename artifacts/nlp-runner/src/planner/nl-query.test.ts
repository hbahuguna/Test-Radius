import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import type { MatchResult } from "../embeddings/matcher.js";
import type { SlotKind } from "../cache/types.js";
import {
  chooseCandidate,
  decideRun,
  disambiguatePrompt,
  extractStartUrl,
  refillVariables,
  resolveStartUrl,
} from "./nl-query.js";

function makeStore(): DataStore {
  const dir = mkdtempSync(join(tmpdir(), "qf-nl-"));
  const db = openDatabase(dir);
  return new DataStore(db);
}

function fakeMatcher(
  scores: Array<{ id: number; name: string; score: number; url?: string }>,
): MatchResult[] {
  const rows = scores.map((s) => ({
    test: { id: s.id, name: s.name, entryUrl: s.url ?? null, query: s.name, normalizedQuery: s.name } as unknown as MatchResult["test"],
    score: s.score,
    ambiguous: false,
  }));
  return rows.slice().sort((a, b) => b.score - a.score);
}

describe("decideRun (QF-61 / QF-63)", () => {
  it("returns record when there are no matches", async () => {
    const store = makeStore();
    const matcher = { matchAll: async () => [] } as unknown as Parameters<typeof decideRun>[2];
    const mode = await decideRun("what is 2+2", store, matcher);
    expect(mode).toEqual({ mode: "record", query: "what is 2+2" });
  });

  it("returns a single replay when one high-confidence match exists", async () => {
    const store = makeStore();
    store.createTest({
      name: "signup",
      source: "recorder",
      query: "register bob@x.com on signup",
      entryUrl: "https://example.com/signup",
    });
    const rows = fakeMatcher([{ id: 1, name: "signup", score: 0.92, url: "https://example.com/signup" }]);
    const matcher = { matchAll: async () => rows } as unknown as Parameters<typeof decideRun>[2];
    const mode = await decideRun("register jane@y.com on signup", store, matcher);
    expect(mode.mode).toBe("replay");
    if (mode.mode === "replay") {
      expect(mode.test.id).toBe(1);
      expect(mode.score).toBeCloseTo(0.92);
      expect(mode.ambiguous).toBe(false);
    }
  });

  it("returns a disambiguate decision when top matches are within the margin", async () => {
    const store = makeStore();
    store.createTest({ name: "delete", source: "recorder" });
    store.createTest({ name: "remove", source: "recorder" });
    const rows = fakeMatcher([
      { id: 1, name: "delete", score: 0.9 },
      { id: 2, name: "remove", score: 0.88 }, // within 0.05 margin
    ]);
    const matcher = { matchAll: async () => rows } as unknown as Parameters<typeof decideRun>[2];
    const mode = await decideRun("remove my account", store, matcher);
    expect(mode.mode).toBe("disambiguate");
    if (mode.mode === "disambiguate") {
      expect(mode.candidates.length).toBe(2);
      expect(mode.candidates.map((c) => c.test.name)).toEqual(["delete", "remove"]);
    }
  });

  it("does not disambiguate when the gap exceeds the margin", async () => {
    const store = makeStore();
    store.createTest({ name: "signup", source: "recorder" });
    const rows = fakeMatcher([
      { id: 1, name: "signup", score: 0.95 },
      { id: 2, name: "other", score: 0.8 }, // 0.15 gap > 0.05
    ]);
    const matcher = { matchAll: async () => rows } as unknown as Parameters<typeof decideRun>[2];
    const mode = await decideRun("register jane", store, matcher);
    expect(mode.mode).toBe("replay");
  });
});

describe("chooseCandidate (QF-63)", () => {
  it("selects a 1-based candidate", () => {
    const cands = [{ test: { id: 1 } }, { test: { id: 2 } }] as unknown as MatchResult[];
    expect(chooseCandidate(cands, "2")?.test.id).toBe(2);
    expect(chooseCandidate(cands, "1")?.test.id).toBe(1);
  });
  it("returns null for out-of-range/non-numeric input (cancel)", () => {
    const cands = [{ test: { id: 1 } }] as unknown as MatchResult[];
    expect(chooseCandidate(cands, "0")).toBeNull();
    expect(chooseCandidate(cands, "9")).toBeNull();
    expect(chooseCandidate(cands, "")).toBeNull();
    expect(chooseCandidate(cands, "nope")).toBeNull();
  });
});

describe("disambiguatePrompt (QF-63)", () => {
  it("offers numbered candidates", () => {
    const cands = [
      { test: { name: "Delete account", entryUrl: "https://example.com/account" }, score: 0.9 },
      { test: { name: "Remove account", entryUrl: "https://example.com/account" }, score: 0.88 },
    ] as unknown as MatchResult[];
    const out = disambiguatePrompt(cands);
    expect(out).toContain("Multiple similar tests found:");
    expect(out).toContain("(1) Delete account");
    expect(out).toContain("(2) Remove account");
    expect(out).toContain("Enter the number to run (or press Enter to cancel):");
  });
});

describe("refillVariables (QF-62)", () => {
  it("heuristically maps an email value to the email slot (llm_calls 0 path)", async () => {
    const slots: Array<{ name: string; kind: SlotKind; defaultValue: string }> = [{ name: "email", kind: "email", defaultValue: "bob@x.com" }];
    const res = await refillVariables(slots, "register jane@y.com on signup");
    expect(res.variables).toEqual({ email: "jane@y.com" });
    expect(res.usedLlm).toBe(false);
  });

  it("leaves a slot unset when the query carries no value for that kind", async () => {
    const slots: Array<{ name: string; kind: SlotKind; defaultValue: string }> = [
      { name: "email", kind: "email", defaultValue: "bob@x.com" },
      { name: "name", kind: "name", defaultValue: "Bob" },
    ];
    const res = await refillVariables(slots, "register jane@y.com on signup");
    expect(res.variables).toEqual({ email: "jane@y.com" });
    expect(res.usedLlm).toBe(false);
  });

  it("uses the LLM fallback when a slot kind is present but heuristic is ambiguous", async () => {
    const slots: Array<{ name: string; kind: SlotKind; defaultValue: string }> = [{ name: "email", kind: "email", defaultValue: "bob@x.com" }];
    const chat = (text: string) => ({ text });
    const llm = { chat: async (_m: unknown) => chat('{"email":"first@x.com"}') } as unknown as Parameters<typeof refillVariables>[2];
    // two email-like tokens -> heuristic can't pick one 1:1 -> LLM fallback
    const res = await refillVariables(slots, "register alice@x.com and bob@x.com", llm);
    expect(res.usedLlm).toBe(true);
    expect(res.variables.email).toBe("first@x.com");
  });

  it("returns usedLlm=false and empty vars when there are no slots", async () => {
    const res = await refillVariables([], "register jane@y.com");
    expect(res.variables).toEqual({});
    expect(res.usedLlm).toBe(false);
  });

  it("falls back to LLM when a name slot value is not regex-detectable (single token)", async () => {
    const slots: Array<{ name: string; kind: SlotKind; defaultValue: string }> = [{ name: "name", kind: "name", defaultValue: "Bob" }];
    const llm = { chat: async (_m: unknown) => ({ text: '{"name":"Jane"}' }) } as unknown as Parameters<typeof refillVariables>[2];
    // "Jane" (single capitalized token) is not detected by the name regex
    const res = await refillVariables(slots, "register Jane", llm);
    expect(res.usedLlm).toBe(true);
    expect(res.variables).toEqual({ name: "Jane" });
  });
});

describe("extractStartUrl / resolveStartUrl (QF-61)", () => {
  it("extracts a URL from a free-text query", () => {
    expect(extractStartUrl("register on https://example.com/signup today")).toBe(
      "https://example.com/signup",
    );
    expect(extractStartUrl("sign up at http://localhost:3123/s")).toBe("http://localhost:3123/s");
    expect(extractStartUrl("what is 2+2")).toBeNull();
  });

  it("resolveStartUrl prefers entry URL, then query URL, then site", () => {
    expect(resolveStartUrl("https://a.com", "x", "https://b.com")).toBe("https://a.com");
    expect(resolveStartUrl(undefined, "register jane on https://a.com", "https://b.com")).toBe("https://a.com");
    expect(resolveStartUrl(undefined, "totally new query", "https://b.com")).toBe("https://b.com");
    expect(resolveStartUrl(undefined, "totally new query", undefined)).toBeNull();
  });
});

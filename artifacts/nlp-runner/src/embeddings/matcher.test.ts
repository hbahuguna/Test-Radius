import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import { embed, embedStats, embeddingToBytes } from "./embed.js";
import { createMatcher } from "./matcher.js";
import { slotNormalize } from "./normalize.js";

const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

async function probeModel(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await embed("warmup");
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
    }
  }
  return false;
}

const modelReady = await probeModel();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qf-match-"));
  tempDirs.push(dir);
  return dir;
}

function makeStore(): DataStore {
  const db = openDatabase(makeTempDir());
  openDbs.push(db);
  return new DataStore(db);
}

async function seedTest(
  store: DataStore,
  name: string,
  query: string,
): Promise<void> {
  const normalized = slotNormalize(query);
  const vector = await embed(normalized);
  store.createTest({
    name,
    source: "nlp",
    query,
    normalizedQuery: normalized,
    queryEmbedding: embeddingToBytes(vector),
    description: "seed",
  });
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(modelReady)("createMatcher (real model)", () => {
  it("returns the register test with score >= 0.85", async () => {
    const store = makeStore();
    await seedTest(store, "register a user", "register a user {email}");
    await seedTest(store, "check the pricing page", "check the pricing page");
    const matcher = createMatcher(store);
    const result = await matcher.match("register a user with jane@y.com");
    expect(result).not.toBeNull();
    expect(result!.test.name).toBe("register a user");
    expect(result!.score).toBeGreaterThanOrEqual(0.85);
  });

  it("returns null for an unrelated query (below threshold)", async () => {
    const store = makeStore();
    await seedTest(store, "register a user", "register a user {email}");
    const matcher = createMatcher(store);
    expect(await matcher.match("what is the meaning of life")).toBeNull();
  });

  it("flags ambiguity when the top two are within a small margin", async () => {
    const store = makeStore();
    await seedTest(store, "delete my account", "delete my account");
    await seedTest(store, "remove my account", "remove my account");
    const matcher = createMatcher(store);
    const result = await matcher.match("delete account");
    expect(result).not.toBeNull();
    expect(result!.test.name).toBe("delete my account");
    expect(result!.ambiguous).toBe(true);
  });

  it("memoizes repeated queries (miss once, hit next)", async () => {
    const store = makeStore();
    await seedTest(store, "register a user", "register a user {email}");
    const matcher = createMatcher(store);
    const before = embedStats();
    await matcher.match("register bob@x.com");
    await matcher.match("register bob@x.com");
    const after = embedStats();
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(1);
  });
});

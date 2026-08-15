import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DB_FILENAME,
  journalMode,
  openDatabase,
  runMigrations,
} from "./db.js";
import { DataStore } from "./queries.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qf-db-"));
  tempDirs.push(dir);
  return dir;
}

function openDb(dir: string) {
  const db = openDatabase(dir);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tableNames(db: import("better-sqlite3").Database): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name`,
    )
    .pluck()
    .all() as string[];
}

function columnsOf(
  db: import("better-sqlite3").Database,
  table: string,
): { name: string; type: string }[] {
  return db.pragma(`table_info(${table})`) as { name: string; type: string }[];
}

describe("QF-29 db init + WAL + migrations", () => {
  it("opens a fresh DB in WAL mode", () => {
    const dir = makeTempDir();
    const db = openDb(dir);
    expect(journalMode(db)).toBe("wal");
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "tests",
        "steps",
        "slots",
        "runs",
        "run_steps",
        "test_versions",
        "site_memory",
      ]),
    );
  });

  it("runs migrations idempotently (second run is a no-op)", () => {
    const dir = makeTempDir();
    const db = openDb(dir);
    const { applied } = runMigrations(db);
    expect(applied).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
        n: number;
      },
    ).toEqual({ n: MIGRATIONS.length });
  });

  it("recreates a deleted DB file cleanly", () => {
    const dir = makeTempDir();
    const first = openDb(dir);
    first.close();
    openDbs.pop();

    const dbPath = join(dir, DB_FILENAME);
    writeFileSync(dbPath, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

    const recreated = openDatabase(dir);
    openDbs.push(recreated);
    expect(journalMode(recreated)).toBe("wal");
    expect(tableNames(recreated)).toContain("tests");
  });

  it("moves a corrupt DB aside and recreates it", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, DB_FILENAME);
    writeFileSync(dbPath, "this is not a sqlite database at all............");

    const recovered = openDatabase(dir);
    openDbs.push(recovered);
    expect(journalMode(recovered)).toBe("wal");
    expect(
      recovered.prepare("SELECT COUNT(*) AS n FROM tests").get(),
    ).toEqual({ n: 0 });
  });

  it("persists data across reopen", () => {
    const dir = makeTempDir();
    const db = openDb(dir);
    db.prepare("INSERT INTO site_memory (site, kind, key, value_json, confidence, created_at, updated_at) VALUES ('x', 'y', 'z', '1', 1, 't', 't')").run();
    db.close();
    openDbs.pop();

    const reopened = openDatabase(dir);
    openDbs.push(reopened);
    expect(
      reopened.prepare("SELECT value_json AS v FROM site_memory").pluck().get(),
    ).toBe("1");
  });
});

describe("QF-30 schema", () => {
  it("creates all tables with the planned schema", () => {
    const db = openDb(makeTempDir());
    expect(tableNames(db).sort()).toEqual(
      [
        "tests",
        "steps",
        "slots",
        "runs",
        "run_steps",
        "test_versions",
        "site_memory",
        "suites",
        "suite_tests",
        "suite_runs",
        "trains",
        "train_suites",
        "train_runs",
      ].sort(),
    );
  });

  it("stores query_embedding as BLOB and key step columns exist", () => {
    const db = openDb(makeTempDir());

    const tests = columnsOf(db, "tests");
    const embedding = tests.find((c) => c.name === "query_embedding");
    expect(embedding?.type).toBe("BLOB");

    const stepNames = columnsOf(db, "steps").map((c) => c.name);
    for (const column of [
      "page_signature_before",
      "page_signature_after",
      "wait_condition_json",
      "element_fingerprint",
      "locators_json",
      "assertion_json",
    ]) {
      expect(stepNames).toContain(column);
    }

    const runs = columnsOf(db, "runs");
    expect(runs.find((c) => c.name === "llm_calls")?.type).toBe("INTEGER");
  });

  it("cascades steps deletion when a test is deleted", () => {
    const dir = makeTempDir();
    const db = openDb(dir);
    const store = new DataStore(db);

    const test = store.createTest({ name: "login", source: "recorder" });
    store.addStep(test.id, { action: "navigate", value: "/login" });
    store.addStep(test.id, { action: "click", selector: "#submit" });
    expect(store.listStepsByTest(test.id)).toHaveLength(2);

    store.deleteTest(test.id);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM steps").get(),
    ).toEqual({ n: 0 });
  });

  it("enforces the steps -> tests foreign key", () => {
    const db = openDb(makeTempDir());
    expect(() =>
      db
        .prepare(
          "INSERT INTO steps (test_id, idx, action) VALUES (999, 0, 'click')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("QF-31 data-access layer", () => {
  it("round-trips a test + 3 steps + 2 slots exactly", () => {
    const store = new DataStore(openDb(makeTempDir()));

    const test = store.createTest({
      name: "register a user",
      source: "nlp",
      query: "register a user with bob@x.com",
      normalizedQuery: "register a user with {email}",
      queryEmbedding: new Uint8Array([1, 2, 3, 4]),
      description: "seed test",
    });
    const steps = [
      { action: "navigate" as const, value: "/signup", pageSignatureBefore: "sig1" },
      {
        action: "fill" as const,
        selector: "[data-testid=signup-email]",
        value: "bob@x.com",
        locators: ["[data-testid=signup-email]", "#email"],
        elementFingerprint: "abc123",
        pageSignatureAfter: "sig2",
        waitCondition: { kind: "manual" as const, timeoutMs: 5000, desc: "email visible" },
      },
      {
        action: "click" as const,
        selector: "[data-testid=signup-submit]",
        assertion: { op: "visible", expected: true },
      },
    ];
    for (const step of steps) store.addStep(test.id, step);

    store.addSlot(test.id, { name: "email", kind: "email", defaultValue: "bob@x.com" });
    store.addSlot(test.id, { name: "plan", kind: "text" });

    const stored = store.getTest(test.id)!;
    expect(stored.name).toBe("register a user");
    expect(stored.source).toBe("nlp");
    expect(stored.query).toBe("register a user with bob@x.com");
    expect(stored.normalizedQuery).toBe("register a user with {email}");
    expect(stored.queryEmbedding).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(stored.description).toBe("seed test");

    const storedSteps = store.listStepsByTest(test.id);
    expect(storedSteps).toHaveLength(3);
    expect(storedSteps[1].locators).toEqual([
      "[data-testid=signup-email]",
      "#email",
    ]);
    expect(storedSteps[1].elementFingerprint).toBe("abc123");
    expect(storedSteps[1].pageSignatureAfter).toBe("sig2");
    expect(storedSteps[1].waitCondition).toEqual({ kind: "manual", timeoutMs: 5000, desc: "email visible" });
    expect(storedSteps[2].assertion).toEqual({ op: "visible", expected: true });

    const slots = store.listSlotsByTest(test.id);
    expect(slots).toHaveLength(2);
    expect(slots[0].name).toBe("email");
    expect(slots[0].kind).toBe("email");
    expect(slots[0].defaultValue).toBe("bob@x.com");
    expect(slots[1].kind).toBe("text");
    expect(slots[1].defaultValue).toBeNull();
  });

  it("getTestWithSteps returns nested steps in idx order", () => {
    const store = new DataStore(openDb(makeTempDir()));
    const test = store.createTest({ name: "ordered", source: "recorder" });
    store.addStep(test.id, { action: "navigate", value: "/login" });
    store.addStep(test.id, { action: "click", selector: "#a" });
    store.addStep(test.id, { action: "fill", selector: "#b", value: "x" });

    const full = store.getTestWithSteps(test.id)!;
    expect(full.steps.map((s) => s.action)).toEqual([
      "navigate",
      "click",
      "fill",
    ]);
    expect(full.steps.map((s) => s.idx)).toEqual([0, 1, 2]);
  });

  it("updates a step's locators_json and cascades deletes", () => {
    const store = new DataStore(openDb(makeTempDir()));
    const test = store.createTest({ name: "updatable", source: "recorder" });
    const step = store.addStep(test.id, {
      action: "click",
      selector: "#old",
      locators: ["#old"],
    });

    const updated = store.updateStep(step.id, {
      locators: ["[data-testid=btn]", "#new"],
      selector: "[data-testid=btn]",
    });
    expect(updated.locators).toEqual(["[data-testid=btn]", "#new"]);
    expect(store.getStep(step.id)!.selector).toBe("[data-testid=btn]");

    store.deleteTest(test.id);
    expect(store.getStep(step.id)).toBeNull();
    expect(store.getTest(test.id)).toBeNull();
  });

  it("inserts a run with llm_calls: 0 and reads it back in the listing", () => {
    const store = new DataStore(openDb(makeTempDir()));
    const test = store.createTest({ name: "runnable", source: "template" });

    const run = store.createRun({ testId: test.id, status: "running", llmCalls: 0 });
    expect(run.llmCalls).toBe(0);
    expect(run.status).toBe("running");
    expect(run.finishedAt).toBeNull();

    const runs = store.listRuns(test.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run.id);
    expect(runs[0].llmCalls).toBe(0);

    const finished = store.finishRun(run.id, "passed");
    expect(finished.status).toBe("passed");
    expect(finished.finishedAt).not.toBeNull();

    store.addRunStep(run.id, { idx: 0, status: "passed", detail: { selector: "#a" } });
    store.addRunStep(run.id, { idx: 1, status: "failed", detail: { reason: "not found" } });
    const withSteps = store.getRunWithSteps(run.id)!;
    expect(withSteps.steps.map((s) => s.status)).toEqual(["passed", "failed"]);
    expect(withSteps.steps[1].detail).toEqual({ reason: "not found" });
  });

  it("tracks test versions and site memory", () => {
    const store = new DataStore(openDb(makeTempDir()));
    const test = store.createTest({ name: "versioned", source: "recorder" });

    const v1 = store.createVersion({
      testId: test.id,
      version: 1,
      steps: [{ action: "navigate", value: "/login" }],
      slots: [],
      reason: "initial",
    });
    store.createVersion({
      testId: test.id,
      version: 2,
      steps: [{ action: "navigate", value: "/login?x=1" }],
      slots: [{ name: "email", kind: "email" }],
      reason: "self-heal",
    });

    const versions = store.listVersionsByTest(test.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0].reason).toBe("initial");
    expect(versions[1].steps).toEqual([{ action: "navigate", value: "/login?x=1" }]);
    expect(versions[1].slots).toEqual([{ name: "email", kind: "email" }]);
    expect(v1.createdAt).toBeTruthy();

    store.upsertMemory({
      site: "localhost:3123",
      kind: "locator",
      key: "submit",
      value: ["[data-testid=login-submit]", "#submit"],
    });
    store.upsertMemory({
      site: "localhost:3123",
      kind: "locator",
      key: "submit",
      value: ["[data-testid=btn-sign-in]"],
      confidence: 0.9,
    });
    const mem = store.getMemory("localhost:3123", "locator", "submit")!;
    expect(mem.value).toEqual(["[data-testid=btn-sign-in]"]);
    expect(mem.confidence).toBe(0.9);
    expect(store.listMemory("localhost:3123")).toHaveLength(1);
  });

  it("uses SCHEMA_VERSION matching the migration count", () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it("adds parallel columns to suite_tests and train_suites in v5", () => {
    const dir = makeTempDir();
    const db = openDb(dir);
    const store = new DataStore(db);

    // migration v5 should have added `parallel` to both membership tables
    const suiteCols = columnsOf(db, "suite_tests").map((c) => c.name);
    expect(suiteCols).toContain("parallel");

    const trainSuiteCols = columnsOf(db, "train_suites").map((c) => c.name);
    expect(trainSuiteCols).toContain("parallel");

    // verify it round-trips through the store
    const [t] = seedSuiteMembers(store);
    const suite = store.createSuite({ name: "S" });
    store.setSuiteTests(suite.id, [{ testId: t, parallel: true }]);
    const loaded = store.getSuiteWithTests(suite.id)!;
    expect(loaded.tests[0].parallel).toBe(true);
  });
});

function seedSuiteMembers(store: DataStore): number[] {
  return ["X"].map((name) =>
    store.saveTest({
      name,
      source: "recorder",
      entryUrl: "https://example.test",
      stepHash: `h-${name}`,
      query: name,
      steps: [{ action: "navigate", value: "https://example.test", selector: null }],
      slots: [],
    }).id,
  );
}

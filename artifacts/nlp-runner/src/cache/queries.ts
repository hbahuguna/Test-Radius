import type { Database as DatabaseType } from "better-sqlite3";
import type {
  Assertion,
  NewRun,
  NewRunStep,
  NewSiteMemory,
  NewSlot,
  NewStep,
  NewTest,
  NewTestVersion,
  Run,
  RunStep,
  RunWithSteps,
  SiteMemory,
  Slot,
  Step,
  Test,
  TestSource,
  TestVersion,
  TestWithSteps,
  WaitCondition,
} from "./types.js";

import { hashSteps } from "../recorder/recorder.js";

export interface SaveTestInput {
  name: string;
  source: TestSource;
  entryUrl: string;
  stepHash: string;
  query?: string | null;
  normalizedQuery?: string | null;
  queryEmbedding?: Uint8Array | null;
  description?: string | null;
  steps: NewStep[];
  slots: NewSlot[];
}

export interface SaveTestResult {
  id: number;
  created: boolean;
}

interface TestRow {
  id: number;
  name: string;
  source: TestSource;
  query: string | null;
  normalized_query: string | null;
  query_embedding: Uint8Array | null;
  entry_url: string | null;
  step_hash: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: number;
  test_id: number;
  idx: number;
  action: string;
  selector: string | null;
  value: string | null;
  locators_json: string | null;
  element_fingerprint: string | null;
  page_signature_before: string | null;
  page_signature_after: string | null;
  wait_condition_json: string | null;
  assertion_json: string | null;
  optional: number | null;
}

interface SlotRow {
  id: number;
  test_id: number;
  name: string;
  kind: string;
  default_value: string | null;
}

interface RunRow {
  id: number;
  test_id: number;
  status: string;
  llm_calls: number;
  started_at: string;
  finished_at: string | null;
  error_json: string | null;
}

interface RunStepRow {
  id: number;
  run_id: number;
  step_id: number | null;
  idx: number;
  status: string;
  detail_json: string | null;
  created_at: string;
}

interface TestVersionRow {
  id: number;
  test_id: number;
  version: number;
  steps_json: string;
  slots_json: string;
  reason: string | null;
  created_at: string;
}

interface SiteMemoryRow {
  id: number;
  site: string;
  kind: string;
  key: string;
  value_json: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

function jsonParse<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}

export class DataStore {
  constructor(private readonly db: DatabaseType) {}

  // ----- tests ------------------------------------------------------------

  createTest(input: NewTest): Test {
    const createdAt = now();
    const result = this.db
      .prepare(
        `INSERT INTO tests (name, source, query, normalized_query, query_embedding, entry_url, step_hash, description, created_at, updated_at)
         VALUES (@name, @source, @query, @normalizedQuery, @queryEmbedding, @entryUrl, @stepHash, @description, @createdAt, @updatedAt)`,
      )
      .run({
        ...input,
        query: input.query ?? null,
        normalizedQuery: input.normalizedQuery ?? null,
        queryEmbedding: input.queryEmbedding ?? null,
        entryUrl: input.entryUrl ?? null,
        stepHash: input.stepHash ?? null,
        description: input.description ?? null,
        createdAt,
        updatedAt: createdAt,
      });
    return this.getTest(Number(result.lastInsertRowid))!;
  }

  getTest(id: number): Test | null {
    const row = this.db
      .prepare(`SELECT * FROM tests WHERE id = ?`)
      .get(id) as TestRow | undefined;
    return row ? mapTest(row) : null;
  }

  getTestWithSteps(id: number): TestWithSteps | null {
    const test = this.getTest(id);
    if (!test) return null;
    return { ...test, steps: this.listStepsByTest(id) };
  }

  /**
   * Direct-match lookup for `run "<query>"`: exact match on the query or its
   * normalized form, newest first.
   */
  getTestByQuery(query: string): Test | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tests WHERE query = ? OR normalized_query = ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      )
      .get(query, query) as TestRow | undefined;
    return row ? mapTest(row) : null;
  }

  listTests(): Test[] {
    const rows = this.db.prepare(`SELECT * FROM tests ORDER BY id`).all() as TestRow[];
    return rows.map(mapTest);
  }

  updateTest(id: number, input: Partial<NewTest>): Test {
    const current = this.getTest(id);
    if (!current) throw new Error(`No test with id ${id}`);
    const next: Test = {
      ...current,
      ...input,
      queryEmbedding: input.queryEmbedding === undefined ? current.queryEmbedding : input.queryEmbedding,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE tests SET name = @name, source = @source, query = @query,
           normalized_query = @normalizedQuery, query_embedding = @queryEmbedding,
           entry_url = @entryUrl, step_hash = @stepHash,
           description = @description, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        name: next.name,
        source: next.source,
        query: next.query,
        normalizedQuery: next.normalizedQuery,
        queryEmbedding: next.queryEmbedding,
        entryUrl: next.entryUrl,
        stepHash: next.stepHash,
        description: next.description,
        updatedAt: next.updatedAt,
      });
    return this.getTest(id)!;
  }

  deleteTest(id: number): void {
    this.db.prepare(`DELETE FROM tests WHERE id = ?`).run(id);
  }

  // ----- steps ------------------------------------------------------------

  addStep(testId: number, input: NewStep): Step {
    const { maxIdx } = this.db
      .prepare(`SELECT COALESCE(MAX(idx), -1) AS maxIdx FROM steps WHERE test_id = ?`)
      .get(testId) as { maxIdx: number };
    const idx = maxIdx + 1;
    return this.insertStep(testId, idx, input);
  }

  insertStep(testId: number, idx: number, input: NewStep): Step {
    const result = this.db
      .prepare(
        `INSERT INTO steps (
           test_id, idx, action, selector, value, locators_json, element_fingerprint,
           page_signature_before, page_signature_after, wait_condition_json, assertion_json, optional
         ) VALUES (
           @testId, @idx, @action, @selector, @value, @locatorsJson, @elementFingerprint,
           @pageSignatureBefore, @pageSignatureAfter, @waitConditionJson, @assertionJson, @optional
         )`,
      )
      .run({
        testId,
        idx,
        action: input.action,
        selector: input.selector ?? null,
        value: input.value ?? null,
        locatorsJson: input.locators ? JSON.stringify(input.locators) : null,
        elementFingerprint: input.elementFingerprint ?? null,
        pageSignatureBefore: input.pageSignatureBefore ?? null,
        pageSignatureAfter: input.pageSignatureAfter ?? null,
        waitConditionJson: input.waitCondition ? JSON.stringify(input.waitCondition) : null,
        assertionJson: input.assertion ? JSON.stringify(input.assertion) : null,
        optional: input.optional ? 1 : 0,
      });
    return this.getStep(Number(result.lastInsertRowid))!;
  }

  getStep(id: number): Step | null {
    const row = this.db
      .prepare(`SELECT * FROM steps WHERE id = ?`)
      .get(id) as StepRow | undefined;
    return row ? mapStep(row) : null;
  }

  updateStep(id: number, input: Partial<NewStep>): Step {
    const current = this.getStep(id);
    if (!current) throw new Error(`No step with id ${id}`);
    this.db
      .prepare(
        `UPDATE steps SET
           action = @action, selector = @selector, value = @value,
           locators_json = @locatorsJson, element_fingerprint = @elementFingerprint,
           page_signature_before = @pageSignatureBefore, page_signature_after = @pageSignatureAfter,
           wait_condition_json = @waitConditionJson, assertion_json = @assertionJson,
           optional = @optional
         WHERE id = @id`,
      )
      .run({
        id,
        action: input.action ?? current.action,
        selector: input.selector === undefined ? current.selector : input.selector,
        value: input.value === undefined ? current.value : input.value,
        locatorsJson:
          input.locators === undefined ? JSON.stringify(current.locators) : input.locators ? JSON.stringify(input.locators) : null,
        elementFingerprint:
          input.elementFingerprint === undefined
            ? current.elementFingerprint
            : input.elementFingerprint,
        pageSignatureBefore:
          input.pageSignatureBefore === undefined
            ? current.pageSignatureBefore
            : input.pageSignatureBefore,
        pageSignatureAfter:
          input.pageSignatureAfter === undefined
            ? current.pageSignatureAfter
            : input.pageSignatureAfter,
        waitConditionJson:
          input.waitCondition === undefined
            ? JSON.stringify(current.waitCondition)
            : input.waitCondition
              ? JSON.stringify(input.waitCondition)
              : null,
        assertionJson:
          input.assertion === undefined
            ? JSON.stringify(current.assertion)
            : input.assertion
              ? JSON.stringify(input.assertion)
              : null,
        optional: input.optional === undefined ? (current.optional ? 1 : 0) : (input.optional ? 1 : 0),
      });
    return this.getStep(id)!;
  }

  listStepsByTest(testId: number): Step[] {
    const rows = this.db
      .prepare(`SELECT * FROM steps WHERE test_id = ? ORDER BY idx`)
      .all(testId) as StepRow[];
    return rows.map(mapStep);
  }

  deleteStepsByTest(testId: number): void {
    this.db.prepare(`DELETE FROM steps WHERE test_id = ?`).run(testId);
  }

  /** Replace a test's steps in place and refresh its step_hash (used by the
   *  macro minimizer in QF-57). Slots are left untouched. */
  replaceSteps(testId: number, input: { stepHash: string; steps: NewStep[] }): void {
    this.db.transaction(() => {
      this.deleteStepsByTest(testId);
      input.steps.forEach((step, idx) => this.insertStep(testId, idx, step));
      this.db
        .prepare(`UPDATE tests SET step_hash = @stepHash, updated_at = @now WHERE id = @id`)
        .run({ stepHash: input.stepHash, now: now(), id: testId });
    })();
  }

  // ----- slots ------------------------------------------------------------

  addSlot(testId: number, input: NewSlot): Slot {
    const result = this.db
      .prepare(
        `INSERT INTO slots (test_id, name, kind, default_value) VALUES (@testId, @name, @kind, @defaultValue)`,
      )
      .run({
        testId,
        name: input.name,
        kind: input.kind,
        defaultValue: input.defaultValue ?? null,
      });
    return this.getSlot(Number(result.lastInsertRowid))!;
  }

  getSlot(id: number): Slot | null {
    const row = this.db
      .prepare(`SELECT * FROM slots WHERE id = ?`)
      .get(id) as SlotRow | undefined;
    return row ? mapSlot(row) : null;
  }

  listSlotsByTest(testId: number): Slot[] {
    const rows = this.db
      .prepare(`SELECT * FROM slots WHERE test_id = ? ORDER BY id`)
      .all(testId) as SlotRow[];
    return rows.map(mapSlot);
  }

  deleteSlotsByTest(testId: number): void {
    this.db.prepare(`DELETE FROM slots WHERE test_id = ?`).run(testId);
  }

  // ----- saveTest (transactional) -----------------------------------------

  /**
   * Persist a test with its steps and slots atomically. A test already
   * recorded with the same `entryUrl` + `stepHash` is updated in place
   * (steps/slots replaced) instead of duplicated. Returns the test id and
   * whether a new row was created.
   */
  saveTest(input: SaveTestInput): SaveTestResult {
    const run = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id FROM tests WHERE entry_url = ? AND step_hash = ? ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(input.entryUrl, input.stepHash) as { id: number } | undefined;

      let id: number;
      let created: boolean;
      if (existing) {
        id = existing.id;
        this.updateTest(id, {
          name: input.name,
          source: input.source,
          query: input.query ?? null,
          normalizedQuery: input.normalizedQuery ?? null,
          queryEmbedding: input.queryEmbedding ?? null,
          entryUrl: input.entryUrl,
          stepHash: input.stepHash,
          description: input.description ?? null,
        });
        created = false;
      } else {
        id = this.createTest({
          name: input.name,
          source: input.source,
          query: input.query ?? null,
          normalizedQuery: input.normalizedQuery ?? null,
          queryEmbedding: input.queryEmbedding ?? null,
          entryUrl: input.entryUrl,
          stepHash: input.stepHash,
          description: input.description ?? null,
        }).id;
        created = true;
      }

      this.deleteStepsByTest(id);
      this.deleteSlotsByTest(id);
      input.steps.forEach((step, idx) => this.insertStep(id, idx, step));
      const uniqueSlots: typeof input.slots = [];
      const seenNames = new Set<string>();
      for (const slot of input.slots) {
        if (!seenNames.has(slot.name)) {
          seenNames.add(slot.name);
          uniqueSlots.push(slot);
        }
      }
      for (const slot of uniqueSlots) this.addSlot(id, slot);
      return { id, created };
    });
    return run();
  }

  // ----- runs -------------------------------------------------------------

  createRun(input: NewRun): Run {
    const result = this.db
      .prepare(
        `INSERT INTO runs (test_id, status, llm_calls, started_at, error_json)
         VALUES (@testId, @status, @llmCalls, @startedAt, @errorJson)`,
      )
      .run({
        testId: input.testId,
        status: input.status,
        llmCalls: input.llmCalls ?? 0,
        startedAt: input.startedAt ?? now(),
        errorJson: input.error === undefined ? null : JSON.stringify(input.error),
      });
    return this.getRun(Number(result.lastInsertRowid))!;
  }

  getRun(id: number): Run | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  getRunWithSteps(id: number): RunWithSteps | null {
    const run = this.getRun(id);
    if (!run) return null;
    const rows = this.db
      .prepare(`SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx`)
      .all(id) as RunStepRow[];
    return { ...run, steps: rows.map(mapRunStep) };
  }

  listRuns(testId?: number): Run[] {
    const rows = testId === undefined
      ? (this.db.prepare(`SELECT * FROM runs ORDER BY id`).all() as RunRow[])
      : (this.db.prepare(`SELECT * FROM runs WHERE test_id = ? ORDER BY id`).all(testId) as RunRow[]);
    return rows.map(mapRun);
  }

  finishRun(id: number, status: Run["status"], error?: unknown): Run {
    const run = this.getRun(id);
    if (!run) throw new Error(`No run with id ${id}`);
    this.db
      .prepare(`UPDATE runs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?`)
      .run(status, now(), error === undefined ? null : JSON.stringify(error), id);
    return this.getRun(id)!;
  }

  // ----- run_steps --------------------------------------------------------

  addRunStep(runId: number, input: NewRunStep): RunStep {
    const result = this.db
      .prepare(
        `INSERT INTO run_steps (run_id, step_id, idx, status, detail_json, created_at)
         VALUES (@runId, @stepId, @idx, @status, @detailJson, @createdAt)`,
      )
      .run({
        runId,
        stepId: input.stepId ?? null,
        idx: input.idx,
        status: input.status,
        detailJson: input.detail === undefined ? null : JSON.stringify(input.detail),
        createdAt: now(),
      });
    const row = this.db
      .prepare(`SELECT * FROM run_steps WHERE id = ?`)
      .get(Number(result.lastInsertRowid)) as RunStepRow;
    return mapRunStep(row);
  }

  listRunStepsByRun(runId: number): RunStep[] {
    const rows = this.db
      .prepare(`SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx`)
      .all(runId) as RunStepRow[];
    return rows.map(mapRunStep);
  }

  // ----- test_versions ----------------------------------------------------

  createVersion(input: NewTestVersion): TestVersion {
    const result = this.db
      .prepare(
        `INSERT INTO test_versions (test_id, version, steps_json, slots_json, reason, created_at)
         VALUES (@testId, @version, @stepsJson, @slotsJson, @reason, @createdAt)`,
      )
      .run({
        testId: input.testId,
        version: input.version,
        stepsJson: JSON.stringify(input.steps),
        slotsJson: JSON.stringify(input.slots),
        reason: input.reason ?? null,
        createdAt: now(),
      });
    return this.getVersion(Number(result.lastInsertRowid))!;
  }

  getVersion(id: number): TestVersion | null {
    const row = this.db
      .prepare(`SELECT * FROM test_versions WHERE id = ?`)
      .get(id) as TestVersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  listVersionsByTest(testId: number): TestVersion[] {
    const rows = this.db
      .prepare(`SELECT * FROM test_versions WHERE test_id = ? ORDER BY version`)
      .all(testId) as TestVersionRow[];
    return rows.map(mapVersion);
  }

  /** Restore a test's steps + slots to a recorded version (Self-Heal QF-68 rollback).
   * Returns false if the version does not exist for the test. Idempotent step
   * re-hashing keeps the `tests.step_hash` dedupe key consistent with the
   * restored steps. */
  restoreVersion(testId: number, version: number): boolean {
    const rows = this.db
      .prepare(`SELECT * FROM test_versions WHERE test_id = ? AND version = ?`)
      .all(testId, version) as TestVersionRow[];
    const target = rows[0];
    if (!target) return false;
    const storedSteps = (jsonParse<unknown[]>(target.steps_json) ?? []) as NewStep[];
    const storedSlots = (jsonParse<unknown[]>(target.slots_json) ?? []) as NewSlot[];
    this.db.transaction(() => {
      this.replaceSteps(testId, {
        stepHash: hashSteps(storedSteps as unknown as Parameters<typeof hashSteps>[0]),
        steps: storedSteps,
      });
      this.deleteSlotsByTest(testId);
      for (const slot of storedSlots) {
        this.addSlot(testId, {
          name: slot.name,
          kind: slot.kind,
          defaultValue: slot.defaultValue,
        });
      }
      this.db
        .prepare(`UPDATE tests SET updated_at = @now WHERE id = @id`)
        .run({ now: now(), id: testId });
    })();
    return true;
  }

  /** Record an additional LLM call against an in-progress run (e.g. a self-heal). */
  addRunLlmCalls(runId: number, calls: number): void {
    if (!calls) return;
    this.db
      .prepare(`UPDATE runs SET llm_calls = llm_calls + @calls WHERE id = @runId`)
      .run({ calls, runId });
  }

  // ----- site_memory ------------------------------------------------------

  upsertMemory(input: NewSiteMemory): SiteMemory {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO site_memory (site, kind, key, value_json, confidence, created_at, updated_at)
         VALUES (@site, @kind, @key, @valueJson, @confidence, @createdAt, @updatedAt)
         ON CONFLICT(site, kind, key) DO UPDATE SET
           value_json = @valueJson, confidence = @confidence, updated_at = @updatedAt`,
      )
      .run({
        site: input.site,
        kind: input.kind,
        key: input.key,
        valueJson: JSON.stringify(input.value),
        confidence: input.confidence ?? 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    return this.getMemory(input.site, input.kind, input.key)!;
  }

  getMemory(site: string, kind: string, key: string): SiteMemory | null {
    const row = this.db
      .prepare(`SELECT * FROM site_memory WHERE site = ? AND kind = ? AND key = ?`)
      .get(site, kind, key) as SiteMemoryRow | undefined;
    return row ? mapMemory(row) : null;
  }

  listMemory(site: string, kind?: string): SiteMemory[] {
    const rows = kind === undefined
      ? (this.db.prepare(`SELECT * FROM site_memory WHERE site = ? ORDER BY id`).all(site) as SiteMemoryRow[])
      : (this.db.prepare(`SELECT * FROM site_memory WHERE site = ? AND kind = ? ORDER BY id`).all(site, kind) as SiteMemoryRow[]);
    return rows.map(mapMemory);
  }

  /** Remove ALL site-memory rows (used by `qf memory clear`). */
  clearAllMemory(): number {
    return Number(this.db.prepare(`DELETE FROM site_memory`).run().changes);
  }

  deleteMemory(site: string, kind?: string): number {
    const stmt = kind === undefined
      ? this.db.prepare(`DELETE FROM site_memory WHERE site = ?`)
      : this.db.prepare(`DELETE FROM site_memory WHERE site = ? AND kind = ?`);
    const info = kind === undefined ? stmt.run(site) : stmt.run(site, kind);
    return Number(info.changes);
  }
}

function mapTest(row: TestRow): Test {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    query: row.query,
    normalizedQuery: row.normalized_query,
    queryEmbedding: row.query_embedding
      ? new Uint8Array(row.query_embedding)
      : null,
    entryUrl: row.entry_url,
    stepHash: row.step_hash,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStep(row: StepRow): Step {
  return {
    id: row.id,
    testId: row.test_id,
    idx: row.idx,
    action: row.action as Step["action"],
    selector: row.selector,
    value: row.value,
    locators: jsonParse<string[]>(row.locators_json),
    elementFingerprint: row.element_fingerprint,
    pageSignatureBefore: row.page_signature_before,
    pageSignatureAfter: row.page_signature_after,
    waitCondition: jsonParse<WaitCondition>(row.wait_condition_json),
    assertion: jsonParse<Assertion>(row.assertion_json),
    optional: Boolean(row.optional ?? 0),
  };
}

function mapSlot(row: SlotRow): Slot {
  return {
    id: row.id,
    testId: row.test_id,
    name: row.name,
    kind: row.kind as Slot["kind"],
    defaultValue: row.default_value,
  };
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    testId: row.test_id,
    status: row.status as Run["status"],
    llmCalls: row.llm_calls,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: jsonParse(row.error_json),
  };
}

function mapRunStep(row: RunStepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    idx: row.idx,
    status: row.status as RunStep["status"],
    detail: jsonParse(row.detail_json),
    createdAt: row.created_at,
  };
}

function mapVersion(row: TestVersionRow): TestVersion {
  return {
    id: row.id,
    testId: row.test_id,
    version: row.version,
    steps: jsonParse<unknown[]>(row.steps_json) ?? [],
    slots: jsonParse<unknown[]>(row.slots_json) ?? [],
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapMemory(row: SiteMemoryRow): SiteMemory {
  return {
    id: row.id,
    site: row.site,
    kind: row.kind,
    key: row.key,
    value: jsonParse(row.value_json),
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

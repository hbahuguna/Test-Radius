export interface Migration {
  version: number;
  name: string;
  sql: string[];
}

/**
 * Ordered migrations. Each entry runs in its own transaction and is recorded
 * in `schema_migrations`; `runMigrations` only applies versions not yet
 * recorded, so repeated runs are no-ops.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init-queryfirst",
    sql: [
      `CREATE TABLE tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        query TEXT,
        normalized_query TEXT,
        query_embedding BLOB,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        action TEXT NOT NULL,
        selector TEXT,
        value TEXT,
        locators_json TEXT,
        element_fingerprint TEXT,
        page_signature_before TEXT,
        page_signature_after TEXT,
        wait_condition_json TEXT,
        assertion_json TEXT,
        UNIQUE(test_id, idx)
      )`,
      `CREATE INDEX idx_steps_test_id ON steps(test_id)`,
      `CREATE TABLE slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        default_value TEXT,
        UNIQUE(test_id, name)
      )`,
      `CREATE INDEX idx_slots_test_id ON slots(test_id)`,
      `CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        llm_calls INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_json TEXT
      )`,
      `CREATE INDEX idx_runs_test_id ON runs(test_id)`,
      `CREATE TABLE run_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id INTEGER REFERENCES steps(id) ON DELETE SET NULL,
        idx INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_run_steps_run_id ON run_steps(run_id)`,
      `CREATE TABLE test_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        steps_json TEXT NOT NULL,
        slots_json TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(test_id, version)
      )`,
      `CREATE INDEX idx_test_versions_test_id ON test_versions(test_id)`,
      `CREATE TABLE site_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(site, kind, key)
      )`,
    ],
  },
  {
    version: 2,
    name: "add-recorder-columns",
    sql: [
      `ALTER TABLE tests ADD COLUMN entry_url TEXT`,
      `ALTER TABLE tests ADD COLUMN step_hash TEXT`,
      `CREATE INDEX idx_tests_entry_hash ON tests(entry_url, step_hash)`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

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
  {
    version: 3,
    name: "add-step-optional",
    sql: [
      // Mark steps that target conditional/ephemeral elements (cookie banners,
      // consent overlays, tour modals) so the replay engine can skip them
      // gracefully instead of failing when they don't appear.
      `ALTER TABLE steps ADD COLUMN optional INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 4,
    name: "add-suites-and-trains",
    sql: [
      `CREATE TABLE suites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        mode TEXT NOT NULL DEFAULT 'sequential',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE suite_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suite_id INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        UNIQUE(suite_id, position)
      )`,
      `CREATE INDEX idx_suite_tests_suite_id ON suite_tests(suite_id)`,
      `CREATE TABLE trains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        mode TEXT NOT NULL DEFAULT 'sequential',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE train_suites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        train_id INTEGER NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
        suite_id INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        UNIQUE(train_id, position)
      )`,
      `CREATE INDEX idx_train_suites_train_id ON train_suites(train_id)`,
      `CREATE TABLE suite_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suite_id INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_json TEXT
      )`,
      `CREATE INDEX idx_suite_runs_suite_id ON suite_runs(suite_id)`,
      `CREATE TABLE train_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        train_id INTEGER NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_json TEXT
      )`,
      `CREATE INDEX idx_train_runs_train_id ON train_runs(train_id)`,
      `ALTER TABLE runs ADD COLUMN suite_run_id INTEGER REFERENCES suite_runs(id)`,
      `ALTER TABLE suite_runs ADD COLUMN train_run_id INTEGER REFERENCES train_runs(id)`,
    ],
  },
  {
    version: 5,
    name: "add-per-member-parallel",
    sql: [
      `ALTER TABLE suite_tests ADD COLUMN parallel INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE train_suites ADD COLUMN parallel INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 6,
    name: "add-completion-hint",
    sql: [
      // A short phrase captured from the browser-use agent's done message that
      // identifies the success state of the page (e.g. "Thanks for signing up").
      // During replay, if this phrase is already visible in document.body.innerText
      // the remaining steps are skipped and the run is marked as passed — making
      // tests idempotent against one-time side effects (form submissions, etc.).
      `ALTER TABLE tests ADD COLUMN completion_hint TEXT`,
    ],
  },
  {
    version: 7,
    name: "add-suite-type-and-api-sessions",
    sql: [
      `ALTER TABLE suites ADD COLUMN type TEXT NOT NULL DEFAULT 'ui'`,
      `CREATE TABLE suite_api_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suite_id INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
        session_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        UNIQUE(suite_id, position)
      )`,
      `CREATE INDEX idx_suite_api_sessions_suite_id ON suite_api_sessions(suite_id)`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

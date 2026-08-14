import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATIONS } from "./schema.js";

export const DB_FILENAME = "queryfirst.db";

export interface OpenDatabaseOptions {
  /** Move a corrupt DB file aside and recreate it instead of failing. */
  recoverCorrupt?: boolean;
}

export interface MigrationResult {
  applied: string[];
}

function openAndConfigure(dbPath: string): DatabaseType {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
  } catch (err) {
    try {
      db.close();
    } catch {
      // best effort — the handle may not have opened
    }
    throw err;
  }
  return db;
}

/**
 * Open (creating if needed) the SQLite database at `dataDir/queryfirst.db`,
 * set it to WAL journal mode with foreign keys enabled, and apply any pending
 * migrations. A corrupt DB file is moved aside and recreated when
 * `recoverCorrupt` is true.
 */
export function openDatabase(
  dataDir: string,
  options: OpenDatabaseOptions = {},
): DatabaseType {
  const { recoverCorrupt = true } = options;
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, DB_FILENAME);

  let db: DatabaseType;
  try {
    db = openAndConfigure(dbPath);
  } catch (err) {
    if (!recoverCorrupt) throw err;
    const aside = `${dbPath}.corrupt-${Date.now()}`;
    renameSync(dbPath, aside);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    db = openAndConfigure(dbPath);
  }

  runMigrations(db);
  return db;
}

/**
 * Apply every migration not yet recorded in `schema_migrations`. Each
 * migration runs atomically inside a transaction; versions already recorded
 * are skipped, so calling this repeatedly is idempotent.
 */
export function runMigrations(db: DatabaseType): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedVersions = new Set(
    db.prepare("SELECT version FROM schema_migrations").pluck().all() as number[],
  );

  const apply = db.transaction((migration: (typeof MIGRATIONS)[number]) => {
    for (const statement of migration.sql) {
      const trimmed = statement.trim();
      if (trimmed) db.exec(trimmed);
    }
    db.prepare(
      `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
    ).run(migration.version, migration.name, new Date().toISOString());
  });

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;
    apply(migration);
    applied.push(migration.name);
  }
  return { applied };
}

export function journalMode(db: DatabaseType): string {
  return db.pragma("journal_mode", { simple: true }) as string;
}

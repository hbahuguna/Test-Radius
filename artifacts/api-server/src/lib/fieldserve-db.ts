import Database from "better-sqlite3";
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  name: string;
  sql: string[];
}

export type JobStatus =
  | "created"
  | "scheduled"
  | "assigned"
  | "engineer-dispatched"
  | "en-route"
  | "on-site"
  | "checking-in"
  | "waiting-for-access"
  | "waiting-for-equipment"
  | "in-progress"
  | "on-hold"
  | "completed"
  | "failed"
  | "cancelled"
  | "deferred"
  | "facility-not-accessible"
  | "parts-required"
  | "requires-rescheduling";

export type Priority = "critical" | "high" | "medium" | "low";
export type EngineerStatus = "available" | "busy" | "on-leave";

// Row types (snake_case from DB)
interface JobRow {
  id: number;
  title: string;
  description: string | null;
  site_id: number;
  skill_required: string;
  priority: Priority;
  status: JobStatus;
  assigned_engineer_id: number | null;
  scheduled_date: string | null;
  estimated_duration: number | null;
  sla_deadline: string | null;
  created_at: string;
  updated_at: string;
}

interface EngineerRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  employee_id: string;
  skills: string; // JSON array
  status: EngineerStatus;
  current_lat: number | null;
  current_lng: number | null;
  created_at: string;
}

interface SiteRow {
  id: number;
  name: string;
  address: string;
  city: string;
  postcode: string;
  lat: number | null;
  lng: number | null;
  access_instructions: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  created_at: string;
}

interface JobUpdateRow {
  id: number;
  job_id: number;
  engineer_id: number | null;
  from_status: string | null;
  to_status: string;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  created_at: string;
}

interface AttachmentRow {
  id: number;
  job_id: number;
  engineer_id: number | null;
  file_name: string;
  file_type: string;
  file_size: number;
  created_at: string;
}

interface RecordedSessionRow {
  id: number;
  name: string;
  base_url: string;
  started_at: string;
  ended_at: string | null;
  step_count: number;
  api_spec: string | null;
  api_spec_url: string | null;
}

interface RecordedStepRow {
  id: number;
  session_id: number;
  seq: number;
  method: string;
  path: string;
  request_headers: string;
  request_body: string | null;
  response_status: number;
  response_headers: string;
  response_body: string;
  duration_ms: number;
  created_at: string;
}

// App types (camelCase)
export interface Job {
  id: number;
  title: string;
  description: string | null;
  siteId: number;
  skillRequired: string;
  priority: Priority;
  status: JobStatus;
  assignedEngineerId: number | null;
  scheduledDate: string | null;
  estimatedDuration: number | null;
  slaDeadline: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobWithRelations extends Job {
  site?: Site;
  engineer?: Engineer;
  updates?: JobUpdate[];
  attachments?: Attachment[];
}

export interface Engineer {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  employeeId: string;
  skills: string[];
  status: EngineerStatus;
  currentLat: number | null;
  currentLng: number | null;
  createdAt: string;
}

export interface EngineerWithRelations extends Engineer {
  activeJob?: Job;
}

export interface Site {
  id: number;
  name: string;
  address: string;
  city: string;
  postcode: string;
  lat: number | null;
  lng: number | null;
  accessInstructions: string | null;
  contactName: string | null;
  contactPhone: string | null;
  createdAt: string;
}

export interface JobUpdate {
  id: number;
  jobId: number;
  engineerId: number | null;
  fromStatus: string | null;
  toStatus: string;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: string;
}

export interface Attachment {
  id: number;
  jobId: number;
  engineerId: number | null;
  fileName: string;
  fileType: string;
  fileSize: number;
  createdAt: string;
}

export interface RecordedSession {
  id: number;
  name: string;
  baseUrl: string;
  startedAt: string;
  endedAt: string | null;
  stepCount: number;
  apiSpec: string | null;
  apiSpecUrl: string | null;
}

export interface RecordedStep {
  id: number;
  sessionId: number;
  seq: number;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  durationMs: number;
  createdAt: string;
}

export interface CreateJobInput {
  title: string;
  description?: string;
  siteId: number;
  skillRequired: string;
  priority?: Priority;
  scheduledDate?: string;
  estimatedDuration?: number;
  slaDeadline?: string;
}

export interface CreateEngineerInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  employeeId: string;
  skills?: string[];
}

export interface CreateSiteInput {
  name: string;
  address: string;
  city: string;
  postcode: string;
  lat?: number;
  lng?: number;
  accessInstructions?: string;
  contactName?: string;
  contactPhone?: string;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init-fieldserve",
    sql: [
      `CREATE TABLE fs_api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        active INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE fs_sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        city TEXT NOT NULL,
        postcode TEXT NOT NULL,
        lat REAL,
        lng REAL,
        access_instructions TEXT,
        contact_name TEXT,
        contact_phone TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE fs_engineers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        employee_id TEXT NOT NULL UNIQUE,
        skills TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','busy','on-leave')),
        current_lat REAL,
        current_lng REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE fs_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        site_id INTEGER NOT NULL REFERENCES fs_sites(id),
        skill_required TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('critical','high','medium','low')),
        status TEXT NOT NULL DEFAULT 'created' CHECK(status IN (
          'created','scheduled','assigned','engineer-dispatched',
          'en-route','on-site','checking-in','waiting-for-access',
          'waiting-for-equipment','in-progress','on-hold',
          'completed','failed','cancelled','deferred',
          'facility-not-accessible','parts-required','requires-rescheduling'
        )),
        assigned_engineer_id INTEGER REFERENCES fs_engineers(id),
        scheduled_date TEXT,
        estimated_duration INTEGER,
        sla_deadline TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE fs_job_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES fs_jobs(id) ON DELETE CASCADE,
        engineer_id INTEGER REFERENCES fs_engineers(id),
        from_status TEXT,
        to_status TEXT NOT NULL,
        notes TEXT,
        lat REAL,
        lng REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE fs_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES fs_jobs(id) ON DELETE CASCADE,
        engineer_id INTEGER REFERENCES fs_engineers(id),
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX idx_fs_jobs_status ON fs_jobs(status)`,
      `CREATE INDEX idx_fs_jobs_engineer ON fs_jobs(assigned_engineer_id)`,
      `CREATE INDEX idx_fs_jobs_site ON fs_jobs(site_id)`,
      `CREATE INDEX idx_fs_job_updates_job ON fs_job_updates(job_id)`,
      `CREATE INDEX idx_fs_engineers_status ON fs_engineers(status)`,
    ],
  },
  {
    version: 2,
    name: "fieldserve-recording",
    sql: [
      `CREATE TABLE fs_recorded_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        step_count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE fs_recorded_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES fs_recorded_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_headers TEXT NOT NULL DEFAULT '{}',
        request_body TEXT,
        response_status INTEGER NOT NULL,
        response_headers TEXT NOT NULL DEFAULT '{}',
        response_body TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX idx_fs_recorded_steps_session ON fs_recorded_steps(session_id)`,
    ],
  },
  {
    version: 3,
    name: "fieldserve-api-spec",
    sql: [
      `ALTER TABLE fs_recorded_sessions ADD COLUMN api_spec TEXT`,
      `ALTER TABLE fs_recorded_sessions ADD COLUMN api_spec_url TEXT`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

const DB_FILENAME = "fieldserve.db";

function openAndConfigure(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export interface MigrationResult {
  applied: string[];
}

export function runMigrations(db: Database.Database): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedVersions = new Set(
    db.prepare("SELECT version FROM schema_migrations").pluck().all() as number[],
  );

  const apply = db.transaction((migration: Migration) => {
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

let dbInstance: Database.Database | null = null;

export function getFieldServeDb(dataDir?: string): Database.Database {
  if (dbInstance) return dbInstance;

  const dir = dataDir ?? join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, DB_FILENAME);

  if (existsSync(dbPath)) {
    try {
      const test = new Database(dbPath);
      test.close();
    } catch {
      const corrupt = `${dbPath}.corrupt-${Date.now()}`;
      renameSync(dbPath, corrupt);
    }
  }

  dbInstance = openAndConfigure(dbPath);
  runMigrations(dbInstance);
  return dbInstance;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapJob(r: JobRow): Job {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    siteId: r.site_id,
    skillRequired: r.skill_required,
    priority: r.priority,
    status: r.status,
    assignedEngineerId: r.assigned_engineer_id,
    scheduledDate: r.scheduled_date,
    estimatedDuration: r.estimated_duration,
    slaDeadline: r.sla_deadline,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapEngineer(r: EngineerRow): Engineer {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    employeeId: r.employee_id,
    skills: JSON.parse(r.skills) as string[],
    status: r.status,
    currentLat: r.current_lat,
    currentLng: r.current_lng,
    createdAt: r.created_at,
  };
}

function mapSite(r: SiteRow): Site {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    city: r.city,
    postcode: r.postcode,
    lat: r.lat,
    lng: r.lng,
    accessInstructions: r.access_instructions,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    createdAt: r.created_at,
  };
}

function mapJobUpdate(r: JobUpdateRow): JobUpdate {
  return {
    id: r.id,
    jobId: r.job_id,
    engineerId: r.engineer_id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    notes: r.notes,
    lat: r.lat,
    lng: r.lng,
    createdAt: r.created_at,
  };
}

function mapAttachment(r: AttachmentRow): Attachment {
  return {
    id: r.id,
    jobId: r.job_id,
    engineerId: r.engineer_id,
    fileName: r.file_name,
    fileType: r.file_type,
    fileSize: r.file_size,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<string, string[]> = {
  created: ["scheduled", "cancelled"],
  scheduled: ["assigned", "cancelled"],
  assigned: ["engineer-dispatched", "cancelled"],
  "engineer-dispatched": ["en-route", "cancelled"],
  "en-route": ["on-site", "cancelled"],
  "on-site": ["checking-in", "cancelled"],
  "checking-in": ["waiting-for-access", "waiting-for-equipment", "in-progress"],
  "waiting-for-access": ["waiting-for-equipment", "in-progress", "facility-not-accessible"],
  "waiting-for-equipment": ["in-progress", "parts-required"],
  "in-progress": ["on-hold", "completed", "failed"],
  "on-hold": ["in-progress", "cancelled"],
  completed: [],
  failed: ["requires-rescheduling"],
  cancelled: [],
  deferred: ["created"],
  "facility-not-accessible": ["requires-rescheduling", "cancelled"],
  "parts-required": ["in-progress", "cancelled"],
  "requires-rescheduling": ["created", "cancelled"],
};

export function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// DataStore
// ---------------------------------------------------------------------------

export class FieldServeDataStore {
  constructor(private db: Database.Database) {}

  now(): string {
    return new Date().toISOString();
  }

  // ---- Jobs ----

  listJobs(filters?: {
    status?: string;
    engineerId?: number;
    siteId?: number;
    priority?: string;
    page?: number;
    limit?: number;
    sort?: string;
    order?: "asc" | "desc";
  }): { jobs: Job[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.engineerId) {
      where.push("assigned_engineer_id = ?");
      params.push(filters.engineerId);
    }
    if (filters?.siteId) {
      where.push("site_id = ?");
      params.push(filters.siteId);
    }
    if (filters?.priority) {
      where.push("priority = ?");
      params.push(filters.priority);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.db.prepare(`SELECT COUNT(*) as cnt FROM fs_jobs ${whereClause}`).get(...params) as { cnt: number }
    ).cnt;

    const sortCol = filters?.sort === "priority" ? "priority" : filters?.sort === "scheduled_date" ? "scheduled_date" : "created_at";
    const sortOrder = filters?.order === "asc" ? "ASC" : "DESC";
    const limit = Math.min(filters?.limit ?? 50, 200);
    const offset = (filters?.page ?? 0) * limit;

    const rows = this.db
      .prepare(`SELECT * FROM fs_jobs ${whereClause} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as JobRow[];

    return { jobs: rows.map(mapJob), total };
  }

  getJob(id: number): JobWithRelations | null {
    const row = this.db.prepare("SELECT * FROM fs_jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!row) return null;

    const job = mapJob(row);

    const site = this.db.prepare("SELECT * FROM fs_sites WHERE id = ?").get(row.site_id) as SiteRow | undefined;
    const engineer = row.assigned_engineer_id
      ? (this.db.prepare("SELECT * FROM fs_engineers WHERE id = ?").get(row.assigned_engineer_id) as EngineerRow | undefined)
      : undefined;
    const updates = this.db
      .prepare("SELECT * FROM fs_job_updates WHERE job_id = ? ORDER BY created_at ASC")
      .all(id) as JobUpdateRow[];
    const attachments = this.db
      .prepare("SELECT * FROM fs_attachments WHERE job_id = ? ORDER BY created_at ASC")
      .all(id) as AttachmentRow[];

    return {
      ...job,
      site: site ? mapSite(site) : undefined,
      engineer: engineer ? mapEngineer(engineer) : undefined,
      updates: updates.map(mapJobUpdate),
      attachments: attachments.map(mapAttachment),
    };
  }

  createJob(input: CreateJobInput): Job {
    const ts = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO fs_jobs (title, description, site_id, skill_required, priority, status, scheduled_date, estimated_duration, sla_deadline, created_at, updated_at)
         VALUES (@title, @description, @siteId, @skillRequired, @priority, 'created', @scheduledDate, @estimatedDuration, @slaDeadline, @createdAt, @updatedAt)`,
      )
      .run({
        title: input.title,
        description: input.description ?? null,
        siteId: input.siteId,
        skillRequired: input.skillRequired,
        priority: input.priority ?? "medium",
        scheduledDate: input.scheduledDate ?? null,
        estimatedDuration: input.estimatedDuration ?? null,
        slaDeadline: input.slaDeadline ?? null,
        createdAt: ts,
        updatedAt: ts,
      });

    return this.getJob(Number(result.lastInsertRowid))!;
  }

  updateJob(
    id: number,
    input: Partial<Pick<CreateJobInput, "title" | "description" | "priority" | "scheduledDate" | "estimatedDuration" | "slaDeadline" | "siteId" | "skillRequired">>,
  ): Job | null {
    const existing = this.db.prepare("SELECT * FROM fs_jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!existing) return null;

    const fields: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: this.now() };

    if (input.title !== undefined) { fields.push("title = @title"); params.title = input.title; }
    if (input.description !== undefined) { fields.push("description = @description"); params.description = input.description; }
    if (input.priority !== undefined) { fields.push("priority = @priority"); params.priority = input.priority; }
    if (input.scheduledDate !== undefined) { fields.push("scheduled_date = @scheduledDate"); params.scheduledDate = input.scheduledDate; }
    if (input.estimatedDuration !== undefined) { fields.push("estimated_duration = @estimatedDuration"); params.estimatedDuration = input.estimatedDuration; }
    if (input.slaDeadline !== undefined) { fields.push("sla_deadline = @slaDeadline"); params.slaDeadline = input.slaDeadline; }
    if (input.siteId !== undefined) { fields.push("site_id = @siteId"); params.siteId = input.siteId; }
    if (input.skillRequired !== undefined) { fields.push("skill_required = @skillRequired"); params.skillRequired = input.skillRequired; }

    if (fields.length === 0) return this.getJob(id)!;

    fields.push("updated_at = @updatedAt");
    this.db.prepare(`UPDATE fs_jobs SET ${fields.join(", ")} WHERE id = @id`).run(params);
    return this.getJob(id)!;
  }

  deleteJob(id: number): boolean {
    const row = this.db.prepare("SELECT status FROM fs_jobs WHERE id = ?").get(id) as { status: string } | undefined;
    if (!row) return false;
    if (row.status !== "created") return false;
    this.db.prepare("DELETE FROM fs_jobs WHERE id = ?").run(id);
    return true;
  }

  // ---- State Transitions ----

  transitionJob(
    jobId: number,
    toStatus: string,
    opts?: { notes?: string; engineerId?: number; lat?: number; lng?: number },
  ): { job: Job; fromStatus: string } {
    const row = this.db.prepare("SELECT * FROM fs_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!row) throw { status: 404, error: "not_found", message: `Job ${jobId} not found` };

    const fromStatus = row.status;
    if (!canTransition(fromStatus, toStatus)) {
      throw {
        status: 409,
        error: "invalid_transition",
        message: `Cannot transition from '${fromStatus}' to '${toStatus}'`,
      };
    }

    const ts = this.now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE fs_jobs SET status = ?, updated_at = ? WHERE id = ?")
        .run(toStatus, ts, jobId);

      this.db
        .prepare(
          `INSERT INTO fs_job_updates (job_id, engineer_id, from_status, to_status, notes, lat, lng, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(jobId, opts?.engineerId ?? row.assigned_engineer_id, fromStatus, toStatus, opts?.notes ?? null, opts?.lat ?? null, opts?.lng ?? null, ts);
    })();

    return { job: this.getJob(jobId)!, fromStatus };
  }

  // ---- Engineers ----

  listEngineers(filters?: {
    skill?: string;
    status?: string;
    available?: boolean;
  }): Engineer[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.available) {
      where.push("status = 'available'");
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    let rows = this.db
      .prepare(`SELECT * FROM fs_engineers ${whereClause} ORDER BY last_name ASC`)
      .all(...params) as EngineerRow[];

    // Filter by skill if requested (JSON array contains)
    if (filters?.skill) {
      rows = rows.filter((r) => {
        const skills = JSON.parse(r.skills) as string[];
        return skills.includes(filters.skill!);
      });
    }

    return rows.map(mapEngineer);
  }

  getEngineer(id: number): EngineerWithRelations | null {
    const row = this.db.prepare("SELECT * FROM fs_engineers WHERE id = ?").get(id) as EngineerRow | undefined;
    if (!row) return null;

    const engineer = mapEngineer(row);
    const activeJobRow = this.db
      .prepare(
        "SELECT * FROM fs_jobs WHERE assigned_engineer_id = ? AND status NOT IN ('completed','cancelled','deferred') LIMIT 1",
      )
      .get(id) as JobRow | undefined;

    return {
      ...engineer,
      activeJob: activeJobRow ? mapJob(activeJobRow) : undefined,
    };
  }

  createEngineer(input: CreateEngineerInput): Engineer {
    const ts = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO fs_engineers (first_name, last_name, email, phone, employee_id, skills, status, created_at)
         VALUES (@firstName, @lastName, @email, @phone, @employeeId, @skills, 'available', @createdAt)`,
      )
      .run({
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone ?? null,
        employeeId: input.employeeId,
        skills: JSON.stringify(input.skills ?? []),
        createdAt: ts,
      });

    return this.getEngineer(Number(result.lastInsertRowid))!;
  }

  updateEngineer(
    id: number,
    input: Partial<Pick<CreateEngineerInput, "firstName" | "lastName" | "email" | "phone" | "skills" | "employeeId">> & { status?: EngineerStatus; currentLat?: number; currentLng?: number },
  ): Engineer | null {
    const existing = this.db.prepare("SELECT * FROM fs_engineers WHERE id = ?").get(id) as EngineerRow | undefined;
    if (!existing) return null;

    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    if (input.firstName !== undefined) { fields.push("first_name = @firstName"); params.firstName = input.firstName; }
    if (input.lastName !== undefined) { fields.push("last_name = @lastName"); params.lastName = input.lastName; }
    if (input.email !== undefined) { fields.push("email = @email"); params.email = input.email; }
    if (input.phone !== undefined) { fields.push("phone = @phone"); params.phone = input.phone; }
    if (input.employeeId !== undefined) { fields.push("employee_id = @employeeId"); params.employeeId = input.employeeId; }
    if (input.skills !== undefined) { fields.push("skills = @skills"); params.skills = JSON.stringify(input.skills); }
    if (input.status !== undefined) { fields.push("status = @status"); params.status = input.status; }
    if (input.currentLat !== undefined) { fields.push("current_lat = @currentLat"); params.currentLat = input.currentLat; }
    if (input.currentLng !== undefined) { fields.push("current_lng = @currentLng"); params.currentLng = input.currentLng; }

    if (fields.length === 0) return this.getEngineer(id)!;

    this.db.prepare(`UPDATE fs_engineers SET ${fields.join(", ")} WHERE id = @id`).run(params);
    return this.getEngineer(id)!;
  }

  getEngineerHistory(id: number): Job[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM fs_jobs WHERE assigned_engineer_id = ? AND status IN ('completed','failed','cancelled') ORDER BY updated_at DESC",
      )
      .all(id) as JobRow[];
    return rows.map(mapJob);
  }

  // ---- Sites ----

  listSites(): Site[] {
    const rows = this.db.prepare("SELECT * FROM fs_sites ORDER BY name ASC").all() as SiteRow[];
    return rows.map(mapSite);
  }

  getSite(id: number): Site | null {
    const row = this.db.prepare("SELECT * FROM fs_sites WHERE id = ?").get(id) as SiteRow | undefined;
    return row ? mapSite(row) : null;
  }

  createSite(input: CreateSiteInput): Site {
    const ts = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO fs_sites (name, address, city, postcode, lat, lng, access_instructions, contact_name, contact_phone, created_at)
         VALUES (@name, @address, @city, @postcode, @lat, @lng, @accessInstructions, @contactName, @contactPhone, @createdAt)`,
      )
      .run({
        name: input.name,
        address: input.address,
        city: input.city,
        postcode: input.postcode,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        accessInstructions: input.accessInstructions ?? null,
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        createdAt: ts,
      });

    return this.getSite(Number(result.lastInsertRowid))!;
  }

  // ---- Job Updates ----

  listJobUpdates(jobId: number): JobUpdate[] {
    const rows = this.db
      .prepare("SELECT * FROM fs_job_updates WHERE job_id = ? ORDER BY created_at ASC")
      .all(jobId) as JobUpdateRow[];
    return rows.map(mapJobUpdate);
  }

  addJobUpdate(
    jobId: number,
    engineerId: number | null,
    toStatus: string,
    notes?: string,
    lat?: number,
    lng?: number,
  ): JobUpdate {
    const row = this.db.prepare("SELECT status FROM fs_jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
    const fromStatus = row?.status ?? null;

    const ts = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO fs_job_updates (job_id, engineer_id, from_status, to_status, notes, lat, lng, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, engineerId, fromStatus, toStatus, notes ?? null, lat ?? null, lng ?? null, ts);

    return this.db
      .prepare("SELECT * FROM fs_job_updates WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as JobUpdateRow as unknown as JobUpdate;
  }

  // ---- Attachments ----

  listAttachments(jobId: number): Attachment[] {
    const rows = this.db
      .prepare("SELECT * FROM fs_attachments WHERE job_id = ? ORDER BY created_at ASC")
      .all(jobId) as AttachmentRow[];
    return rows.map(mapAttachment);
  }

  addAttachment(
    jobId: number,
    engineerId: number | null,
    fileName: string,
    fileType: string,
    fileSize: number,
  ): Attachment {
    const ts = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO fs_attachments (job_id, engineer_id, file_name, file_type, file_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, engineerId, fileName, fileType, fileSize, ts);

    return this.db
      .prepare("SELECT * FROM fs_attachments WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as AttachmentRow as unknown as Attachment;
  }

  // ---- Dashboard ----

  getDashboardStats(): {
    totalJobs: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    engineerUtilisation: { total: number; available: number; busy: number; onLeave: number };
    slaBreaches: number;
    avgCompletionTime: number | null;
  } {
    const totalJobs = (this.db.prepare("SELECT COUNT(*) as cnt FROM fs_jobs").get() as { cnt: number }).cnt;

    const statusRows = this.db
      .prepare("SELECT status, COUNT(*) as cnt FROM fs_jobs GROUP BY status")
      .all() as { status: string; cnt: number }[];
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.cnt;

    const priorityRows = this.db
      .prepare("SELECT priority, COUNT(*) as cnt FROM fs_jobs GROUP BY priority")
      .all() as { priority: string; cnt: number }[];
    const byPriority: Record<string, number> = {};
    for (const r of priorityRows) byPriority[r.priority] = r.cnt;

    const engRows = this.db
      .prepare("SELECT status, COUNT(*) as cnt FROM fs_engineers GROUP BY status")
      .all() as { status: string; cnt: number }[];
    const engMap: Record<string, number> = {};
    for (const r of engRows) engMap[r.status] = r.cnt;

    const slaBreaches = (
      this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM fs_jobs WHERE sla_deadline IS NOT NULL AND sla_deadline < datetime('now') AND status NOT IN ('completed','cancelled')",
        )
        .get() as { cnt: number }
    ).cnt;

    const avgRow = this.db
      .prepare(
        `SELECT AVG(julianday(updated_at) - julianday(created_at)) * 24 * 60 as avg_minutes
         FROM fs_jobs WHERE status IN ('completed','failed','cancelled')`,
      )
      .get() as { avg_minutes: number | null };

    return {
      totalJobs,
      byStatus,
      byPriority,
      engineerUtilisation: {
        total: Object.values(engMap).reduce((a, b) => a + b, 0),
        available: engMap["available"] ?? 0,
        busy: engMap["busy"] ?? 0,
        onLeave: engMap["on-leave"] ?? 0,
      },
      slaBreaches,
      avgCompletionTime: avgRow.avg_minutes,
    };
  }

  getOverdueJobs(): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM fs_jobs
         WHERE sla_deadline IS NOT NULL
           AND sla_deadline < datetime('now')
           AND status NOT IN ('completed','cancelled')
         ORDER BY sla_deadline ASC`,
      )
      .all() as JobRow[];
    return rows.map(mapJob);
  }

  // ---- Seed / Reset ----

  seed(): void {
    const ts = this.now();

    this.db.transaction(() => {
      // Sites
      const sites: CreateSiteInput[] = [
        { name: "Canary Wharf Office Tower", address: "1 Canada Square", city: "London", postcode: "E14 5AB", lat: 51.5054, lng: -0.0235, accessInstructions: "Check in at reception desk in lobby. Visitor pass required.", contactName: "James Mitchell", contactPhone: "+44 20 7123 4567" },
        { name: "Manchester Distribution Hub", address: "Trafford Park Road", city: "Manchester", postcode: "M17 1AB", lat: 53.4631, lng: -2.3489, accessInstructions: "Enter via Gate 3 on Trafford Park Road. Security will escort.", contactName: "Sarah Khan", contactPhone: "+44 16 1234 5678" },
        { name: "Birmingham Corporate HQ", address: "Colmore Circus", city: "Birmingham", postcode: "B4 6AT", lat: 52.4813, lng: -1.8989, accessInstructions: "Use staff entrance on Colmore Circus. Badge access after 6pm.", contactName: "David Patel", contactPhone: "+44 12 1345 6789" },
        { name: "Leeds Data Centre", address: "Gelderd Road", city: "Leeds", postcode: "LS12 6BN", lat: 53.7867, lng: -1.5532, accessInstructions: "Security vetting required 24h before visit. Bring photo ID.", contactName: "Emma Wilson", contactPhone: "+44 11 3456 7890" },
        { name: "Bristol Retail Store", address: "The Galleries Shopping Centre", city: "Bristol", postcode: "BS1 3XD", lat: 51.4545, lng: -2.5879, accessInstructions: "Report to store manager office on 2nd floor. Hard hat area beyond.", contactName: "Tom Roberts", contactPhone: "+44 11 7234 5678" },
      ];

      const siteIds: number[] = [];
      for (const s of sites) {
        const r = this.db
          .prepare(`INSERT INTO fs_sites (name, address, city, postcode, lat, lng, access_instructions, contact_name, contact_phone, created_at)
                    VALUES (@name, @address, @city, @postcode, @lat, @lng, @accessInstructions, @contactName, @contactPhone, @createdAt)`)
          .run({ ...s, accessInstructions: s.accessInstructions ?? null, contactName: s.contactName ?? null, contactPhone: s.contactPhone ?? null, lat: s.lat ?? null, lng: s.lng ?? null, createdAt: ts });
        siteIds.push(Number(r.lastInsertRowid));
      }

      // Engineers
      const engineers: CreateEngineerInput[] = [
        { firstName: "Ahmed", lastName: "Hassan", email: "ahmed.hassan@fieldserve.co.uk", phone: "+44 7700 100001", employeeId: "ENG-001", skills: ["electrical", "fire-safety"] },
        { firstName: "Priya", lastName: "Sharma", email: "priya.sharma@fieldserve.co.uk", phone: "+44 7700 100002", employeeId: "ENG-002", skills: ["plumbing", "general-maintenance"] },
        { firstName: "Marcus", lastName: "Johnson", email: "marcus.johnson@fieldserve.co.uk", phone: "+44 7700 100003", employeeId: "ENG-003", skills: ["hvac", "electrical"] },
        { firstName: "Elena", lastName: "Morales", email: "elena.morales@fieldserve.co.uk", phone: "+44 7700 100004", employeeId: "ENG-004", skills: ["fire-safety", "general-maintenance"] },
        { firstName: "David", lastName: "Chen", email: "david.chen@fieldserve.co.uk", phone: "+44 7700 100005", employeeId: "ENG-005", skills: ["plumbing", "hvac"] },
        { firstName: "Sophie", lastName: "Turner", email: "sophie.turner@fieldserve.co.uk", phone: "+44 7700 100006", employeeId: "ENG-006", skills: ["electrical", "plumbing", "general-maintenance"] },
        { firstName: "Omar", lastName: "Farouk", email: "omar.farouk@fieldserve.co.uk", phone: "+44 7700 100007", employeeId: "ENG-007", skills: ["hvac", "fire-safety"] },
        { firstName: "Rachel", lastName: "Green", email: "rachel.green@fieldserve.co.uk", phone: "+44 7700 100008", employeeId: "ENG-008", skills: ["general-maintenance"] },
        { firstName: "Kwame", lastName: "Asante", email: "kwame.asante@fieldserve.co.uk", phone: "+44 7700 100009", employeeId: "ENG-009", skills: ["electrical", "hvac"] },
        { firstName: "Laura", lastName: "Bennett", email: "laura.bennett@fieldserve.co.uk", phone: "+44 7700 100010", employeeId: "ENG-010", skills: ["plumbing", "fire-safety", "general-maintenance"] },
      ];

      const engIds: number[] = [];
      for (const e of engineers) {
        const r = this.db
          .prepare(`INSERT INTO fs_engineers (first_name, last_name, email, phone, employee_id, skills, status, created_at)
                    VALUES (@firstName, @lastName, @email, @phone, @employeeId, @skills, 'available', @createdAt)`)
          .run({ ...e, phone: e.phone ?? null, skills: JSON.stringify(e.skills ?? []), createdAt: ts });
        engIds.push(Number(r.lastInsertRowid));
      }

      // Jobs — spread across statuses to demonstrate realistic data
      const jobs: { title: string; description: string; siteIdx: number; skill: string; priority: Priority; status: JobStatus; engineerIdx?: number; scheduledDate?: string; duration?: number; slaHours?: number }[] = [
        // Created (not yet scheduled)
        { title: "Replace fire extinguishers on floors 3-5", description: "Annual fire extinguisher replacement required across three floors. Check pressure gauges and replace any units past expiry.", siteIdx: 0, skill: "fire-safety", priority: "high", status: "created", duration: 240, slaHours: 72 },
        { title: "Fix leaking pipe in warehouse loading bay", description: "Water leaking from overhead pipe in loading bay B. Temporary fix in place, needs permanent repair.", siteIdx: 1, skill: "plumbing", priority: "critical", status: "created", duration: 180, slaHours: 24 },
        { title: "Install new LED lighting in car park", description: "Replace existing fluorescent fittings with LED panels in basement car park. Energy efficiency upgrade project.", siteIdx: 3, skill: "electrical", priority: "low", status: "created", duration: 480, slaHours: 168 },

        // Scheduled
        { title: "HVAC filter replacement — all floors", description: "Quarterly HVAC filter replacement. 24 filters across 6 floors, sizes vary.", siteIdx: 2, skill: "hvac", priority: "medium", status: "scheduled", scheduledDate: "2026-08-20", duration: 360, slaHours: 48 },
        { title: "Emergency generator service", description: "Scheduled quarterly service of backup diesel generator. Include oil change, filter check, and 30-minute load test.", siteIdx: 3, skill: "electrical", priority: "critical", status: "scheduled", scheduledDate: "2026-08-19", duration: 240, slaHours: 24 },

        // Assigned
        { title: "Repair automatic doors — main entrance", description: "Main entrance sliding doors intermittently failing to open. Sensor alignment suspected.", siteIdx: 4, skill: "general-maintenance", priority: "high", status: "assigned", engineerIdx: 7, scheduledDate: "2026-08-18", duration: 120, slaHours: 24 },

        // Engineer Dispatched
        { title: "Investigate AC complaint — boardroom", description: "Boardroom 12C reports insufficient cooling. Client meeting tomorrow at 10am — urgent.", siteIdx: 0, skill: "hvac", priority: "critical", status: "engineer-dispatched", engineerIdx: 2, scheduledDate: "2026-08-18", duration: 90, slaHours: 8 },

        // En Route
        { title: "Electrical fault in retail display", description: "Flickering lights and tripping RCD in east wing retail display area. Potential wiring fault.", siteIdx: 4, skill: "electrical", priority: "high", status: "en-route", engineerIdx: 0, scheduledDate: "2026-08-18", duration: 180, slaHours: 12 },

        // On Site
        { title: "Blocked drainage — kitchen area", description: "Staff kitchen drainage backing up. Grease trap may need cleaning. Blockage affecting 30+ staff.", siteIdx: 2, skill: "plumbing", priority: "high", status: "on-site", engineerIdx: 1, scheduledDate: "2026-08-18", duration: 120, slaHours: 8 },

        // Checking In
        { title: "Replace door handles — corridor B", description: "Several door handles in corridor B are loose or broken. Fire regulation compliance issue.", siteIdx: 0, skill: "general-maintenance", priority: "medium", status: "checking-in", engineerIdx: 3, scheduledDate: "2026-08-18", duration: 90, slaHours: 24 },

        // Waiting for Access
        { title: "Roof inspection — water ingress reported", description: "Staff on floor 6 report water stains on ceiling after rain. Roof inspection required.", siteIdx: 1, skill: "general-maintenance", priority: "high", status: "waiting-for-access", engineerIdx: 5, scheduledDate: "2026-08-18", duration: 240, slaHours: 24 },

        // Waiting for Equipment
        { title: "UPS battery replacement", description: "Server room UPS batteries at end of life. Replacement batteries on order, expected delivery today.", siteIdx: 3, skill: "electrical", priority: "critical", status: "waiting-for-equipment", engineerIdx: 8, scheduledDate: "2026-08-18", duration: 180, slaHours: 12 },

        // In Progress
        { title: "Rewire server room PDU", description: "Power distribution unit in server room 2 showing uneven load. Partial rewire in progress.", siteIdx: 3, skill: "electrical", priority: "critical", status: "in-progress", engineerIdx: 8, scheduledDate: "2026-08-18", duration: 360, slaHours: 8 },
        { title: "Replace ceiling tiles — office floor", description: "Water-damaged ceiling tiles on floor 4 need replacing. 12 tiles identified.", siteIdx: 0, skill: "general-maintenance", priority: "medium", status: "in-progress", engineerIdx: 7, scheduledDate: "2026-08-18", duration: 120, slaHours: 48 },

        // On Hold
        { title: "Boiler maintenance — plant room", description: "Boiler maintenance started but discovered need for replacement pressure valve. Parts on order.", siteIdx: 4, skill: "hvac", priority: "high", status: "on-hold", engineerIdx: 6, scheduledDate: "2026-08-17", duration: 300, slaHours: 48 },

        // Completed
        { title: "Annual PAT testing — offices 1-3", description: "Portable appliance testing for all electrical equipment in offices 1-3. 150 items.", siteIdx: 0, skill: "electrical", priority: "medium", status: "completed", engineerIdx: 0, scheduledDate: "2026-08-15", duration: 480, slaHours: 72 },
        { title: "Clear blocked toilet — floor 2", description: "Toilet blockage on floor 2 men's restroom. Overflow risk.", siteIdx: 2, skill: "plumbing", priority: "high", status: "completed", engineerIdx: 4, scheduledDate: "2026-08-16", duration: 60, slaHours: 4 },

        // Failed
        { title: "Fix loading dock leveller", description: "Hydraulic leveller at dock 2 seized. Attempted repair but hydraulic pump needs full replacement — not possible with available parts.", siteIdx: 1, skill: "general-maintenance", priority: "high", status: "failed", engineerIdx: 3, scheduledDate: "2026-08-16", duration: 180, slaHours: 24 },

        // Cancelled
        { title: "Paint touch-up — reception area", description: "Minor paint touch-up needed in reception. Client cancelled — full refurbishment planned instead.", siteIdx: 0, skill: "general-maintenance", priority: "low", status: "cancelled", engineerIdx: 5, scheduledDate: "2026-08-14", duration: 120, slaHours: 168 },

        // Deferred
        { title: "Install air purifiers — open plan office", description: "Post-COVID air quality improvement project. Deferred pending budget approval from finance.", siteIdx: 0, skill: "hvac", priority: "low", status: "deferred", scheduledDate: "2026-09-01", duration: 360, slaHours: 336 },

        // Facility Not Accessible
        { title: "Electrical survey — tenant space", description: "Scheduled electrical condition survey for incoming tenant. Could not access — tenant still inoccupation.", siteIdx: 4, skill: "electrical", priority: "medium", status: "facility-not-accessible", engineerIdx: 9, scheduledDate: "2026-08-17", duration: 240, slaHours: 48 },
      ];

      for (const j of jobs) {
        const scheduledDate = j.scheduledDate ?? null;
        const slaDeadline = j.slaHours
          ? new Date(Date.now() - (j.status === "completed" || j.status === "cancelled" || j.status === "failed" ? j.slaHours * 3600000 * 2 : 0) + j.slaHours * 3600000).toISOString()
          : null;

        this.db
          .prepare(
            `INSERT INTO fs_jobs (title, description, site_id, skill_required, priority, status, assigned_engineer_id, scheduled_date, estimated_duration, sla_deadline, created_at, updated_at)
             VALUES (@title, @description, @siteId, @skill, @priority, @status, @engineerId, @scheduledDate, @duration, @slaDeadline, @createdAt, @updatedAt)`,
          )
          .run({
            title: j.title,
            description: j.description,
            siteId: siteIds[j.siteIdx],
            skill: j.skill,
            priority: j.priority,
            status: j.status,
            engineerId: j.engineerIdx !== undefined ? engIds[j.engineerIdx] : null,
            scheduledDate,
            duration: j.duration ?? null,
            slaDeadline,
            createdAt: ts,
            updatedAt: ts,
          });
      }
    })();
  }

  reset(): void {
    this.db.exec("DELETE FROM fs_attachments");
    this.db.exec("DELETE FROM fs_job_updates");
    this.db.exec("DELETE FROM fs_jobs");
    this.db.exec("DELETE FROM fs_engineers");
    this.db.exec("DELETE FROM fs_sites");
    this.db.exec("DELETE FROM fs_api_keys");
  }

  // ---- Recording ----

  startRecordingSession(name: string, baseUrl: string, apiSpec?: string, apiSpecUrl?: string): number {
    const result = this.db
      .prepare(`INSERT INTO fs_recorded_sessions (name, base_url, api_spec, api_spec_url) VALUES (?, ?, ?, ?)`)
      .run(name, baseUrl, apiSpec ?? null, apiSpecUrl ?? null);
    return Number(result.lastInsertRowid);
  }

  stopRecordingSession(sessionId: number): void {
    this.db
      .prepare(`UPDATE fs_recorded_sessions SET ended_at = datetime('now') WHERE id = ?`)
      .run(sessionId);
  }

  addRecordedStep(
    sessionId: number,
    seq: number,
    method: string,
    path: string,
    reqHeaders: Record<string, string>,
    reqBody: string | null,
    resStatus: number,
    resHeaders: Record<string, string>,
    resBody: string,
    durationMs: number,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO fs_recorded_steps (session_id, seq, method, path, request_headers, request_body, response_status, response_headers, response_body, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        seq,
        method,
        path,
        JSON.stringify(reqHeaders),
        reqBody,
        resStatus,
        JSON.stringify(resHeaders),
        resBody,
        durationMs,
      );
    this.db
      .prepare(`UPDATE fs_recorded_sessions SET step_count = step_count + 1 WHERE id = ?`)
      .run(sessionId);
    return Number(result.lastInsertRowid);
  }

  listRecordedSessions(): RecordedSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM fs_recorded_sessions ORDER BY started_at DESC`)
      .all() as RecordedSessionRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.base_url,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      stepCount: r.step_count,
      apiSpec: r.api_spec,
      apiSpecUrl: r.api_spec_url,
    }));
  }

  getRecordedSession(sessionId: number): RecordedSession | null {
    const row = this.db
      .prepare(`SELECT * FROM fs_recorded_sessions WHERE id = ?`)
      .get(sessionId) as RecordedSessionRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      stepCount: row.step_count,
      apiSpec: row.api_spec,
      apiSpecUrl: row.api_spec_url,
    };
  }

  getRecordedSteps(sessionId: number): RecordedStep[] {
    const rows = this.db
      .prepare(`SELECT * FROM fs_recorded_steps WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as RecordedStepRow[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      method: r.method,
      path: r.path,
      requestHeaders: JSON.parse(r.request_headers || "{}"),
      requestBody: r.request_body,
      responseStatus: r.response_status,
      responseHeaders: JSON.parse(r.response_headers || "{}"),
      responseBody: r.response_body,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));
  }

  deleteRecordedSession(sessionId: number): void {
    this.db.prepare(`DELETE FROM fs_recorded_steps WHERE session_id = ?`).run(sessionId);
    this.db.prepare(`DELETE FROM fs_recorded_sessions WHERE id = ?`).run(sessionId);
  }
}

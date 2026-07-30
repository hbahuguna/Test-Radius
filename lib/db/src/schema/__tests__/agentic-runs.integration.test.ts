import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

describe.runIf(DATABASE_URL)("agenticRunsTable integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("agentic_runs table has all 7 new columns with correct types", async () => {
    const result = await pool.query<ColumnInfo>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'agentic_runs'
       ORDER BY ordinal_position`,
    );

    const cols = result.rows.reduce(
      (acc, row) => {
        acc[row.column_name] = row;
        return acc;
      },
      {} as Record<string, ColumnInfo>,
    );

    expect(cols["group_id"]).toBeDefined();
    expect(cols["group_id"].data_type).toBe("uuid");
    expect(cols["group_id"].is_nullable).toBe("YES");

    expect(cols["schedule_id"]).toBeDefined();
    expect(cols["schedule_id"].data_type).toBe("uuid");
    expect(cols["schedule_id"].is_nullable).toBe("YES");

    expect(cols["step_count"]).toBeDefined();
    expect(cols["step_count"].data_type).toBe("integer");
    expect(cols["step_count"].column_default).toBe("0");

    expect(cols["duration_seconds"]).toBeDefined();
    expect(cols["duration_seconds"].data_type).toBe("integer");
    expect(cols["duration_seconds"].column_default).toBe("0");

    expect(cols["failure_bundle"]).toBeDefined();
    expect(cols["failure_bundle"].data_type).toBe("jsonb");
    expect(cols["failure_bundle"].is_nullable).toBe("YES");

    expect(cols["video_url"]).toBeDefined();
    expect(cols["video_url"].data_type).toBe("text");
    expect(cols["video_url"].is_nullable).toBe("YES");

    expect(cols["metadata"]).toBeDefined();
    expect(cols["metadata"].data_type).toBe("jsonb");
    expect(cols["metadata"].is_nullable).toBe("YES");
  });

  it("existing rows get NULL defaults for new columns", async () => {
    // Insert a row without the new columns
    const insertResult = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status)
       VALUES ('test-user-integration', 'https://example.com', 'integration test', 'completed')
       RETURNING id`,
    );
    const runId = insertResult.rows[0].id;

    // Read it back — new columns should be null/0
    const readResult = await pool.query(
      `SELECT group_id, schedule_id, step_count, duration_seconds,
              failure_bundle, video_url, metadata
       FROM agentic_runs WHERE id = $1`,
      [runId],
    );
    const row = readResult.rows[0];

    expect(row.group_id).toBeNull();
    expect(row.schedule_id).toBeNull();
    expect(row.step_count).toBe(0);
    expect(row.duration_seconds).toBe(0);
    expect(row.failure_bundle).toBeNull();
    expect(row.video_url).toBeNull();
    expect(row.metadata).toBeNull();

    // Cleanup
    await pool.query("DELETE FROM agentic_runs WHERE id = $1", [runId]);
  });

  it("can insert rows with new columns populated", async () => {
    const result = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status, group_id, schedule_id,
                                 step_count, duration_seconds, failure_bundle, video_url, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        "test-user-integration-2",
        "https://example.com",
        "integration test with all fields",
        "completed",
        "550e8400-e29b-41d4-a716-446655440000",
        "550e8400-e29b-41d4-a716-446655440001",
        5,
        42,
        JSON.stringify({ domSnapshot: "<html/>", rootCause: "timeout" }),
        "https://storage.example.com/video.mp4",
        JSON.stringify({ browser: "chromium", viewport: "1280x720" }),
      ],
    );

    const runId = result.rows[0].id;
    expect(runId).toBeDefined();

    // Cleanup
    await pool.query("DELETE FROM agentic_runs WHERE id = $1", [runId]);
  });
});

describe.skipIf(DATABASE_URL)("agenticRunsTable integration (skipped)", () => {
  it("requires DATABASE_URL to run integration tests", () => {
    expect(DATABASE_URL).toBeUndefined();
  });
});

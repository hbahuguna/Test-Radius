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

describe.runIf(DATABASE_URL)("testSchedules integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("test_schedules table has all 12 columns with correct types", async () => {
    const result = await pool.query<ColumnInfo>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'test_schedules'
       ORDER BY ordinal_position`,
    );

    const cols = result.rows.reduce(
      (acc, row) => {
        acc[row.column_name] = row;
        return acc;
      },
      {} as Record<string, ColumnInfo>,
    );

    expect(cols["id"].data_type).toBe("uuid");
    expect(cols["user_id"].data_type).toBe("text");
    expect(cols["user_id"].is_nullable).toBe("NO");
    expect(cols["name"].data_type).toBe("text");
    expect(cols["name"].is_nullable).toBe("NO");
    expect(cols["url"].data_type).toBe("text");
    expect(cols["url"].is_nullable).toBe("NO");
    expect(cols["goal"].data_type).toBe("text");
    expect(cols["goal"].is_nullable).toBe("NO");
    expect(cols["cron_expression"].data_type).toBe("text");
    expect(cols["cron_expression"].is_nullable).toBe("NO");
    expect(cols["timezone"].data_type).toBe("text");
    expect(cols["timezone"].is_nullable).toBe("NO");
    expect(cols["model_id"].data_type).toBe("text");
    expect(cols["model_id"].is_nullable).toBe("YES");
    expect(cols["enabled"].data_type).toBe("boolean");
    expect(cols["enabled"].is_nullable).toBe("NO");
    expect(cols["enabled"].column_default).toBe("true");
    expect(cols["last_run_at"].data_type).toBe("timestamp without time zone");
    expect(cols["last_run_at"].is_nullable).toBe("YES");
    expect(cols["next_run_at"].data_type).toBe("timestamp without time zone");
    expect(cols["next_run_at"].is_nullable).toBe("YES");
    expect(cols["created_at"].data_type).toBe("timestamp without time zone");
    expect(cols["created_at"].is_nullable).toBe("NO");
  });

  it("insert schedule with valid cron expression and round-trip", async () => {
    const user = await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      ["test-sched-cron-user", "cron@test.com"],
    );

    const insert = await pool.query(
      `INSERT INTO test_schedules (user_id, name, url, goal, cron_expression)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, url, goal, cron_expression, enabled, timezone`,
      [
        "test-sched-cron-user",
        "Daily Smoke Test",
        "https://example.com/smoke",
        "Run smoke tests on production",
        "0 8 * * 1-5",
      ],
    );

    expect(insert.rows[0].name).toBe("Daily Smoke Test");
    expect(insert.rows[0].url).toBe("https://example.com/smoke");
    expect(insert.rows[0].cron_expression).toBe("0 8 * * 1-5");
    expect(insert.rows[0].enabled).toBe(true);
    expect(insert.rows[0].timezone).toBe("UTC");

    await pool.query("DELETE FROM test_schedules WHERE id = $1", [insert.rows[0].id]);
    await pool.query("DELETE FROM users WHERE id = $1", ["test-sched-cron-user"]);
  });

  it("insert schedule with enabled=false returns in query", async () => {
    const user = await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      ["test-sched-disabled-user", "disabled@test.com"],
    );

    const insert = await pool.query(
      `INSERT INTO test_schedules (user_id, name, url, goal, cron_expression, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, enabled`,
      [
        "test-sched-disabled-user",
        "Disabled Old",
        "https://example.com/old",
        "Legacy schedule",
        "0 */2 * * *",
        false,
      ],
    );

    expect(insert.rows[0].enabled).toBe(false);

    const query = await pool.query(
      `SELECT id, enabled FROM test_schedules WHERE id = $1 AND enabled = false`,
      [insert.rows[0].id],
    );
    expect(query.rows).toHaveLength(1);
    expect(query.rows[0].enabled).toBe(false);

    await pool.query("DELETE FROM test_schedules WHERE id = $1", [insert.rows[0].id]);
    await pool.query("DELETE FROM users WHERE id = $1", ["test-sched-disabled-user"]);
  });

  it("insert schedule with null modelId", async () => {
    const user = await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      ["test-sched-model-user", "model@test.com"],
    );

    const insert = await pool.query(
      `INSERT INTO test_schedules (user_id, name, url, goal, cron_expression)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, model_id`,
      [
        "test-sched-model-user",
        "No Model",
        "https://example.com/no-model",
        "Test with null model",
        "0 6 * * 6",
      ],
    );

    expect(insert.rows[0].model_id).toBeNull();

    // Also verify insert with explicit modelId
    const insertWithModel = await pool.query(
      `INSERT INTO test_schedules (user_id, name, url, goal, cron_expression, model_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING model_id`,
      [
        "test-sched-model-user",
        "With Model",
        "https://example.com/with-model",
        "Test with explicit model",
        "0 6 * * 6",
        "gpt-4",
      ],
    );
    expect(insertWithModel.rows[0].model_id).toBe("gpt-4");

    await pool.query("DELETE FROM test_schedules WHERE user_id = $1", [
      "test-sched-model-user",
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", ["test-sched-model-user"]);
  });

  it("update nextRunAt persists change", async () => {
    const user = await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      ["test-sched-update-user", "update@test.com"],
    );

    const insert = await pool.query(
      `INSERT INTO test_schedules (user_id, name, url, goal, cron_expression)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        "test-sched-update-user",
        "Update Test",
        "https://example.com/update",
        "Test nextRunAt update",
        "0 8 * * 1-5",
      ],
    );
    const scheduleId = insert.rows[0].id;

    const futureTime = "2026-08-01T08:00:00Z";
    await pool.query(
      `UPDATE test_schedules SET next_run_at = $1 WHERE id = $2`,
      [futureTime, scheduleId],
    );

    const readback = await pool.query(
      `SELECT next_run_at FROM test_schedules WHERE id = $1`,
      [scheduleId],
    );
    expect(readback.rows[0].next_run_at).toBeTruthy();

    await pool.query("DELETE FROM test_schedules WHERE id = $1", [scheduleId]);
    await pool.query("DELETE FROM users WHERE id = $1", ["test-sched-update-user"]);
  });
});

describe.skipIf(DATABASE_URL)("testSchedules integration (skipped)", () => {
  it("requires DATABASE_URL to run integration tests", () => {
    expect(DATABASE_URL).toBeUndefined();
  });
});

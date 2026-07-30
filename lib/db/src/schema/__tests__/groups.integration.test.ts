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

describe.runIf(DATABASE_URL)("testGroups integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("test_groups table has all 5 columns with correct types", async () => {
    const result = await pool.query<ColumnInfo>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'test_groups'
       ORDER BY ordinal_position`,
    );

    const cols = result.rows.reduce(
      (acc, row) => {
        acc[row.column_name] = row;
        return acc;
      },
      {} as Record<string, ColumnInfo>,
    );

    expect(cols["id"]).toBeDefined();
    expect(cols["id"].data_type).toBe("uuid");

    expect(cols["user_id"]).toBeDefined();
    expect(cols["user_id"].data_type).toBe("text");
    expect(cols["user_id"].is_nullable).toBe("NO");

    expect(cols["name"]).toBeDefined();
    expect(cols["name"].data_type).toBe("text");
    expect(cols["name"].is_nullable).toBe("NO");

    expect(cols["description"]).toBeDefined();
    expect(cols["description"].data_type).toBe("text");
    expect(cols["description"].is_nullable).toBe("YES");

    expect(cols["created_at"]).toBeDefined();
    expect(cols["created_at"].data_type).toBe("timestamp without time zone");
    expect(cols["created_at"].is_nullable).toBe("NO");
  });

  it("test_group_runs table has all 4 columns with correct types", async () => {
    const result = await pool.query<ColumnInfo>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'test_group_runs'
       ORDER BY ordinal_position`,
    );

    const cols = result.rows.reduce(
      (acc, row) => {
        acc[row.column_name] = row;
        return acc;
      },
      {} as Record<string, ColumnInfo>,
    );

    expect(cols["id"]).toBeDefined();
    expect(cols["id"].data_type).toBe("integer");

    expect(cols["group_id"]).toBeDefined();
    expect(cols["group_id"].data_type).toBe("uuid");
    expect(cols["group_id"].is_nullable).toBe("NO");

    expect(cols["run_id"]).toBeDefined();
    expect(cols["run_id"].data_type).toBe("uuid");
    expect(cols["run_id"].is_nullable).toBe("NO");

    expect(cols["order"]).toBeDefined();
    expect(cols["order"].data_type).toBe("integer");
    expect(cols["order"].is_nullable).toBe("NO");
    expect(cols["order"].column_default).toBe("0");
  });

  it("insert group → insert 3 runs → insert 3 join rows → JOIN query round-trips", async () => {
    // Create a test user
    const user = await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      ["test-group-int-user", "groups-int@test.com"],
    );

    // Insert 3 agentic runs
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await pool.query(
        `INSERT INTO agentic_runs (user_id, url, goal, status)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ["test-group-int-user", `https://example.com/${i}`, `Goal ${i}`, "completed"],
      );
      runs.push(r.rows[0].id);
    }

    // Insert a group
    const group = await pool.query(
      `INSERT INTO test_groups (user_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["test-group-int-user", "Smoke Tests", "Critical user paths"],
    );
    const groupId = group.rows[0].id;

    // Insert 3 join rows with order 0, 1, 2
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO test_group_runs (group_id, run_id, "order")
         VALUES ($1, $2, $3)`,
        [groupId, runs[i], i],
      );
    }

    // JOIN query to verify data round-trips
    const joined = await pool.query(
      `SELECT g.name AS group_name, g.description, r.url, r.status, tgr."order"
       FROM test_groups g
       JOIN test_group_runs tgr ON tgr.group_id = g.id
       JOIN agentic_runs r ON r.id = tgr.run_id
       WHERE g.id = $1
       ORDER BY tgr."order"`,
      [groupId],
    );

    expect(joined.rows).toHaveLength(3);
    expect(joined.rows[0].group_name).toBe("Smoke Tests");
    expect(joined.rows[0].url).toBe("https://example.com/0");
    expect(joined.rows[0].order).toBe(0);
    expect(joined.rows[1].url).toBe("https://example.com/1");
    expect(joined.rows[1].order).toBe(1);
    expect(joined.rows[2].url).toBe("https://example.com/2");
    expect(joined.rows[2].order).toBe(2);

    // Cleanup
    await pool.query("DELETE FROM test_groups WHERE id = $1", [groupId]);
    await pool.query("DELETE FROM agentic_runs WHERE user_id = $1", [
      "test-group-int-user",
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", ["test-group-int-user"]);
  });

  it("delete group cascades to test_group_runs", async () => {
    const user = await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      ["test-cascade-user", "cascade@test.com"],
    );

    const run = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ["test-cascade-user", "https://example.com", "test", "completed"],
    );

    const group = await pool.query(
      `INSERT INTO test_groups (user_id, name) VALUES ($1, $2)
       RETURNING id`,
      ["test-cascade-user", "Cascade Test"],
    );
    const groupId = group.rows[0].id;

    await pool.query(
      `INSERT INTO test_group_runs (group_id, run_id) VALUES ($1, $2)`,
      [groupId, run.rows[0].id],
    );

    // Delete the group
    await pool.query("DELETE FROM test_groups WHERE id = $1", [groupId]);

    // Verify join row cascade-deleted
    const joinRows = await pool.query(
      "SELECT * FROM test_group_runs WHERE group_id = $1",
      [groupId],
    );
    expect(joinRows.rows).toHaveLength(0);

    // Verify the run itself still exists (group delete should NOT delete runs)
    const runRows = await pool.query(
      "SELECT * FROM agentic_runs WHERE id = $1",
      [run.rows[0].id],
    );
    expect(runRows.rows).toHaveLength(1);

    // Cleanup
    await pool.query("DELETE FROM agentic_runs WHERE user_id = $1", [
      "test-cascade-user",
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", ["test-cascade-user"]);
  });

  it("delete run cascades to test_group_runs", async () => {
    const user = await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      ["test-cascade-run-user", "cascade-run@test.com"],
    );

    const run = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ["test-cascade-run-user", "https://example.com", "test", "completed"],
    );
    const runId = run.rows[0].id;

    const group = await pool.query(
      `INSERT INTO test_groups (user_id, name) VALUES ($1, $2)
       RETURNING id`,
      ["test-cascade-run-user", "Run Cascade Test"],
    );
    const groupId = group.rows[0].id;

    await pool.query(
      `INSERT INTO test_group_runs (group_id, run_id) VALUES ($1, $2)`,
      [groupId, runId],
    );

    // Delete the run
    await pool.query("DELETE FROM agentic_runs WHERE id = $1", [runId]);

    // Verify join row cascade-deleted
    const joinRows = await pool.query(
      "SELECT * FROM test_group_runs WHERE group_id = $1",
      [groupId],
    );
    expect(joinRows.rows).toHaveLength(0);

    // Verify the group still exists
    const groupRows = await pool.query(
      "SELECT * FROM test_groups WHERE id = $1",
      [groupId],
    );
    expect(groupRows.rows).toHaveLength(1);

    // Cleanup
    await pool.query("DELETE FROM test_groups WHERE id = $1", [groupId]);
    await pool.query("DELETE FROM users WHERE id = $1", ["test-cascade-run-user"]);
  });

  it("add 2 runs to same group with order=0,1 — ordering preserved", async () => {
    const user = await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      ["test-order-user", "order@test.com"],
    );

    const run1 = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ["test-order-user", "https://example.com/1", "First", "completed"],
    );
    const run2 = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ["test-order-user", "https://example.com/2", "Second", "completed"],
    );

    const group = await pool.query(
      `INSERT INTO test_groups (user_id, name) VALUES ($1, $2)
       RETURNING id`,
      ["test-order-user", "Order Test"],
    );
    const groupId = group.rows[0].id;

    await pool.query(
      `INSERT INTO test_group_runs (group_id, run_id, "order") VALUES ($1, $2, 0)`,
      [groupId, run1.rows[0].id],
    );
    await pool.query(
      `INSERT INTO test_group_runs (group_id, run_id, "order") VALUES ($1, $2, 1)`,
      [groupId, run2.rows[0].id],
    );

    const ordered = await pool.query(
      `SELECT r.url, tgr."order"
       FROM test_group_runs tgr
       JOIN agentic_runs r ON r.id = tgr.run_id
       WHERE tgr.group_id = $1
       ORDER BY tgr."order"`,
      [groupId],
    );

    expect(ordered.rows).toHaveLength(2);
    expect(ordered.rows[0].url).toBe("https://example.com/1");
    expect(ordered.rows[0].order).toBe(0);
    expect(ordered.rows[1].url).toBe("https://example.com/2");
    expect(ordered.rows[1].order).toBe(1);

    // Cleanup
    await pool.query("DELETE FROM test_groups WHERE id = $1", [groupId]);
    await pool.query("DELETE FROM agentic_runs WHERE user_id = $1", [
      "test-order-user",
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", ["test-order-user"]);
  });
});

describe.skipIf(DATABASE_URL)("testGroups integration (skipped)", () => {
  it("requires DATABASE_URL to run integration tests", () => {
    expect(DATABASE_URL).toBeUndefined();
  });
});

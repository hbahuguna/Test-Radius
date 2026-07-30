import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

const DATABASE_URL = process.env.DATABASE_URL;
const DEMO_USER_ID = "demo-user-id";

vi.mock("../../middlewares/auth", () => {
  const fn = async (req: any, _res: any, next: any) => {
    req.user = { id: DEMO_USER_ID, email: "demo@testradius.dev" };
    next();
  };
  return {
    requireAuth: fn,
    requireSignedUp: fn,
    optionalAuth: fn,
    resolveUser: async () => ({ id: DEMO_USER_ID, email: "demo@testradius.dev" }),
  };
});

vi.mock("../../lib/auth", () => ({
  getOrCreateUser: vi.fn((user: any) => Promise.resolve(user)),
}));

const mockStartBrowserAgentRun = vi.fn();
vi.mock("../../lib/browser-use-client", () => ({
  startBrowserAgentRun: mockStartBrowserAgentRun,
  sendBrowserAgentChat: vi.fn(),
  stopBrowserAgentRun: vi.fn(),
  getBrowserAgentScreenshot: vi.fn(),
  getBrowserAgentRunStatus: vi.fn(),
}));

vi.mock("../../lib/crypto", () => ({ decryptKey: vi.fn() }));

describe.runIf(DATABASE_URL)("Browser-agent parallel E2E", () => {
  let app: any;
  let pool: any;
  const pg = require("pg");
  const { Pool } = pg;

  beforeAll(async () => {
    process.env.LOG_LEVEL = "silent";
    process.env.DATABASE_URL = DATABASE_URL;

    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [DEMO_USER_ID, "demo@testradius.dev"],
    );
    await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      ["other-user", "other@test.com"],
    );

    vi.resetModules();
    const mod = await import("../../app");
    app = mod.default;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM agentic_runs WHERE user_id = $1", [DEMO_USER_ID]);
      await pool.query("DELETE FROM agentic_runs WHERE user_id = $1", ["other-user"]);
      await pool.query("DELETE FROM agentic_batches WHERE user_id = $1", [DEMO_USER_ID]);
      await pool.query("DELETE FROM user_api_keys WHERE user_id = $1", [DEMO_USER_ID]).catch(() => {});
      await pool.query("DELETE FROM credit_ledger WHERE user_id = $1", [DEMO_USER_ID]).catch(() => {});
      await pool.query("DELETE FROM coupon_redemptions WHERE user_id = $1", [DEMO_USER_ID]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id = $1", [DEMO_USER_ID]);
      await pool.query("DELETE FROM users WHERE id = $1", ["other-user"]);
      await pool.end();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getBatchRecord(batchId: string) {
    const result = await pool.query(
      "SELECT * FROM agentic_batches WHERE id = $1",
      [batchId],
    );
    return result.rows[0] || null;
  }

  it("POST /run/parallel with 3 agents creates batch + 3 queued runs", async () => {
    mockStartBrowserAgentRun.mockResolvedValue({
      run_id: "py-mock",
      success: true,
      error: null,
      stepCount: 2,
      duration: 10,
    });

    const res = await request(app)
      .post("/api/browser-agent/run/parallel")
      .set("Authorization", "Bearer mock-token")
      .send({
        agents: [
          { url: "https://example.com", goal: "Test A" },
          { url: "https://google.com", goal: "Test B" },
          { url: "https://github.com", goal: "Test C" },
        ],
        parallel_limit: 3,
      });

    expect(res.status).toBe(200);
    expect(res.body.batch_id).toBeDefined();
    expect(res.body.run_ids).toBeDefined();
    expect(res.body.run_ids).toHaveLength(3);

    const batch = await getBatchRecord(res.body.batch_id);
    expect(batch).not.toBeNull();
    expect(batch.user_id).toBe(DEMO_USER_ID);
    expect(batch.parallel_limit).toBe(3);
    expect(batch.total_runs).toBe(3);
    expect(batch.status).toBe("queued");

    const runs = await pool.query(
      "SELECT * FROM agentic_runs WHERE batch_id = $1 ORDER BY created_at",
      [res.body.batch_id],
    );
    expect(runs.rows).toHaveLength(3);
    expect(runs.rows[0].status).toBe("queued");
    expect(runs.rows.map((r: any) => r.url)).toEqual([
      "https://example.com",
      "https://google.com",
      "https://github.com",
    ]);

    // Cleanup
    await pool.query("DELETE FROM agentic_runs WHERE batch_id = $1", [res.body.batch_id]);
    await pool.query("DELETE FROM agentic_batches WHERE id = $1", [res.body.batch_id]);
  });

  it("rejects empty agents array", async () => {
    const res = await request(app)
      .post("/api/browser-agent/run/parallel")
      .set("Authorization", "Bearer mock-token")
      .send({ agents: [], parallel_limit: 3 });

    expect(res.status).toBe(400);
  });

  it("defaults parallel_limit to 3", async () => {
    mockStartBrowserAgentRun.mockResolvedValue({
      run_id: "py-mock",
      success: true,
      error: null,
      stepCount: 0,
      duration: 0,
    });

    const res = await request(app)
      .post("/api/browser-agent/run/parallel")
      .set("Authorization", "Bearer mock-token")
      .send({
        agents: [
          { url: "https://example.com", goal: "Default limit test" },
        ],
      });

    expect(res.status).toBe(200);

    const batch = await getBatchRecord(res.body.batch_id);
    expect(batch.parallel_limit).toBe(3);

    await pool.query("DELETE FROM agentic_runs WHERE batch_id = $1", [res.body.batch_id]);
    await pool.query("DELETE FROM agentic_batches WHERE id = $1", [res.body.batch_id]);
  });

  it("GET /run/batch/:batchId/status returns 404 for non-existent batch", async () => {
    const res = await request(app)
      .get("/api/browser-agent/run/batch/nonexistent-batch-id/status")
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("batch_not_found");
  });

  it("GET /run/batch/:batchId/status returns correct aggregation", async () => {
    // Insert a batch with known state
    const batchInsert = await pool.query(
      `INSERT INTO agentic_batches (user_id, parallel_limit, status, total_runs, completed_runs, failed_runs)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [DEMO_USER_ID, 10, "running", 3, 2, 0],
    );
    const batchId = batchInsert.rows[0].id;

    await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status, success, batch_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [DEMO_USER_ID, "https://a.com", "A", "completed", true, batchId],
    );
    await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status, success, batch_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [DEMO_USER_ID, "https://b.com", "B", "completed", true, batchId],
    );
    await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status, success, batch_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [DEMO_USER_ID, "https://c.com", "C", "running", null, batchId],
    );

    const res = await request(app)
      .get(`/api/browser-agent/run/batch/${batchId}/status`)
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(200);
    expect(res.body.batch_id).toBe(batchId);
    expect(res.body.total).toBe(3);
    expect(res.body.completed).toBe(2);
    expect(res.body.failed).toBe(0);
    expect(res.body.runs).toHaveLength(3);

    await pool.query("DELETE FROM agentic_runs WHERE batch_id = $1", [batchId]);
    await pool.query("DELETE FROM agentic_batches WHERE id = $1", [batchId]);
  });

  it("1 agent in batch works (degenerate single-run case)", async () => {
    mockStartBrowserAgentRun.mockResolvedValue({
      run_id: "py-single",
      success: true,
      error: null,
      stepCount: 1,
      duration: 5,
    });

    const res = await request(app)
      .post("/api/browser-agent/run/parallel")
      .set("Authorization", "Bearer mock-token")
      .send({
        agents: [{ url: "https://example.com", goal: "Single run" }],
        parallel_limit: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.run_ids).toHaveLength(1);

    const batch = await getBatchRecord(res.body.batch_id);
    expect(batch.total_runs).toBe(1);
    expect(batch.parallel_limit).toBe(1);

    await pool.query("DELETE FROM agentic_runs WHERE batch_id = $1", [res.body.batch_id]);
    await pool.query("DELETE FROM agentic_batches WHERE id = $1", [res.body.batch_id]);
  });

  it("auth isolation: other user's batch not visible", async () => {
    // Create a batch for other-user
    const batchInsert = await pool.query(
      `INSERT INTO agentic_batches (user_id, parallel_limit, status, total_runs)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ["other-user", 2, "completed", 1],
    );
    const batchId = batchInsert.rows[0].id;

    const res = await request(app)
      .get(`/api/browser-agent/run/batch/${batchId}/status`)
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(404);

    await pool.query("DELETE FROM agentic_batches WHERE id = $1", [batchId]);
  });
});

describe.skipIf(DATABASE_URL)("Browser-agent parallel E2E (skipped)", () => {
  it("requires DATABASE_URL to run E2E tests", () => {
    expect(DATABASE_URL).toBeUndefined();
  });
});

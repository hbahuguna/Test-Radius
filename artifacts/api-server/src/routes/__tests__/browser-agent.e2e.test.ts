import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

const DATABASE_URL = process.env.DATABASE_URL;

// Mock auth middleware so requireSignedUp just sets req.user and calls next
vi.mock("../../middlewares/auth", () => {
  const fn = async (req: any, _res: any, next: any) => {
    req.user = { id: "demo-user-id", email: "demo@testradius.dev" };
    next();
  };
  return {
    requireAuth: fn,
    requireSignedUp: fn,
    optionalAuth: fn,
    resolveUser: async () => ({ id: "demo-user-id", email: "demo@testradius.dev" }),
  };
});

// Mock auth lib for getOrCreateUser call inside route handler
vi.mock("../../lib/auth", () => ({
  getOrCreateUser: vi.fn((user: any) => Promise.resolve(user)),
}));

// Mock Python backend — intercept all calls to browser-use-client
const mockStreamResult = vi.fn();
vi.mock("../../lib/browser-use-client", () => ({
  startBrowserAgentRun: mockStreamResult,
  sendBrowserAgentChat: vi.fn().mockResolvedValue(true),
  stopBrowserAgentRun: vi.fn().mockResolvedValue(undefined),
  getBrowserAgentScreenshot: vi.fn().mockResolvedValue(null),
  getBrowserAgentRunStatus: vi.fn().mockResolvedValue({ status: "completed", success: true, error: null }),
}));

vi.mock("../../lib/crypto", () => ({
  decryptKey: vi.fn(),
}));

interface AgenticRunRow {
  id: string;
  user_id: string;
  url: string;
  goal: string;
  status: string;
  success: boolean | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  step_count: number | null;
  duration_seconds: number | null;
}

describe.runIf(DATABASE_URL)("Browser-agent E2E", () => {
  let app: any;
  let pool: any;
  const pg = require("pg");
  const { Pool } = pg;

  const DEMO_USER_ID = "demo-user-id";

  beforeAll(async () => {
    process.env.LOG_LEVEL = "silent";
    process.env.DATABASE_URL = DATABASE_URL;

    pool = new Pool({ connectionString: DATABASE_URL });
    // Ensure the demo user exists in the users table (FK target)
    await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [DEMO_USER_ID, "demo@testradius.dev"],
    );

    vi.resetModules();
    const mod = await import("../../app");
    app = mod.default;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        `DELETE FROM credit_ledger WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'credit_ledger') AND user_id = $1`,
        [DEMO_USER_ID],
      ).catch(() => {});
      await pool.query("DELETE FROM user_api_keys WHERE user_id = $1", [DEMO_USER_ID]).catch(() => {});
      await pool.query("DELETE FROM coupon_redemptions WHERE user_id = $1", [DEMO_USER_ID]).catch(() => {});
      await pool.query("DELETE FROM agentic_runs WHERE user_id = $1", [DEMO_USER_ID]);
      await pool.query("DELETE FROM users WHERE id = $1", [DEMO_USER_ID]);
      await pool.end();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function fetchRuns(): Promise<AgenticRunRow[]> {
    const result = await pool.query(
      "SELECT * FROM agentic_runs WHERE user_id = $1 ORDER BY created_at DESC",
      [DEMO_USER_ID],
    );
    return result.rows;
  }

  it("POST /run INSERTs row and responds with started event", async () => {
    mockStreamResult.mockResolvedValue({
      run_id: "py-e2e-1",
      success: true,
      error: null,
      stepCount: 3,
      duration: 15,
    });

    const res = await request(app)
      .post("/api/browser-agent/run")
      .set("Authorization", "Bearer mock-token")
      .send({ url: "https://e2e-test.com", goal: "E2E test goal" });

    expect(res.status).toBe(200);

    const rows = await fetchRuns();
    const run = rows.find((r) => r.url === "https://e2e-test.com");
    expect(run).toBeDefined();
    expect(run!.status).toBe("completed");
    expect(run!.success).toBe(true);
    expect(run!.step_count).toBe(3);
    expect(run!.duration_seconds).toBe(15);
    expect(run!.completed_at).not.toBeNull();

    const body = res.text || "";
    expect(body).toContain('"event":"started"');
    expect(body).toContain('"run_id"');

    await pool.query("DELETE FROM agentic_runs WHERE id = $1", [run!.id]);
  });

  it("POST /run UPDATEs row with status=failed on agent error", async () => {
    mockStreamResult.mockResolvedValue({
      run_id: "py-e2e-2",
      success: false,
      error: "Agent crashed",
      stepCount: 1,
      duration: null,
    });

    const res = await request(app)
      .post("/api/browser-agent/run")
      .set("Authorization", "Bearer mock-token")
      .send({ url: "https://e2e-test-fail.com", goal: "E2E test fail" });

    expect(res.status).toBe(200);

    const rows = await fetchRuns();
    const run = rows.find((r) => r.url === "https://e2e-test-fail.com");
    expect(run).toBeDefined();
    expect(run!.status).toBe("failed");
    expect(run!.success).toBe(false);
    expect(run!.error).toBe("Agent crashed");
    expect(run!.step_count).toBe(1);

    await pool.query("DELETE FROM agentic_runs WHERE id = $1", [run!.id]);
  });

  it("GET /runs returns user's runs sorted by createdAt DESC", async () => {
    const insert1 = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status, created_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '2 hours') RETURNING id`,
      [DEMO_USER_ID, "https://e2e-old.com", "Old run", "completed"],
    );
    const insert2 = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status, created_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour') RETURNING id`,
      [DEMO_USER_ID, "https://e2e-new.com", "New run", "failed"],
    );

    const res = await request(app)
      .get("/api/browser-agent/runs?limit=10")
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(200);
    const runs = res.body.runs;
    const ourRuns = runs.filter((r: any) => r.userId === DEMO_USER_ID);
    expect(ourRuns.length).toBeGreaterThanOrEqual(2);
    expect(ourRuns[0].url).toBe("https://e2e-new.com");
    expect(ourRuns[1].url).toBe("https://e2e-old.com");

    await pool.query("DELETE FROM agentic_runs WHERE id IN ($1, $2)", [
      insert1.rows[0].id,
      insert2.rows[0].id,
    ]);
  });

  it("POST /run validates required url and goal", async () => {
    const res1 = await request(app)
      .post("/api/browser-agent/run")
      .set("Authorization", "Bearer mock-token")
      .send({ url: "", goal: "test" });
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .post("/api/browser-agent/run")
      .set("Authorization", "Bearer mock-token")
      .send({ goal: "test" });
    expect(res2.status).toBe(400);
  });

  it("POST /stop updates row to stopped", async () => {
    const insert = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [DEMO_USER_ID, "https://e2e-stop.com", "To be stopped", "running"],
    );
    const runId = insert.rows[0].id;

    const res = await request(app)
      .post("/api/browser-agent/stop")
      .set("Authorization", "Bearer mock-token")
      .send({ run_id: runId });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stopped");

    const row = await pool.query("SELECT * FROM agentic_runs WHERE id = $1", [runId]);
    expect(row.rows[0].status).toBe("stopped");
    expect(row.rows[0].completed_at).not.toBeNull();

    await pool.query("DELETE FROM agentic_runs WHERE id = $1", [runId]);
  });

  it("auth isolation: other user's runs not visible", async () => {
    // Insert a user and run for another user (needed for FK constraint)
    await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      ["other-user", "other@test.com"],
    );
    const insertOther = await pool.query(
      `INSERT INTO agentic_runs (user_id, url, goal, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ["other-user", "https://other.com", "Other user run", "completed"],
    );

    const res = await request(app)
      .get("/api/browser-agent/runs?limit=50")
      .set("Authorization", "Bearer mock-token");

    expect(res.status).toBe(200);
    const otherUserRuns = res.body.runs.filter((r: any) => r.userId === "other-user");
    expect(otherUserRuns).toHaveLength(0);

    await pool.query("DELETE FROM agentic_runs WHERE user_id = $1", ["other-user"]);
    await pool.query("DELETE FROM users WHERE id = $1", ["other-user"]);
  });
});

describe.skipIf(DATABASE_URL)("Browser-agent E2E (skipped)", () => {
  it("requires DATABASE_URL to run E2E tests", () => {
    expect(DATABASE_URL).toBeUndefined();
  });
});

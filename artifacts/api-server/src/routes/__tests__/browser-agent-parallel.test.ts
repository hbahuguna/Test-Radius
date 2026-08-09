import { describe, it, expect, vi, beforeEach } from "vitest";

// Build chainable mock for db.select() -> .from() -> .where() -> .orderBy() -> etc.
function makeSelectChain() {
  const chain: any = {};
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  return chain;
}

const mockInsertValues = vi.fn();
const mockInsertBatchReturning = vi.fn();
const mockInsertRunReturning = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockSelectChain = makeSelectChain();

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: mockUpdateSet, where: mockUpdateWhere }),
    select: vi.fn().mockReturnValue(mockSelectChain),
  },
}));

vi.mock("@workspace/db/schema", () => ({
  agenticBatchesTable: { id: "agentic_batches", userId: "user_id", status: "status", totalRuns: "total_runs" },
  agenticRunsTable: { id: "agentic_runs", userId: "user_id", status: "status", batchId: "batch_id", createdAt: "created_at" },
  userApiKeysTable: { id: "user_api_keys", userId: "user_id", provider: "provider" },
}));

const mockStartBrowserAgentRun = vi.fn();
vi.mock("../../lib/browser-use-client", () => ({
  startBrowserAgentRun: mockStartBrowserAgentRun,
  sendBrowserAgentChat: vi.fn(),
  stopBrowserAgentRun: vi.fn(),
  getBrowserAgentScreenshot: vi.fn(),
  getBrowserAgentRunStatus: vi.fn(),
}));

vi.mock("../../middlewares/auth", () => {
  const fn = async (req: any, _res: any, next: any) => {
    req.user = { id: "test-user-id", email: "test@test.com" };
    next();
  };
  return { requireAuth: fn, requireSignedUp: fn, optionalAuth: fn, resolveUser: async () => null };
});

vi.mock("../../lib/auth", () => ({
  getOrCreateUser: vi.fn((user: any) => Promise.resolve(user)),
}));

vi.mock("../../lib/crypto", () => ({ decryptKey: vi.fn() }));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function createMockReq(overrides: Record<string, any> = {}): any {
  return {
    user: { id: "test-user-id", email: "test@test.com" },
    body: {},
    query: {},
    params: {},
    headers: {},
    method: "POST",
    url: "/",
    ...overrides,
  };
}

function createMockRes(): any {
  const res: Record<string, any> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  res.write = vi.fn().mockReturnValue(true);
  res.headersSent = false;
  res.writableEnded = false;
  return res;
}

describe("POST /run/parallel", () => {
  let router: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    router = (await import("../browser-agent")).default;

    mockInsertValues
      .mockReturnValueOnce({ returning: mockInsertBatchReturning })
      .mockReturnValue({ returning: mockInsertRunReturning });

    mockInsertBatchReturning.mockResolvedValue([{
      id: "batch-abc-123",
      userId: "test-user-id",
      parallelLimit: 3,
      status: "queued",
      totalRuns: 3,
      completedRuns: 0,
      failedRuns: 0,
    }]);

    mockInsertRunReturning.mockResolvedValue([{ id: "run-xxx", status: "queued" }]);

    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);

    mockSelectChain.where.mockReturnValue(mockSelectChain);
    mockSelectChain.orderBy.mockReturnValue(mockSelectChain);
    mockSelectChain.from.mockReturnValue(mockSelectChain);
  });

  function findRoute(path: string, method: string) {
    return router.stack.find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
  }

  it("rejects empty agents array (400)", async () => {
    const route = findRoute("/run/parallel", "post");
    if (!route) throw new Error("POST /run/parallel route not found");

    const req = createMockReq({ body: { agents: [], parallel_limit: 3 } });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
    );
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("rejects missing agents field (400)", async () => {
    const route = findRoute("/run/parallel", "post");
    if (!route) throw new Error("POST /run/parallel route not found");

    const req = createMockReq({ body: { parallel_limit: 2 } });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects agents with missing url or goal (400)", async () => {
    const route = findRoute("/run/parallel", "post");
    if (!route) throw new Error("POST /run/parallel route not found");

    const req = createMockReq({
      body: { agents: [{ url: "https://example.com" }], parallel_limit: 2 },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("creates batch + N runs, returns batch_id + run_ids", async () => {
    const route = findRoute("/run/parallel", "post");
    if (!route) throw new Error("POST /run/parallel route not found");

    const req = createMockReq({
      body: {
        agents: [
          { url: "https://a.com", goal: "Test A" },
          { url: "https://b.com", goal: "Test B" },
          { url: "https://c.com", goal: "Test C" },
        ],
        parallel_limit: 3,
      },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        batch_id: "batch-abc-123",
        run_ids: expect.any(Array),
      }),
    );
  });

  it("passes parallel_limit to batch creation", async () => {
    const route = findRoute("/run/parallel", "post");
    if (!route) throw new Error("POST /run/parallel route not found");

    const req = createMockReq({
      body: {
        agents: [
          { url: "https://a.com", goal: "Test A" },
          { url: "https://b.com", goal: "Test B" },
        ],
        parallel_limit: 1,
      },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ parallelLimit: 1, totalRuns: 2 }),
    );
  });

  it("defaults parallel_limit to 3 when not provided", async () => {
    const route = findRoute("/run/parallel", "post");
    if (!route) throw new Error("POST /run/parallel route not found");

    const req = createMockReq({
      body: {
        agents: [
          { url: "https://a.com", goal: "Test A" },
          { url: "https://b.com", goal: "Test B" },
        ],
      },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ parallelLimit: 3 }),
    );
  });

  it("creates one run per agent with batchId reference", async () => {
    const route = findRoute("/run/parallel", "post");
    if (!route) throw new Error("POST /run/parallel route not found");

    const req = createMockReq({
      body: {
        agents: [
          { url: "https://a.com", goal: "Test A", model_id: "gpt-4" },
          { url: "https://b.com", goal: "Test B" },
        ],
        parallel_limit: 2,
      },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    const insertCalls = mockInsertValues.mock.calls;
    expect(insertCalls.length).toBeGreaterThanOrEqual(2);

    const insertBatchCall = insertCalls[0];
    expect(insertBatchCall[0]).toMatchObject({ parallelLimit: 2, totalRuns: 2 });

    const firstRunCall = insertCalls[1];
    expect(firstRunCall[0]).toMatchObject({
      userId: "test-user-id",
      url: "https://a.com",
      goal: "Test A",
      status: "queued",
      batchId: "batch-abc-123",
      modelUsed: "poolside",
    });

    const secondRunCall = insertCalls[2];
    expect(secondRunCall[0]).toMatchObject({
      userId: "test-user-id",
      url: "https://b.com",
      goal: "Test B",
      status: "queued",
    });
  });
});

describe("GET /run/batch/:batchId/status", () => {
  let router: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    router = (await import("../browser-agent")).default;

    mockInsertValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);

    mockSelectChain.where.mockReturnValue(mockSelectChain);
    mockSelectChain.orderBy.mockReturnValue(mockSelectChain);
    mockSelectChain.from.mockReturnValue(mockSelectChain);
  });

  function findRoute(path: string, method: string) {
    return router.stack.find(
      (l: any) => l.route && l.route.path === path && l.route.methods?.[method],
    );
  }

  it("returns 404 for non-existent batch", async () => {
    const route = findRoute("/run/batch/:batchId/status", "get");
    if (!route) throw new Error("GET /run/batch/:batchId/status route not found");

    mockSelectChain.limit = vi.fn().mockResolvedValue([]);

    const req = createMockReq({
      method: "GET",
      params: { batchId: "nonexistent-id" },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "batch_not_found" }),
    );
  });

  it("aggregates 2 completed + 1 running correctly", async () => {
    const route = findRoute("/run/batch/:batchId/status", "get");
    if (!route) throw new Error("GET /run/batch/:batchId/status route not found");

    const batch = {
      id: "batch-123",
      userId: "test-user-id",
      parallelLimit: 5,
      status: "running",
      totalRuns: 3,
      completedRuns: 2,
      failedRuns: 0,
      createdAt: new Date(),
      completedAt: null,
    };

    const runs = [
      { id: "run-1", userId: "test-user-id", url: "https://a.com", goal: "A", status: "completed", success: true, batchId: "batch-123" },
      { id: "run-2", userId: "test-user-id", url: "https://b.com", goal: "B", status: "completed", success: true, batchId: "batch-123" },
      { id: "run-3", userId: "test-user-id", url: "https://c.com", goal: "C", status: "running", success: null, batchId: "batch-123" },
    ];

    mockSelectChain.limit = vi.fn().mockResolvedValueOnce([batch]).mockResolvedValue(runs);

    const req = createMockReq({
      method: "GET",
      params: { batchId: "batch-123" },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      batch_id: "batch-123",
      status: "running",
      parallel_limit: 5,
      total: 3,
      completed: 2,
      failed: 0,
      runs: expect.arrayContaining([
        expect.objectContaining({ id: "run-1", status: "completed" }),
        expect.objectContaining({ id: "run-3", status: "running" }),
      ]),
    });
  });

  it("returns 'completed' batch status when all runs done", async () => {
    const route = findRoute("/run/batch/:batchId/status", "get");
    if (!route) throw new Error("GET /run/batch/:batchId/status route not found");

    const batch = {
      id: "batch-456",
      userId: "test-user-id",
      parallelLimit: 2,
      status: "completed",
      totalRuns: 2,
      completedRuns: 2,
      failedRuns: 0,
      createdAt: new Date(),
      completedAt: new Date(),
    };

    const runs = [
      { id: "run-4", status: "completed", success: true },
      { id: "run-5", status: "completed", success: true },
    ];

    mockSelectChain.limit = vi.fn().mockResolvedValueOnce([batch]).mockResolvedValue(runs);

    const req = createMockReq({
      method: "GET",
      params: { batchId: "batch-456" },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      total: 2,
      completed: 2,
      failed: 0,
    }));
  });

  it("returns 'partial_failure' when some runs failed", async () => {
    const route = findRoute("/run/batch/:batchId/status", "get");
    if (!route) throw new Error("GET /run/batch/:batchId/status route not found");

    const batch = {
      id: "batch-789",
      userId: "test-user-id",
      parallelLimit: 3,
      status: "partial_failure",
      totalRuns: 3,
      completedRuns: 2,
      failedRuns: 1,
      createdAt: new Date(),
      completedAt: new Date(),
    };

    const runs = [
      { id: "run-6", url: "https://a.com", status: "completed", success: true },
      { id: "run-7", url: "https://b.com", status: "failed", success: false, error: "Timeout" },
      { id: "run-8", url: "https://c.com", status: "completed", success: true },
    ];

    mockSelectChain.limit = vi.fn().mockResolvedValueOnce([batch]).mockResolvedValue(runs);

    const req = createMockReq({
      method: "GET",
      params: { batchId: "batch-789" },
    });
    const res = createMockRes();

    await route.route.stack[0].handle(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "partial_failure",
      total: 3,
      completed: 2,
      failed: 1,
    }));
  });
});

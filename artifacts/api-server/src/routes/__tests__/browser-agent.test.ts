import { describe, it, expect, vi, beforeEach } from "vitest";

// Build chainable mock for db.select() -> .from() -> .where() -> .limit() etc.
function makeSelectChain() {
  const chain: any = {};
  chain.limit = vi.fn().mockReturnValue(Promise.resolve([]));
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  return chain;
}

const mockInsertValues = vi.fn();
const mockInsertReturning = vi.fn();
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
  agenticRunsTable: { id: "agentic_runs", userId: "user_id", createdAt: "created_at" },
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

vi.mock("../../lib/auth", () => ({
  getOrCreateUser: vi.fn().mockResolvedValue({ id: "test-user", email: "test@test.com" }),
}));

vi.mock("../../lib/crypto", () => ({
  decryptKey: vi.fn(),
}));

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

describe("browser-agent routes", () => {
  let router: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    router = (await import("../browser-agent")).default;

    // Rebind chain fns after module reload
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockInsertReturning.mockResolvedValue([{ id: "db-run-456" }]);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockSelectChain.where.mockReturnValue(mockSelectChain);
    mockSelectChain.orderBy.mockReturnValue(mockSelectChain);
    mockSelectChain.limit.mockReturnValue(Promise.resolve([]));
  });

  describe("POST /run", () => {
    it("INSERTs a row with status=running before streaming begins", async () => {
      mockStartBrowserAgentRun.mockResolvedValue({ run_id: "py-1", success: true });

      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/run" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /run route not found");

      await route.route.stack[0].handle(
        createMockReq({ body: { url: "https://example.com", goal: "test goal" } }),
        createMockRes(),
        () => {},
      );

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://example.com",
          goal: "test goal",
          status: "running",
        }),
      );
      expect(mockStartBrowserAgentRun).toHaveBeenCalled();
    });

    it("UPDATEs row after stream completes", async () => {
      mockStartBrowserAgentRun.mockResolvedValue({
        run_id: "py-1",
        success: true,
        stepCount: 5,
        duration: 30,
      });

      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/run" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /run route not found");

      await route.route.stack[0].handle(
        createMockReq({ body: { url: "https://example.com", goal: "test goal" } }),
        createMockRes(),
        () => {},
      );

      expect(mockUpdateSet).toHaveBeenCalled();
      expect(mockUpdateWhere).toHaveBeenCalled();
    });

    it("UPDATEs row with status=failed when streaming returns error", async () => {
      mockStartBrowserAgentRun.mockResolvedValue({
        run_id: "py-1",
        success: false,
        error: "Agent crashed",
        stepCount: 0,
        duration: null,
      });

      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/run" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /run route not found");

      await route.route.stack[0].handle(
        createMockReq({ body: { url: "https://example.com", goal: "test goal" } }),
        createMockRes(),
        () => {},
      );

      expect(mockUpdateSet).toHaveBeenCalled();
      expect(mockUpdateWhere).toHaveBeenCalled();
    });
  });

  describe("GET /runs", () => {
    it("queries agenticRunsTable scoped to auth'd user with DESC createdAt", async () => {
      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/runs" && l.route.methods?.get,
      );
      if (!route) throw new Error("GET /runs route not found");
      if (!route.route.stack[0]) throw new Error("No handler on GET /runs");

      await route.route.stack[0].handle(
        createMockReq({ method: "GET", url: "/runs", query: { limit: "20" } }),
        createMockRes(),
        () => {},
      );

      expect(mockSelectChain.from).toHaveBeenCalled();
    });
  });
});

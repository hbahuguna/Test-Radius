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
  agenticRunsTable: {
    id: "agentic_runs",
    userId: "user_id",
    createdAt: "created_at",
    metadata: "metadata",
    pythonRunId: "python_run_id",
    videoUrl: "video_url",
  },
  generatedTestScriptsTable: { id: "generated_test_scripts", userId: "user_id", sourceRunId: "source_run_id", version: "version" },
  codeRunsTable: { id: "generated_code_runs", userId: "user_id", scriptId: "script_id" },
  userApiKeysTable: { id: "user_api_keys", userId: "user_id", provider: "provider" },
}));

const mockStartBrowserAgentRun = vi.fn();
const mockProxyBrowserAgentVideo = vi.fn();
const mockGetBrowserAgentRunSteps = vi.fn();
const mockStartCodeRun = vi.fn();
const mockIsWorkerAvailable = vi.fn();
const mockStopCodeRun = vi.fn();
vi.mock("../../lib/browser-use-client", () => ({
  startBrowserAgentRun: mockStartBrowserAgentRun,
  sendBrowserAgentChat: vi.fn(),
  stopBrowserAgentRun: vi.fn(),
  getBrowserAgentScreenshot: vi.fn(),
  getBrowserAgentRunStatus: vi.fn(),
  proxyBrowserAgentVideo: mockProxyBrowserAgentVideo,
  getBrowserAgentRunSteps: mockGetBrowserAgentRunSteps,
}));

vi.mock("../../lib/code-runner", () => ({
  getCodeRun: vi.fn(),
  isWorkerAvailable: mockIsWorkerAvailable,
  startCodeRun: mockStartCodeRun,
  stopCodeRun: mockStopCodeRun,
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
    mockProxyBrowserAgentVideo.mockResolvedValue(200);
    mockGetBrowserAgentRunSteps.mockResolvedValue([]);
    mockIsWorkerAvailable.mockReturnValue(true);
    mockStartCodeRun.mockReturnValue("code-run-123");
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

    it("persists action traces while the stream is active", async () => {
      const trace = [{
        stepNumber: 1,
        url: "https://example.com",
        title: "Example",
        actions: [{ action: "click", raw: { click: { index: 1 } }, element: null }],
      }];
      mockStartBrowserAgentRun.mockImplementationOnce(async (_request: unknown, _res: unknown, options: any) => {
        await options.onTrace(trace);
        return { run_id: "py-1", success: true, actionTrace: trace };
      });

      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/run" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /run route not found");

      await route.route.stack[0].handle(
        createMockReq({ body: { url: "https://example.com", goal: "click the link" } }),
        createMockRes(),
        () => {},
      );

      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ actionTrace: trace }),
      }));
    });

    it("persists a public video URL when recording completed", async () => {
      mockStartBrowserAgentRun.mockResolvedValue({
        run_id: "py-1",
        success: true,
        stepCount: 2,
        duration: 3,
        videoPath: "/run/py-1/video",
      });

      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/run" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /run route not found");

      await route.route.stack[0].handle(
        createMockReq({ body: { url: "https://example.com", goal: "record video" } }),
        createMockRes(),
        () => {},
      );

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ videoUrl: "/api/browser-agent/run/db-run-456/video" }),
      );
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

  describe("POST /runs/:id/generate-code", () => {
    it("generates Playwright code from the persisted action trace", async () => {
      mockSelectChain.limit.mockResolvedValueOnce([{
        id: "db-run-456",
        userId: "test-user",
        url: "https://example.com",
        goal: "Click the sign in button",
        metadata: {
          actionTrace: [{
            stepNumber: 1,
            url: "https://example.com",
            title: "Example",
            actions: [{
              action: "click_element_by_index",
              raw: { click_element_by_index: { index: 2 } },
              element: {
                node_name: "button",
                ax_name: "Sign in",
                attributes: {},
              },
            }],
          }],
        },
      }]);

      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/runs/:id/generate-code" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /runs/:id/generate-code route not found");
      const response = createMockRes();

      await route.route.stack[0].handle(
        createMockReq({ method: "POST", params: { id: "db-run-456" } }),
        response,
        () => {},
      );

      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
        language: "typescript",
        framework: "playwright",
        code: expect.stringContaining("getByRole(\"button\", { name: \"Sign in\" })"),
      }));
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ generatedPlaywrightCode: expect.any(String) }),
      }));
    });

    it("recovers a missing trace from the Python run steps endpoint", async () => {
      mockSelectChain.limit.mockResolvedValueOnce([{
        id: "db-run-456",
        userId: "test-user",
        pythonRunId: "python-run-456",
        url: "https://example.com",
        goal: "Click Sign in",
        metadata: {},
      }]);
      mockGetBrowserAgentRunSteps.mockResolvedValueOnce([{
        event: "step",
        step_number: 1,
        url: "https://example.com",
        title: "Example",
        model_output: {
          actions: [{
            action: "click_element_by_index",
            raw: { click_element_by_index: { index: 1 } },
            element: { node_name: "button", ax_name: "Sign in", attributes: {} },
          }],
        },
      }]);

      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/runs/:id/generate-code" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /runs/:id/generate-code route not found");
      const response = createMockRes();

      await route.route.stack[0].handle(
        createMockReq({ method: "POST", params: { id: "db-run-456" } }),
        response,
        () => {},
      );

      expect(mockGetBrowserAgentRunSteps).toHaveBeenCalledWith("python-run-456");
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: expect.any(String) }));
    });

    it("returns a starter scaffold when no trace can be recovered", async () => {
      mockSelectChain.limit.mockResolvedValueOnce([{
        id: "db-run-no-trace",
        userId: "test-user",
        url: "https://example.com",
        goal: "Describe the page",
        metadata: {},
        pythonRunId: null,
      }]);
      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/runs/:id/generate-code" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /runs/:id/generate-code route not found");
      const response = createMockRes();

      await route.route.stack[0].handle(
        createMockReq({ method: "POST", params: { id: "db-run-no-trace" } }),
        response,
        () => {},
      );

      expect(response.status).not.toHaveBeenCalledWith(422);
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
        code: expect.stringContaining("page.goto"),
        warnings: expect.arrayContaining([expect.stringContaining("starter scaffold")]),
      }));
    });
  });

  describe("GET /run/:id/video", () => {
    it("authorizes the run owner and proxies the Python video", async () => {
      mockSelectChain.limit.mockResolvedValueOnce([{
        id: "db-run-456",
        userId: "test-user",
        pythonRunId: "py-1",
        videoUrl: "/api/browser-agent/run/db-run-456/video",
      }]);
      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/run/:id/video" && l.route.methods?.get,
      );
      if (!route) throw new Error("GET /run/:id/video route not found");
      const response = createMockRes();

      await route.route.stack[0].handle(
        createMockReq({ method: "GET", params: { id: "db-run-456" } }),
        response,
        () => {},
      );

      expect(mockProxyBrowserAgentVideo).toHaveBeenCalledWith("py-1", response);
    });
  });

  describe("POST /scripts/:id/run", () => {
    it("creates a durable execution and starts the isolated worker", async () => {
      mockSelectChain.limit.mockResolvedValueOnce([{
        id: "script-123",
        userId: "test-user",
        code: "export default async function run() {}",
        version: 2,
      }]);
      const route = router.stack.find(
        (l: any) => l.route && l.route.path === "/scripts/:id/run" && l.route.methods?.post,
      );
      if (!route) throw new Error("POST /scripts/:id/run route not found");
      const response = createMockRes();

      await route.route.stack[0].handle(
        createMockReq({ method: "POST", params: { id: "script-123" }, body: { url: "https://example.com" } }),
        response,
        () => {},
      );

      expect(mockStartCodeRun).toHaveBeenCalledWith(expect.objectContaining({
        code: "export default async function run() {}",
        url: "https://example.com",
        userId: "test-user",
      }));
      expect(response.status).toHaveBeenCalledWith(202);
    });
  });
});

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { userApiKeysTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireSignedUp, type AuthedUser } from "../middlewares/auth";
import { getOrCreateUser } from "../lib/auth";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";
import {
  openDatabase,
  DataStore,
  ReplayRunner,
  LLMStepHealer,
  OpenAIChatClient,
  BrowserSession,
  LiveAgent,
  ChromeLaunchError,
  type ReplayEvent,
  type BrowseAgentEvent,
  type Page,
  type TestWithSteps,
  type NewStep,
  type NewSlot,
  type TestSource,
  type RecordedStep,
} from "@workspace/nlp-runner";

const CHROME_WARMING_UP_MSG =
  "Chrome is still downloading on this server (first cold start takes ~3 minutes). Please wait a moment and try again.";
import { ShadowRecorder, type BrowserUseStepEvent } from "../lib/browser-use-recorder.js";
import type { BrowserAgentEvent, BrowserAgentStepEvent, BrowserAgentDoneEvent, BrowserAgentErrorEvent } from "../lib/browser-use-client.js";

const router: IRouter = Router();
router.use(requireSignedUp);

type BrowserInstance = Awaited<ReturnType<typeof BrowserSession.launch>>;

// ----- run registry (one active run per user) -------------------------------
interface ActiveRun {
  session: BrowserInstance | null;
  page: Page | null;
  latestScreenshot: string | null;
  kind: "record" | "replay" | "browse" | null;
  stopped: boolean;
}
const activeRuns = new Map<string, ActiveRun>();

function getActive(userId: string): ActiveRun {
  let r = activeRuns.get(userId);
  if (!r) {
    r = { session: null, page: null, latestScreenshot: null, kind: null, stopped: false };
    activeRuns.set(userId, r);
  }
  return r;
}

// ----- LLM config resolution -----------------------------------------------
const PROVIDER_BASE_URLS: Record<string, string> = {
  poolside: "https://inference.poolside.ai/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  poolside: "poolside/laguna-xs-2.1",
  openai: "gpt-4o-mini",
  openrouter: "poolside/laguna-xs-2.1",
  google: "gemini-3.5-flash",
};

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
}

async function resolveLlmConfig(
  authUser: AuthedUser,
  body: { provider?: string; model_id?: string; api_key?: string },
): Promise<LlmConfig | { error: string }> {
  const provider = body.provider ?? "poolside";
  const model = body.model_id ?? PROVIDER_DEFAULT_MODELS[provider] ?? "";
  const baseUrl = PROVIDER_BASE_URLS[provider];
  if (!baseUrl) {
    return { error: `Unsupported provider "${provider}" for QueryFirst. Supported: ${Object.keys(PROVIDER_BASE_URLS).join(", ")}` };
  }

  let apiKey = body.api_key ?? "";
  if (!apiKey) {
    const user = (await getOrCreateUser(authUser))!;
    const keyRows = await db
      .select()
      .from(userApiKeysTable)
      .where(eq(userApiKeysTable.userId, user.id))
      .limit(20);
    const match = keyRows.find((k) => k.provider === provider);
    if (match) {
      apiKey = decryptKey(JSON.parse(match.encryptedKey));
    }
  }
  if (!apiKey) {
    return { error: `No API key found for provider "${provider}". Add one in Settings or pass api_key in the request.` };
  }
  return { baseUrl, apiKey, model, provider };
}

// ----- SSE helpers -----------------------------------------------------------
function sseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

function sseWrite(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureScreenshot(page: Page | null): Promise<string | null> {
  if (!page) return null;
  try {
    const b64 = await page.screenshot();
    return b64 ? `data:image/png;base64,${b64}` : null;
  } catch {
    return null;
  }
}

// ----- DB singleton ---------------------------------------------------------
let _store: DataStore | null = null;
function getStore(): DataStore {
  if (!_store) {
    const dataDir = process.env.QF_DATA_DIR ?? `${process.env.HOME ?? ""}/.queryfirst`;
    const db2 = openDatabase(dataDir);
    _store = new DataStore(db2);
  }
  return _store;
}

// ----- routes ----------------------------------------------------------------

// GET /queryfirst/tests — list all recorded tests
router.get("/tests", async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    const tests = store.listTests();
    const out = tests.map((t: TestWithSteps) => {
      const steps = store.listStepsByTest(t.id);
      const slots = store.listSlotsByTest(t.id);
      return {
        id: t.id,
        name: t.name,
        source: t.source,
        query: t.query,
        entryUrl: t.entryUrl,
        stepCount: steps.length,
        steps: steps.map((s: { id: number; idx: number; action: string; selector: string | null; value: string | null }) => ({
          id: s.id,
          idx: s.idx,
          action: s.action,
          selector: s.selector,
          value: s.value,
        })),
        slots: slots.map((s: { name: string; kind: string; defaultValue: string | null }) => ({
          name: s.name,
          kind: s.kind,
          defaultValue: s.defaultValue,
        })),
      };
    });
    res.json({ tests: out });
  } catch (err) {
    logger.error({ err }, "queryfirst: list tests failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list tests" });
  }
});

// GET /queryfirst/runs/:testId — run history for a test
router.get("/runs/:testId", async (req: Request, res: Response) => {
  try {
    const testId = Number(req.params.testId);
    if (!Number.isInteger(testId)) {
      res.status(400).json({ error: "invalid_test_id" });
      return;
    }
    const store = getStore();
    const runs = store.listRuns(testId);
    res.json({
      runs: runs.map((r: { id: number; testId: number; status: string; llmCalls: number; startedAt: string; finishedAt: string | null; error: unknown }) => ({
        id: r.id,
        testId: r.testId,
        status: r.status,
        llmCalls: r.llmCalls,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error instanceof Error ? r.error.message : r.error,
      })),
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: list runs failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list runs" });
  }
});

// DELETE /queryfirst/tests/:id — delete a test (cascades to steps/slots/runs)
router.delete("/tests/:id", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "invalid_test_id" });
      return;
    }
    const store = getStore();
    store.deleteTest(id);
    res.json({ ok: true, deletedId: id });
  } catch (err) {
    logger.error({ err }, "queryfirst: delete test failed");
    res.status(500).json({ error: "internal_error", message: "Failed to delete test" });
  }
});

// GET /queryfirst/screenshot — latest screenshot for the user's active run
router.get("/screenshot", async (req: Request, res: Response) => {
  const active = getActive(req.user!.id);
  const img = await captureScreenshot(active.page);
  if (img) {
    active.latestScreenshot = img;
  }
  res.json({ screenshot: active.latestScreenshot });
});

// POST /queryfirst/stop — abort the user's active run
router.post("/stop", async (req: Request, res: Response) => {
  const active = getActive(req.user!.id);
  active.stopped = true;
  try {
    if (active.session) {
      await active.session.close();
    }
  } catch { /* ignore */ }
  active.session = null;
  active.page = null;
  res.json({ ok: true });
});

// POST /queryfirst/record — SSE: record a new test using browser-use agent + shadow CDP recorder
router.post("/record", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { query, entry_url, variables, model_id, provider, api_key, use_vision, max_steps } = req.body ?? {};

  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "invalid_request", message: "query is required" });
    return;
  }

  const llmCfg = await resolveLlmConfig(authUser, req.body ?? {});
  if ("error" in llmCfg) {
    sseHeaders(res);
    sseWrite(res, { event: "error", message: llmCfg.error });
    res.end();
    return;
  }

  const active = getActive(authUser.id);
  if (active.session) {
    sseHeaders(res);
    sseWrite(res, { event: "error", message: "A run is already in progress. Stop it first." });
    res.end();
    return;
  }
  active.stopped = false;
  active.kind = "record";

  sseHeaders(res);
  sseWrite(res, { event: "started", kind: "record" });

  const store = getStore();

  let browserSession: BrowserInstance | null = null;
  let recorder: ShadowRecorder | null = null;
  let savedTestId: number | null = null;

  try {
    // 1. Launch our own Chrome with a known debug port
    browserSession = await BrowserSession.launch({ headless: true, timeoutMs: 30_000 });
    const cdpHttpUrl = `http://127.0.0.1:${browserSession.browser.port}`;
    logger.info({ cdpHttpUrl }, "queryfirst: record — launched our own Chrome");

    // 2. Connect shadow recorder to the same Chrome (second CDP connection)
    recorder = await ShadowRecorder.connect(cdpHttpUrl);
    active.session = browserSession;
    active.page = null; // ShadowRecorder attaches its own page

    // 3. Start browser-use run, pointing at our Chrome via cdp_url
    const provider = llmCfg.provider;
    const runResponse = await fetch(
      `${getBrowserUseUrl()}/run`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": process.env.BROWSER_USE_INTERNAL_SECRET ?? "dev-secret-change-in-production",
        },
        body: JSON.stringify({
          url: entry_url ?? "about:blank",
          goal: query,
          model_id: model_id ?? llmCfg.model,
          max_steps: max_steps ?? 50,
          model_provider: provider,
          poolside_api_key: llmCfg.apiKey,
          api_key: llmCfg.apiKey, // Generic API key for any OpenAI-compatible provider
          base_url: llmCfg.baseUrl, // Generic Base URL for any OpenAI-compatible provider
          use_vision: use_vision ?? false,
          cdp_url: cdpHttpUrl,
          redact_values: false, // Don't redact — capture real values for slot defaults
        }),
      }
    );

    if (!runResponse.ok) {
      const err = await runResponse.text();
      throw new Error(`Browser-use /run failed: ${err}`);
    }

    const runData = (await runResponse.json()) as { run_id: string };
    logger.info({ run_id: runData.run_id }, "queryfirst: record — browser-use run started");

    // 4. Stream SSE from browser-use, relay to frontend, and capture via ShadowRecorder
    const streamResponse = await fetch(
      `${getBrowserUseUrl()}/run/${runData.run_id}/stream`,
      {
        headers: {
          "X-Internal-Secret": process.env.BROWSER_USE_INTERNAL_SECRET ?? "dev-secret-change-in-production",
        },
      }
    );

    if (!streamResponse.ok) {
      throw new Error("Failed to connect to browser-use event stream");
    }

    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let attached = false;

    runLoop: while (true) {
      if (active.stopped) {
        // User requested stop
        try {
          await fetch(
            `${getBrowserUseUrl()}/run/${runData.run_id}/stop`,
            {
              method: "POST",
              headers: {
                "X-Internal-Secret": process.env.BROWSER_USE_INTERNAL_SECRET ?? "dev-secret-change-in-production",
              },
            },
          );
        } catch { /* best-effort */ }
        sseWrite(res, { event: "done", ok: false, error: "Recording stopped by user" });
        res.end();
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event: BrowserAgentEvent = JSON.parse(line.slice(6));

        // Relay raw event to frontend
        if (!active.stopped) {
          sseWrite(res, { event: "record", ...translateBrowserUseEvent(event) });
        }

        // ShadowRecorder side-channel
        if (!attached && event.event === "loading") {
          await recorder.attachToPage();
          attached = true;
          active.page = recorder.getPage(); // Set active page for screenshot polling!
        }

        if (event.event === "loading") {
          await recorder.processLoadingEvent();
        } else if (event.event === "step") {
          await recorder.processStepEvent(event as BrowserUseStepEvent);
        } else if (event.event === "done") {
          // 5. Finalize recorder
          const result = await recorder.finalize();
          logger.info({ stepCount: result.steps.length }, "queryfirst: record — shadow recorder finalized");

          // 6. Save to DataStore
          const newSteps = buildStepsWithNavigation(result.steps, result.entryUrl || entry_url || "");

          const newSlots = result.slots.map((s): NewSlot => ({
            name: s.name,
            kind: s.kind,
            defaultValue: s.defaultValue ?? null,
          }));

          const saved = store.saveTest({
            name: query.slice(0, 80),
            source: "recorder",
            entryUrl: result.entryUrl || entry_url || "",
            stepHash: result.stepHash,
            query,
            steps: newSteps,
            slots: newSlots,
          });
          savedTestId = saved.id;
          logger.info({ testId: saved.id }, "queryfirst: record — test saved");

          // 7. Dry-run gate
          const gateResult = await runDryRunGate(store, saved.id, variables);
          sseWrite(res, {
            event: "done",
            ok: gateResult.success,
            testId: gateResult.success ? saved.id : undefined,
            error: gateResult.success ? undefined : gateResult.error,
          });
          break runLoop;
        } else if (event.event === "error") {
          sseWrite(res, {
            event: "done",
            ok: false,
            error: (event as BrowserAgentErrorEvent).message,
          });
          break runLoop;
          sseWrite(res, {
            event: "done",
            ok: false,
            error: (event as BrowserAgentErrorEvent).message,
          });
        }
      }
    }

    // Stream ended without a done event — treat as completion
    if (attached && recorder && !savedTestId) {
      const result = await recorder.finalize();
      const saved = store.saveTest({
        name: query.slice(0, 80),
        source: "recorder",
        entryUrl: result.entryUrl || entry_url || "",
        stepHash: result.stepHash,
        query,
        steps: buildStepsWithNavigation(result.steps, result.entryUrl || entry_url || ""),
        slots: result.slots.map((s): NewSlot => ({
          name: s.name,
          kind: s.kind,
          defaultValue: s.defaultValue ?? null,
        })),
      });
      const gateResult = await runDryRunGate(store, saved.id, variables);
      sseWrite(res, {
        event: "done",
        ok: gateResult.success,
        testId: gateResult.success ? saved.id : undefined,
        error: gateResult.success ? undefined : gateResult.error,
      });
    }
  } catch (err) {
    logger.error({ err }, "queryfirst: record failed");
    const msg = err instanceof ChromeLaunchError ? CHROME_WARMING_UP_MSG : (err instanceof Error ? err.message : String(err));
    sseWrite(res, { event: "error", message: msg });
  } finally {
    try { if (recorder) await recorder.close(); } catch { /* */ }
    try { if (browserSession) await browserSession.close(); } catch { /* */ }
    active.session = null;
    active.page = null;
    active.kind = null;
  }
  res.end();
});

// ----- helpers for the rewritten /record endpoint ---------------------------

function getBrowserUseUrl(): string {
  return process.env.BROWSER_USE_URL ?? "http://localhost:8001";
}

function getBrowserUseSecret(): string {
  return process.env.BROWSER_USE_INTERNAL_SECRET ?? "dev-secret-change-in-production";
}

function buildStepsWithNavigation(
  recordedSteps: RecordedStep[],
  entryUrl: string,
): NewStep[] {
  const steps: NewStep[] = [];
  
  if (entryUrl && (recordedSteps.length === 0 || recordedSteps[0].action !== "navigate")) {
    steps.push({
      action: "navigate",
      value: entryUrl,
      locators: [],
      selector: null,
      elementFingerprint: null,
      pageSignatureBefore: null,
      pageSignatureAfter: null,
      waitCondition: null,
      assertion: null,
    });
  }

  steps.push(
    ...recordedSteps.map((s): NewStep => ({
      action: s.action,
      selector: s.selector ?? null,
      value: s.value ?? null,
      locators: s.locators ?? null,
      elementFingerprint: s.elementFingerprint ?? null,
      pageSignatureBefore: s.pageSignatureBefore ?? null,
      pageSignatureAfter: s.pageSignatureAfter ?? null,
      waitCondition: s.waitCondition ?? null,
      assertion: s.assertion ?? null,
    }))
  );

  return steps;
}

/** Translate browser-use SSE events into the QfEvent format the frontend understands. */
function translateBrowserUseEvent(event: BrowserAgentEvent): Record<string, unknown> {
  switch (event.event) {
    case "step": {
      const step = event as BrowserAgentStepEvent;
      const actions = step.action_trace?.length
        ? step.action_trace
        : step.model_output?.actions?.map((a) => ({
            action: a.name,
            raw: a.raw,
            element: null,
          })) || [];
      return {
        type: "step",
        turn: step.step_number,
        stepIndex: step.step_number,
        action: actions,
        ok: true,
        url: step.url,
        title: step.title,
        screenshot: step.screenshot,
        thinking: step.model_output?.thinking,
        nextGoal: step.model_output?.next_goal,
        memory: step.model_output?.memory,
      };
    }
    case "done": {
      const done = event as BrowserAgentDoneEvent;
      return {
        type: "done",
        success: done.success,
        message: done.message,
        duration: done.duration,
        actionTrace: done.action_trace,
      };
    }
    case "error": {
      const err = event as BrowserAgentErrorEvent;
      return {
        type: "error",
        message: err.message,
        videoUrl: err.video_url ?? err.video_path,
      };
    }
    case "loading": {
      return {
        type: "loading",
        stepIndex: 0,
        url: event.url,
        title: event.title,
        screenshot: event.screenshot,
      };
    }
    default:
      return { type: "unknown" };
  }
}

/** Run the dry-run gate with a separate browser session. */
async function runDryRunGate(
  store: DataStore,
  testId: number,
  variables?: Record<string, string>,
): Promise<{ success: boolean; error?: string; failingStep?: number }> {
  let gatePage: Page | null = null;
  let gateSession: BrowserInstance | null = null;
  try {
    gateSession = await BrowserSession.launch({ headless: true, timeoutMs: 20_000 });
    gatePage = await gateSession.newPage();
    const testWithSteps = store.getTestWithSteps(testId);
    if (!testWithSteps) return { success: false, error: "test not found" };
    const runner = new ReplayRunner(gatePage);
    const result = await runner.runTest(store, testWithSteps, {
      variables: variables ?? {},
      timeoutMs: 30_000,
    });
    return result.success
      ? { success: true as const }
      : {
          success: false,
          error: result.error,
          failingStep: result.steps.find((s: { status: string }) => s.status === "failed")?.idx,
        };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (gateSession) await gateSession.close();
  }
}

// POST /queryfirst/replay — SSE: replay a saved test (optionally with healing)
router.post("/replay", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { test_id, variables, entry_url, headful } = req.body ?? {};

  const testId = Number(test_id);
  if (!Number.isInteger(testId) || testId <= 0) {
    res.status(400).json({ error: "invalid_request", message: "test_id is required" });
    return;
  }

  const store = getStore();
  const test = store.getTestWithSteps(testId);
  if (!test) {
    res.status(404).json({ error: "not_found", message: `Test #${testId} not found` });
    return;
  }

  // Resolve LLM config for healing (optional — replay works without it)
  const llmCfg = await resolveLlmConfig(authUser, req.body ?? {});
  const hasLlm = !("error" in llmCfg);

  const active = getActive(authUser.id);
  if (active.session) {
    sseHeaders(res);
    sseWrite(res, { event: "error", message: "A run is already in progress. Stop it first." });
    res.end();
    return;
  }
  active.stopped = false;
  active.kind = "replay";

  sseHeaders(res);
  sseWrite(res, { event: "started", kind: "replay", testId, testName: test.name, stepCount: test.steps.length });

  let browserSession: BrowserInstance | null = null;

  try {
    browserSession = await BrowserSession.launch({ headless: headful !== true, timeoutMs: 20_000 });
    const page = await browserSession.newPage();
    active.session = browserSession;
    active.page = page;

    // If an entry_url override is given (e.g. ?redesign=1 for heal demo), navigate there first
    if (entry_url && typeof entry_url === "string") {
      await page.navigate(entry_url);
    }

    const healer = hasLlm
      ? new LLMStepHealer(new OpenAIChatClient({
          baseUrl: (llmCfg as LlmConfig).baseUrl,
          apiKey: (llmCfg as LlmConfig).apiKey,
          model: (llmCfg as LlmConfig).model,
        }))
      : undefined;

    const runner = new ReplayRunner(page);
    const result = await runner.runTest(store, test, {
      variables: variables ?? {},
      healer,
      onEvent: (event: ReplayEvent) => {
        if (active.stopped) return;
        sseWrite(res, { event: "replay", ...event });
      },
    });

    // Hold the run open for a grace period BEFORE signalling done: the frontend
    // stops screenshot-polling the moment it receives "done", and the browser is
    // torn down in the finally block — so without this, the final step's effect
    // (e.g. an anchor scroll) is destroyed before the live browser ever shows it.
    await sleep(result.success ? 3000 : 1500);

    sseWrite(res, {
      event: "done",
      ok: result.success,
      runId: result.runId,
      testId: result.testId,
      llmCalls: result.llmCalls,
      selfHealed: result.selfHealed,
      error: result.error,
    });

    // Give the frontend a moment to capture the final screenshot state, then
    // let the finally block close the browser.
    await sleep(1000);
  } catch (err) {
    logger.error({ err }, "queryfirst: replay failed");
    const msg = err instanceof ChromeLaunchError ? CHROME_WARMING_UP_MSG : (err instanceof Error ? err.message : String(err));
    sseWrite(res, { event: "error", message: msg });
  } finally {
    try { if (browserSession) await browserSession.close(); } catch { /* */ }
    active.session = null;
    active.page = null;
    active.kind = null;
  }
  res.end();
});

export default router;

// POST /queryfirst/browse — SSE: run the live agent on a free-form browsing task
router.post("/browse", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { query, entry_url, max_steps, max_actions } = req.body ?? {};

  if (!query || typeof query !== "string") {
    res.status(400).json({ error: "invalid_request", message: "query is required" });
    return;
  }

  const llmCfg = await resolveLlmConfig(authUser, req.body ?? {});
  if ("error" in llmCfg) {
    sseHeaders(res);
    sseWrite(res, { event: "error", message: llmCfg.error });
    res.end();
    return;
  }

  const active = getActive(authUser.id);
  if (active.session) {
    sseHeaders(res);
    sseWrite(res, { event: "error", message: "A run is already in progress. Stop it first." });
    res.end();
    return;
  }
  active.stopped = false;
  active.kind = "browse";

  sseHeaders(res);
  sseWrite(res, { event: "started", kind: "browse" });

  let browserSession: BrowserInstance | null = null;

  try {
    browserSession = await BrowserSession.launch({ headless: true, timeoutMs: 30_000 });
    const page = await browserSession.newPage();
    active.session = browserSession;
    active.page = page;

    if (entry_url && typeof entry_url === "string") {
      await page.navigate(entry_url).catch(() => {});
    }

    const llm = new OpenAIChatClient({
      baseUrl: llmCfg.baseUrl,
      apiKey: llmCfg.apiKey,
      model: llmCfg.model,
    });

    const agent = new LiveAgent({
      session: browserSession,
      llm,
      maxSteps: max_steps ?? 50,
      maxActionsPerStep: max_actions ?? 3,
      onEvent: (ev: BrowseAgentEvent) => {
        if (active.stopped) return;
        sseWrite(res, { event: "browse", ...ev });
      },
    });

    const result = await agent.browse(query);

    sseWrite(res, {
      event: "done",
      ok: result.success,
      error: result.success ? undefined : result.finalText,
      llmCalls: result.llmCalls,
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: browse failed");
    const msg = err instanceof ChromeLaunchError ? CHROME_WARMING_UP_MSG : (err instanceof Error ? err.message : String(err));
    sseWrite(res, { event: "error", message: msg });
  } finally {
    try { if (browserSession) await browserSession.close(); } catch { /* */ }
    active.session = null;
    active.page = null;
    active.kind = null;
  }
  res.end();
});
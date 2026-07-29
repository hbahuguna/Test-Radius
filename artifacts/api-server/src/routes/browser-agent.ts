import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { userApiKeysTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser } from "../lib/auth";
import {
  startBrowserAgentRun,
  sendBrowserAgentChat,
  stopBrowserAgentRun,
  getBrowserAgentScreenshot,
  getBrowserAgentRunStatus,
  type BrowserAgentRunRequest,
} from "../lib/browser-use-client";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Auth required, but NO credit checks - all actions are free
router.use(requireSignedUp);

// Track current run ID per user (simple in-memory store)
const userRuns = new Map<string, string>();

/**
 * POST /api/browser-agent/run
 * Start a new browser-agent run. No credits required.
 */
router.post("/run", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { url, goal, model_id, max_steps, use_vision, keep_alive, cache_key } = req.body ?? {};

  if (!url || !goal) {
    res.status(400).json({
      error: "invalid_request",
      message: "url and goal are required",
    });
    return;
  }

  logger.info({ userId: authUser.id, url }, "Starting browser-agent run");

  // Poolside models don't support vision/multimodal - force use_vision to false
  const modelId = model_id || "poolside/laguna-xs-2.1";
  const isPoolsideModel = typeof modelId === "string" && modelId.startsWith("poolside/");
  const effectiveUseVision = use_vision && !isPoolsideModel;

  // Extract model provider from model_id (format: "provider/model-name")
  const modelProvider = typeof modelId === "string" && modelId.includes("/")
    ? modelId.split("/")[0]
    : "poolside";

  // Look up API key for the provider
  const user = (await getOrCreateUser(authUser))!;
  const keyRow = await db
    .select()
    .from(userApiKeysTable)
    .where(eq(userApiKeysTable.userId, user.id))
    .limit(10);
  const match = keyRow.find((k) => k.provider === modelProvider);

  let byokKey: string | null = null;
  if (match) {
    byokKey = decryptKey(JSON.parse(match.encryptedKey));
  }

  const runRequest: BrowserAgentRunRequest = {
    url,
    goal,
    model_id: isPoolsideModel ? modelId.replace(/^poolside\//, "") : modelId,
    model_provider: modelProvider,
    max_steps: max_steps || 30,
    use_vision: effectiveUseVision,
    keep_alive: keep_alive ?? true,
    ...(byokKey ? { poolside_api_key: byokKey } : {}),
    ...(cache_key ? { cache_key } : {}),
  };

  // This awaits until streaming is complete - don't return before!
  const result = await startBrowserAgentRun(runRequest, res);

  if (result) {
    userRuns.set(authUser.id, result.run_id);
    logger.info({ userId: authUser.id, runId: result.run_id }, "Browser-agent run completed");
  }

  if (!res.writableEnded) {
    res.end();
  }
});

/**
 * POST /api/browser-agent/chat
 * Send a follow-up message to the running agent.
 */
router.post("/chat", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { message, run_id } = req.body ?? {};

  const runId = run_id || userRuns.get(authUser.id);
  if (!runId) {
    res.status(404).json({
      error: "no_active_run",
      message: "No active browser-agent run found",
    });
    return;
  }

  if (!message) {
    res.status(400).json({
      error: "invalid_request",
      message: "message is required",
    });
    return;
  }

  logger.info({ userId: authUser.id, runId }, "Sending chat message to agent");

  const success = await sendBrowserAgentChat(runId, message);

  if (success) {
    res.json({ status: "ok", message: "Message sent to agent" });
  } else {
    res.status(500).json({
      error: "send_failed",
      message: "Failed to send message to agent",
    });
  }
});

/**
 * POST /api/browser-agent/stop
 * Stop the current browser-agent run.
 */
router.post("/stop", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { run_id } = req.body ?? {};

  const runId = run_id || userRuns.get(authUser.id);

  logger.info({ userId: authUser.id, runId }, "Stopping browser-agent run");

  await stopBrowserAgentRun();

  if (runId) {
    userRuns.delete(authUser.id);
  }

  res.json({ status: "stopped" });
});

/**
 * GET /api/browser-agent/screenshot
 * Get the current live screenshot.
 */
router.get("/screenshot", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const runId = req.query.run_id as string | undefined;

  try {
    const buffer = await getBrowserAgentScreenshot(runId || userRuns.get(authUser.id));

    if (!buffer) {
      res.status(404).json({ error: "no_screenshot" });
      return;
    }

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.json({ screenshot: buffer.toString("base64") });
  } catch (err) {
    logger.error({ err }, "Screenshot failed");
    res.status(500).json({ error: "screenshot_failed" });
  }
});

/**
 * GET /api/browser-agent/status
 * Get the status of the current or specified run.
 */
router.get("/status", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const runId = req.query.run_id as string | undefined;

  const targetRunId = runId || userRuns.get(authUser.id);
  if (!targetRunId) {
    res.json({ status: "idle", run_id: null });
    return;
  }

  const status = await getBrowserAgentRunStatus(targetRunId);
  if (status) {
    res.json(status);
  } else {
    res.json({ status: "unknown", run_id: targetRunId });
  }
});

/**
 * DELETE /api/browser-agent/run
 * Clear the current run reference.
 */
router.delete("/run", (req: Request, res: Response) => {
  const authUser = req.user!;
  userRuns.delete(authUser.id);
  res.json({ status: "cleared" });
});

/**
 * POST /api/browser-agent/generate-code
 * Generate Playwright code from a URL/goal using Stagehand.
 */
router.post("/generate-code", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { url, goal, model_id, model_provider, api_key } = req.body ?? {};

  if (!url || !goal) {
    res.status(400).json({
      error: "invalid_request",
      message: "url and goal are required",
    });
    return;
  }

  logger.info({ userId: authUser.id, url, goal }, "Generating Playwright code");

  try {
    const { Stagehand } = await import("@browserbasehq/stagehand");
    const { z } = await import("zod");

    const resultSchema = z.object({
      description: z.string(),
      code: z.string(),
    });

    const stagehand = new Stagehand({
      env: "LOCAL",
      model: model_provider === "poolside"
        ? {
            modelName: model_id || "poolside/laguna-xs-2.1",
            apiKey: api_key || process.env.POOLSIDE_API_KEY,
            baseURL: "https://inference.poolside.ai/v1",
          }
        : model_provider
          ? `${model_provider}/${model_id || "gpt-4o-mini"}`
          : "openai/gpt-4o-mini",
      cacheDir: "/tmp/stagehand-code-cache",
    });

    await stagehand.init();
    const page = stagehand.context.pages()[0];
    await page.goto(url);

    const result = await stagehand.extract(
      `Generate Playwright test code for this task: ${goal}

Return a JSON object with:
- description: brief description of what the test does
- code: complete Playwright test code (TypeScript) that accomplishes the goal

The code should use @playwright/test and follow best practices. Include proper assertions.`,
      resultSchema,
    );

    await stagehand.close();

    res.json({
      success: true,
      description: result?.description || "Generated test",
      code: result?.code || "",
    });
  } catch (error) {
    logger.error({ error }, "Failed to generate code");
    res.status(500).json({
      error: "generation_failed",
      message: error instanceof Error ? error.message : "Failed to generate code",
    });
  }
});

export default router;
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { agenticRunsTable, agenticBatchesTable, userApiKeysTable } from "@workspace/db/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser } from "../lib/auth";
import {
  startBrowserAgentRun,
  sendBrowserAgentChat,
  stopBrowserAgentRun,
  stopBrowserAgentRunWithId,
  getBrowserAgentScreenshot,
  getBrowserAgentRunStatus,
  waitForBrowserAgentRun,
  type BrowserAgentRunRequest,
} from "../lib/browser-use-client";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use(requireSignedUp);

async function findActiveRun(userId: string): Promise<string | null> {
  const [run] = await db
    .select()
    .from(agenticRunsTable)
    .where(
      and(
        eq(agenticRunsTable.userId, userId),
        inArray(agenticRunsTable.status, ["running", "queued"]),
      ),
    )
    .orderBy(desc(agenticRunsTable.createdAt))
    .limit(1);
  return run?.id ?? null;
}

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

  const modelId = model_id || "poolside/laguna-xs-2.1";
  const isPoolsideModel = typeof modelId === "string" && modelId.startsWith("poolside/");
  const effectiveUseVision = use_vision && !isPoolsideModel;

  const modelProvider = typeof modelId === "string" && modelId.includes("/")
    ? modelId.split("/")[0]
    : "poolside";

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

  const [run] = await db
    .insert(agenticRunsTable)
    .values({
      userId: user.id,
      url,
      goal,
      status: "running",
      modelUsed: modelProvider,
      pythonRunId: null,
    })
    .returning();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write(`data: ${JSON.stringify({ event: "started", run_id: run.id })}\n\n`);

  const result = await startBrowserAgentRun(runRequest, res);

  if (result) {
    await db
      .update(agenticRunsTable)
      .set({
        pythonRunId: result.run_id,
        status: result.success ? "completed" : "failed",
        success: result.success,
        error: result.error,
        stepCount: result.stepCount,
        duration: result.duration,
        completedAt: new Date(),
      })
      .where(eq(agenticRunsTable.id, run.id));

    logger.info(
      { userId: authUser.id, runId: run.id, status: result.success ? "completed" : "failed" },
      "Browser-agent run finished",
    );
  }

  if (!res.writableEnded) {
    res.end();
  }
});

router.post("/chat", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { message, run_id } = req.body ?? {};

  const runId = run_id || (await findActiveRun(authUser.id));
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

  const run = await db
    .select()
    .from(agenticRunsTable)
    .where(eq(agenticRunsTable.id, runId))
    .limit(1);

  if (!run[0]?.pythonRunId) {
    res.status(404).json({
      error: "run_not_found",
      message: "Run not found or not active",
    });
    return;
  }

  logger.info({ userId: authUser.id, runId, pythonRunId: run[0].pythonRunId }, "Sending chat message to agent");

  const success = await sendBrowserAgentChat(run[0].pythonRunId, message);

  if (success) {
    res.json({ status: "ok", message: "Message sent to agent" });
  } else {
    res.status(500).json({
      error: "send_failed",
      message: "Failed to send message to agent",
    });
  }
});

router.post("/stop", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { run_id } = req.body ?? {};

  const runId = run_id || (await findActiveRun(authUser.id));

  if (!runId) {
    res.status(404).json({
      error: "no_active_run",
      message: "No active browser-agent run found",
    });
    return;
  }

  const run = await db
    .select()
    .from(agenticRunsTable)
    .where(eq(agenticRunsTable.id, runId))
    .limit(1);

  const pythonRunId = run[0]?.pythonRunId;

  logger.info({ userId: authUser.id, runId, pythonRunId }, "Stopping browser-agent run");

  if (pythonRunId) {
    await stopBrowserAgentRunWithId(pythonRunId);
  }

  await db
    .update(agenticRunsTable)
    .set({ status: "stopped", completedAt: new Date() })
    .where(eq(agenticRunsTable.id, runId));

  res.json({ status: "stopped" });
});

router.get("/screenshot", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const runIdParam = req.query.run_id as string | undefined;

  try {
    const activeRunId = runIdParam || (await findActiveRun(authUser.id));
    const buffer = await getBrowserAgentScreenshot(activeRunId ?? undefined);

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

router.get("/status", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const runIdParam = req.query.run_id as string | undefined;

  const activeRunId = runIdParam || (await findActiveRun(authUser.id));
  if (!activeRunId) {
    res.json({ status: "idle", run_id: null });
    return;
  }

  const status = await getBrowserAgentRunStatus(activeRunId);
  if (status) {
    res.json(status);
  } else {
    res.json({ status: "unknown", run_id: activeRunId });
  }
});

router.delete("/run", async (req: Request, res: Response) => {
  const authUser = req.user!;
  await db
    .update(agenticRunsTable)
    .set({ status: "stopped", completedAt: new Date() })
    .where(
      and(
        eq(agenticRunsTable.userId, authUser.id),
        inArray(agenticRunsTable.status, ["running", "queued"]),
      ),
    );
  res.json({ status: "cleared" });
});

router.get("/runs", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const runs = await db
    .select()
    .from(agenticRunsTable)
    .where(eq(agenticRunsTable.userId, authUser.id))
    .orderBy(desc(agenticRunsTable.createdAt))
    .limit(limit);
  res.json({ runs });
});

// ============================================================
// TRP4-23: Multi-agent parallel run endpoint
// ============================================================

function parseModelRef(modelId: string): { provider: string; shortId: string } {
  const hasSlash = modelId.includes("/");
  return {
    provider: hasSlash ? modelId.split("/")[0] : "poolside",
    shortId: hasSlash && modelId.startsWith("poolside/") ? modelId.replace(/^poolside\//, "") : modelId,
  };
}

async function runBatchAgents(
  agents: Array<{ url: string; goal: string; model_id?: string; max_steps?: number; use_vision?: boolean }>,
  batch: { id: string },
  user: { id: string },
  parallelLimit: number,
): Promise<void> {
  let completedRuns = 0;
  let failedRuns = 0;

  const keyRow = await db
    .select()
    .from(userApiKeysTable)
    .where(eq(userApiKeysTable.userId, user.id))
    .limit(10);
  const poolsideKeyRow = keyRow.find((k) => k.provider === "poolside");
  const byokKey = poolsideKeyRow ? decryptKey(JSON.parse(poolsideKeyRow.encryptedKey)) : null;

  async function runOne(agent: typeof agents[number]): Promise<void> {
    try {
      const modelId = agent.model_id || "poolside/laguna-xs-2.1";
      const { provider, shortId } = parseModelRef(modelId);
      const isPoolsideModel = provider === "poolside";

      const request: BrowserAgentRunRequest = {
        url: agent.url,
        goal: agent.goal,
        model_id: isPoolsideModel ? shortId : modelId,
        model_provider: provider,
        max_steps: agent.max_steps || 30,
        use_vision: agent.use_vision && !isPoolsideModel,
        keep_alive: false,
        ...(byokKey ? { poolside_api_key: byokKey } : {}),
      };

      const startResult = await startBrowserAgentRun(request);
      if (!startResult?.run_id) {
        failedRuns++;
        return;
      }

      const result = await waitForBrowserAgentRun(startResult.run_id);
      if (result.success) completedRuns++;
      else failedRuns++;
    } catch {
      failedRuns++;
    }
  }

  const running: Promise<void>[] = [];
  for (const agent of agents) {
    const promise = runOne(agent).finally(() => {
      const idx = running.indexOf(promise);
      if (idx >= 0) running.splice(idx, 1);
    });
    running.push(promise);
    if (running.length >= parallelLimit) {
      await Promise.race(running);
    }
  }

  await Promise.allSettled(running);

  const batchStatus = failedRuns > 0 && completedRuns > 0
    ? "partial_failure"
    : failedRuns > 0
      ? "failed"
      : "completed";

  await db
    .update(agenticBatchesTable)
    .set({ status: batchStatus, completedRuns, failedRuns, completedAt: new Date() })
    .where(eq(agenticBatchesTable.id, batch.id));

  logger.info(
    { batchId: batch.id, completedRuns, failedRuns, totalRuns: agents.length },
    "Batch run finished",
  );
}

router.post("/run/parallel", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { agents, parallel_limit } = req.body ?? {};

  if (!agents || !Array.isArray(agents) || agents.length === 0) {
    res.status(400).json({ error: "invalid_request", message: "agents array is required with at least 1 agent" });
    return;
  }

  for (const agent of agents) {
    if (!agent.url || !agent.goal) {
      res.status(400).json({ error: "invalid_request", message: "Each agent must have url and goal" });
      return;
    }
  }

  const parallelLimit = Math.max(1, Math.min(parallel_limit ?? 3, 20));
  const user = (await getOrCreateUser(authUser))!;

  const [batch] = await db
    .insert(agenticBatchesTable)
    .values({ userId: user.id, parallelLimit, status: "queued", totalRuns: agents.length })
    .returning();

  const runIds: string[] = [];
  for (const agent of agents) {
    const { provider } = parseModelRef(agent.model_id || "poolside/laguna-xs-2.1");
    const [run] = await db
      .insert(agenticRunsTable)
      .values({ userId: user.id, url: agent.url, goal: agent.goal, status: "queued", batchId: batch.id, modelUsed: provider })
      .returning();
    runIds.push(run.id);
  }

  await db.update(agenticBatchesTable).set({ status: "running" }).where(eq(agenticBatchesTable.id, batch.id));

  runBatchAgents(agents, batch, user, parallelLimit).catch((err) => {
    logger.error({ err, batchId: batch.id }, "Batch execution failed");
  });

  res.status(200).json({ batch_id: batch.id, run_ids: runIds });
});

router.get("/run/batch/:batchId/status", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const batchId = req.params.batchId as string;

  const user = (await getOrCreateUser(authUser))!;

  const [batch] = await db
    .select()
    .from(agenticBatchesTable)
    .where(eq(agenticBatchesTable.id, batchId))
    .limit(1);

  if (!batch) {
    res.status(404).json({ error: "batch_not_found", message: "Batch not found" });
    return;
  }

  if (batch.userId !== user.id) {
    res.status(404).json({ error: "batch_not_found", message: "Batch not found" });
    return;
  }

  const runs = await db
    .select()
    .from(agenticRunsTable)
    .where(eq(agenticRunsTable.batchId, batchId))
    .orderBy(agenticRunsTable.createdAt)
    .limit(500);

  res.status(200).json({
    batch_id: batch.id,
    status: batch.status,
    parallel_limit: batch.parallelLimit,
    total: batch.totalRuns,
    completed: batch.completedRuns,
    failed: batch.failedRuns,
    runs: runs.map((r) => ({
      id: r.id,
      url: r.url,
      goal: r.goal,
      status: r.status,
      success: r.success,
      error: r.error,
      createdAt: r.createdAt,
    })),
  });
});

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

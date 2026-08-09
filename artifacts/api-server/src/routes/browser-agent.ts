import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { agenticRunsTable, agenticBatchesTable, codeRunsTable, generatedTestScriptsTable, userApiKeysTable } from "@workspace/db/schema";
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
  getBrowserAgentRunSteps,
  proxyBrowserAgentVideo,
  type BrowserAgentRunRequest,
} from "../lib/browser-use-client";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";
import { generatePlaywrightScript, type GeneratedTraceStep } from "../lib/playwright-script";
import { browserGenerateStagehandScript } from "../lib/browser-trace-adapter";
import { finalizePlaywrightScript, finalizePlaywrightScriptStream } from "../lib/script-finalize";
import { getCodeRun, isWorkerAvailable, startCodeRun, stopCodeRun } from "../lib/code-runner";
import { repairPlaywrightScript } from "../lib/script-repair";
import { refineLocatorsWithStagehand } from "../lib/stagehand-client";

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
  const requestedProvider = typeof req.body?.model_provider === "string"
    ? req.body.model_provider.toLowerCase()
    : null;
  const isPoolsideModel = requestedProvider === "poolside"
    || (!requestedProvider && typeof modelId === "string" && modelId.startsWith("poolside/"));
  const effectiveUseVision = use_vision && !isPoolsideModel;

  const modelProvider = requestedProvider
    || (typeof modelId === "string" && modelId.includes("/") ? modelId.split("/")[0].toLowerCase() : "poolside");

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
    ...(byokKey && modelProvider === "poolside" ? { poolside_api_key: byokKey } : {}),
    ...(byokKey && modelProvider === "opencode" ? { opencode_api_key: byokKey } : {}),
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

  const result = await startBrowserAgentRun(runRequest, res, {
    onTrace: async (actionTrace) => {
      await db
        .update(agenticRunsTable)
        .set({
          metadata: {
            ...(run.metadata && typeof run.metadata === "object" ? run.metadata as Record<string, unknown> : {}),
            traceVersion: 1,
            actionTrace,
          },
        })
        .where(eq(agenticRunsTable.id, run.id));
    },
  });

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
        videoUrl: result.videoPath ? `/api/browser-agent/run/${run.id}/video` : null,
        metadata: {
          ...(run.metadata && typeof run.metadata === "object" ? run.metadata as Record<string, unknown> : {}),
          traceVersion: 1,
          actionTrace: result.actionTrace,
        },
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

router.get("/run/:id/video", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const runId = req.params.id as string;
  const user = (await getOrCreateUser(authUser))!;
  const [run] = await db
    .select()
    .from(agenticRunsTable)
    .where(and(eq(agenticRunsTable.id, runId), eq(agenticRunsTable.userId, user.id)))
    .limit(1);

  if (!run || !run.pythonRunId || !run.videoUrl) {
    res.status(404).json({ error: "video_not_found" });
    return;
  }

  const status = await proxyBrowserAgentVideo(run.pythonRunId, res);
  if (status === 404) {
    res.status(404).json({ error: "video_not_found" });
  } else if (status >= 400 && !res.writableEnded) {
    res.status(502).json({ error: "video_unavailable" });
  }
});

router.post("/runs/:id/generate-code", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const runId = req.params.id as string;
  const user = (await getOrCreateUser(authUser))!;
  const [run] = await db
    .select()
    .from(agenticRunsTable)
    .where(and(eq(agenticRunsTable.id, runId), eq(agenticRunsTable.userId, user.id)))
    .limit(1);

  if (!run) {
    res.status(404).json({ error: "run_not_found" });
    return;
  }

  const metadata = run.metadata && typeof run.metadata === "object"
    ? run.metadata as Record<string, unknown>
    : {};
  const actionTrace = Array.isArray(metadata.actionTrace)
    ? metadata.actionTrace as GeneratedTraceStep[]
    : [];

  if (actionTrace.length === 0 && run.pythonRunId) {
    const steps = await getBrowserAgentRunSteps(run.pythonRunId);
    const recoveredTrace = steps.flatMap((step) => {
      const actions: unknown[] = Array.isArray(step.action_trace)
        ? step.action_trace as unknown[]
        : step.model_output && typeof step.model_output === "object"
          && Array.isArray((step.model_output as Record<string, unknown>).actions)
          ? ((step.model_output as Record<string, unknown>).actions as Array<Record<string, unknown>>).map((action) => ({
              action: typeof action.action === "string" ? action.action : action.name,
              raw: action.raw ?? action,
              element: action.element ?? null,
            }))
          : [];
      if (actions.length === 0) return [];
      return [{
        stepNumber: typeof step.step_number === "number" ? step.step_number : 0,
        url: typeof step.url === "string" ? step.url : null,
        title: typeof step.title === "string" ? step.title : null,
        actions,
      }] as GeneratedTraceStep[];
    });
    if (recoveredTrace.length > 0) {
      actionTrace.push(...recoveredTrace);
      await db.update(agenticRunsTable).set({
        metadata: { ...metadata, traceVersion: 1, actionTrace },
      }).where(eq(agenticRunsTable.id, run.id));
    }
  }

  const traceDiagnostics = {
    source: actionTrace.length > 0
      ? (Array.isArray(metadata.actionTrace) && metadata.actionTrace.length > 0 ? "database" : "python_steps")
      : "none",
    stepCount: actionTrace.length,
    actionCount: actionTrace.reduce((count, step) => count + step.actions.length, 0),
    pythonRunId: run.pythonRunId,
  };
  logger.info({ runId: run.id, ...traceDiagnostics }, "Preparing Playwright code from browser trace");

  const mode = typeof req.query?.mode === "string" ? req.query.mode : "deterministic";
  let generated = browserGenerateStagehandScript(run.url, run.goal, actionTrace);
  let explanation = "";
  if (actionTrace.length === 0) {
    generated.warnings.unshift("No browser action trace was available. This is a starter scaffold based on the run URL and goal. Check that the API server was restarted after the latest build and that the browser-use service stayed running for the completed run.");
  }
  if (mode === "llm") {
    try {
      const provider = run.modelUsed || "opencode";
      const [keyRow] = await db.select().from(userApiKeysTable).where(and(eq(userApiKeysTable.userId, user.id), eq(userApiKeysTable.provider, provider))).limit(1);
      const apiKey = keyRow
        ? decryptKey(JSON.parse(keyRow.encryptedKey))
        : provider === "opencode"
          ? process.env.OPENCODE_API_KEY || ""
          : "";
      const lastUrl = [...actionTrace].reverse().find((step) => step.url)?.url ?? undefined;
      const finalized = await finalizePlaywrightScript({
        url: run.url,
        goal: run.goal,
        trace: actionTrace,
        draftCode: generated.code,
        finalUrl: lastUrl,
        provider,
        apiKey,
      });
      explanation = finalized.explanation;
      generated = { code: finalized.code, warnings: [...finalized.warnings, ...generated.warnings] };
      generated.warnings.unshift("Refined with a language model.");
    } catch (finalizeError) {
      logger.warn({ finalizeError, runId: run.id }, "Model-assisted finalization failed; using deterministic draft");
      generated.warnings.unshift("Model-assisted finalization was unavailable; used the deterministic draft.");
    }
  }
  let scriptId: string | null = null;
  let scriptVersion = 0;
  try {
    const [script] = await db
      .insert(generatedTestScriptsTable)
      .values({
        userId: user.id,
        sourceRunId: run.id,
        version: 1,
        code: generated.code,
        description: run.goal,
        warnings: generated.warnings,
      })
      .returning();
    scriptId = script?.id ?? null;
    scriptVersion = script?.version ?? 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("generated_test_scripts")) throw error;
    generated.warnings.unshift("Script persistence is unavailable until the generated_test_scripts database migration is applied.");
    logger.error({ error, runId: run.id }, "Generated code could not be persisted");
  }
  const updatedMetadata = {
    ...metadata,
    generatedPlaywrightCode: generated.code,
    generatedPlaywrightWarnings: generated.warnings,
    generatedPlaywrightExplanation: explanation || undefined,
    generatedAt: new Date().toISOString(),
  };

  await db
    .update(agenticRunsTable)
    .set({ metadata: updatedMetadata })
    .where(eq(agenticRunsTable.id, run.id));

  res.json({
    scriptId,
    version: scriptVersion,
    runId: run.id,
    language: "typescript",
    framework: "playwright",
    mode,
    code: generated.code,
    warnings: generated.warnings,
    explanation: explanation || undefined,
    traceDiagnostics,
  });
});

router.post("/runs/:id/generate-code-llm", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const [run] = await db
    .select()
    .from(agenticRunsTable)
    .where(and(eq(agenticRunsTable.id, req.params.id as string), eq(agenticRunsTable.userId, user.id)))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "run_not_found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: unknown): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata as Record<string, unknown> : {};
  const actionTrace = Array.isArray(metadata.actionTrace)
    ? metadata.actionTrace as GeneratedTraceStep[]
    : [];
  const draft = browserGenerateStagehandScript(run.url, run.goal, actionTrace);

  try {
    const provider = run.modelUsed || "opencode";
    const [keyRow] = await db.select().from(userApiKeysTable).where(and(eq(userApiKeysTable.userId, user.id), eq(userApiKeysTable.provider, provider))).limit(1);
    const apiKey = keyRow
      ? decryptKey(JSON.parse(keyRow.encryptedKey))
      : provider === "opencode"
        ? process.env.OPENCODE_API_KEY || ""
        : "";
    const lastUrl = [...actionTrace].reverse().find((step) => step.url)?.url ?? undefined;

    let code = draft.code;
    let warnings = [...actionTrace.length === 0 ? ["No browser action trace was available. This is a starter scaffold based on the run URL and goal."] : [], ...draft.warnings];
    let explanation = "";

    for await (const event of finalizePlaywrightScriptStream({
      url: run.url,
      goal: run.goal,
      trace: actionTrace,
      draftCode: draft.code,
      finalUrl: lastUrl,
      provider,
      apiKey,
    })) {
      if (event.type === "draft") {
        send({ type: "draft", message: "Generated deterministic draft from the recorded action trace." });
      } else if (event.type === "draft.ready") {
        send({ type: "draft", message: `Draft ready (${event.chars} chars). Asking model to polish…` });
      } else if (event.type === "calling") {
        send({ type: "calling", provider: event.provider, model: event.model, message: `Calling ${event.provider}/${event.model} to finalize the Playwright script…` });
      } else if (event.type === "token") {
        send({ type: "token", delta: event.delta });
      } else if (event.type === "complete") {
        send({ type: "polished", message: "Model finished. Polished result accepted." });
        code = event.result.code;
        explanation = event.result.explanation;
        warnings = [...event.result.warnings, ...draft.warnings];
        warnings.unshift("Refined with a language model.");
      } else if (event.type === "error") {
        send({ type: "error", message: `Model call failed (${event.message}); using the deterministic draft.` });
        warnings.unshift("Model-assisted finalization failed; used the deterministic draft.");
      }
    }

    let scriptId: string | null = null;
    let scriptVersion = 0;
    try {
      const [script] = await db
        .insert(generatedTestScriptsTable)
        .values({
          userId: user.id,
          sourceRunId: run.id,
          version: 1,
          code,
          description: run.goal,
          warnings,
        })
        .returning();
      scriptId = script?.id ?? null;
      scriptVersion = script?.version ?? 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("generated_test_scripts")) throw error;
      warnings.unshift("Script persistence is unavailable until the generated_test_scripts database migration is applied.");
    }

    await db
      .update(agenticRunsTable)
      .set({
        metadata: {
          ...metadata,
          generatedPlaywrightCode: code,
          generatedPlaywrightWarnings: warnings,
          generatedPlaywrightExplanation: explanation || undefined,
          generatedAt: new Date().toISOString(),
        },
      })
      .where(eq(agenticRunsTable.id, run.id));

    send({ type: "complete", code, warnings, explanation: explanation || undefined, scriptId, version: scriptVersion, mode: "llm" });
  } catch (error) {
    logger.error({ error, runId: run.id }, "Failed to finalize code via streaming route");
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
});

router.get("/scripts/:id", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const [script] = await db
    .select()
    .from(generatedTestScriptsTable)
    .where(and(eq(generatedTestScriptsTable.id, req.params.id as string), eq(generatedTestScriptsTable.userId, user.id)))
    .orderBy(desc(generatedTestScriptsTable.version))
    .limit(1);
  if (!script) {
    res.status(404).json({ error: "script_not_found" });
    return;
  }
  res.json(script);
});

router.put("/scripts/:id", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const [current] = await db
    .select()
    .from(generatedTestScriptsTable)
    .where(and(eq(generatedTestScriptsTable.id, req.params.id as string), eq(generatedTestScriptsTable.userId, user.id)))
    .orderBy(desc(generatedTestScriptsTable.version))
    .limit(1);
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!current || !code || code.length > 250_000) {
    res.status(400).json({ error: "invalid_script" });
    return;
  }
  const [saved] = await db
    .insert(generatedTestScriptsTable)
    .values({
      userId: user.id,
      sourceRunId: current.sourceRunId,
      version: current.version + 1,
      name: req.body.name || current.name,
      code,
      description: current.description,
      warnings: current.warnings,
    })
    .returning();
  res.json(saved);
});

router.post("/scripts/:id/repair", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const [script] = await db
    .select()
    .from(generatedTestScriptsTable)
    .where(and(eq(generatedTestScriptsTable.id, req.params.id as string), eq(generatedTestScriptsTable.userId, user.id)))
    .orderBy(desc(generatedTestScriptsTable.version))
    .limit(1);
  if (!script) {
    res.status(404).json({ error: "script_not_found" });
    return;
  }
  const [run] = await db.select().from(agenticRunsTable).where(eq(agenticRunsTable.id, script.sourceRunId)).limit(1);
  const metadata = run?.metadata && typeof run.metadata === "object" ? run.metadata as Record<string, unknown> : {};
  const trace = Array.isArray(metadata.actionTrace) ? metadata.actionTrace as GeneratedTraceStep[] : [];
  if (!run || trace.length === 0) {
    res.status(422).json({ error: "trace_unavailable" });
    return;
  }
  let generated = browserGenerateStagehandScript(run.url, run.goal, trace);
  let explanation = "Regenerated from the source trace.";
  const error = typeof req.body?.error === "string" ? req.body.error : "";
  try {
    const provider = run.modelUsed || "opencode";
    const [keyRow] = await db.select().from(userApiKeysTable).where(and(eq(userApiKeysTable.userId, user.id), eq(userApiKeysTable.provider, provider))).limit(1);
    if (keyRow) {
      const repaired = await repairPlaywrightScript({
        code: script.code,
        error,
        trace,
        provider,
        apiKey: decryptKey(JSON.parse(keyRow.encryptedKey)),
      });
      generated = { code: repaired.code, warnings: repaired.warnings };
      explanation = repaired.explanation;
    }
  } catch (repairError) {
    logger.warn({ repairError, scriptId: script.id }, "Model-assisted repair failed; using deterministic regeneration");
    generated.warnings.unshift("Model-assisted repair was unavailable; regenerated from the original trace.");
  }
  generated.warnings.unshift(error ? `Repair input: ${error.slice(0, 300)}` : explanation);
  const [repaired] = await db.insert(generatedTestScriptsTable).values({
    userId: user.id,
    sourceRunId: script.sourceRunId,
    version: script.version + 1,
    name: script.name,
    code: generated.code,
    description: script.description,
    warnings: generated.warnings,
  }).returning();
  res.json({ ...repaired, explanation });
});

router.post("/scripts/:id/run", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const [script] = await db
    .select()
    .from(generatedTestScriptsTable)
    .where(and(eq(generatedTestScriptsTable.id, req.params.id as string), eq(generatedTestScriptsTable.userId, user.id)))
    .orderBy(desc(generatedTestScriptsTable.version))
    .limit(1);
  if (!script) {
    res.status(404).json({ error: "script_not_found" });
    return;
  }
  if (!isWorkerAvailable()) {
    res.status(503).json({ error: "worker_unavailable", message: "Build the API server before starting code execution." });
    return;
  }
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  if (!url) {
    res.status(400).json({ error: "url_required" });
    return;
  }
  const codeRunId = randomUUID();
  await db.insert(codeRunsTable).values({
    id: codeRunId,
    userId: user.id,
    scriptId: script.id,
    status: "queued",
    events: [],
  });
  startCodeRun({ id: codeRunId, code: script.code, url, userId: user.id });
  res.status(202).json({ codeRunId, scriptId: script.id, version: script.version });
});

router.post("/scripts/:id/refine-locators", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const [script] = await db.select().from(generatedTestScriptsTable)
    .where(and(eq(generatedTestScriptsTable.id, req.params.id as string), eq(generatedTestScriptsTable.userId, user.id)))
    .orderBy(desc(generatedTestScriptsTable.version)).limit(1);
  if (!script) {
    res.status(404).json({ error: "script_not_found" });
    return;
  }
  const [run] = await db.select().from(agenticRunsTable).where(eq(agenticRunsTable.id, script.sourceRunId)).limit(1);
  const provider = run?.modelUsed || "opencode";
  const [keyRow] = await db.select().from(userApiKeysTable)
    .where(and(eq(userApiKeysTable.userId, user.id), eq(userApiKeysTable.provider, provider))).limit(1);
  if (!run || !keyRow) {
    res.status(422).json({ error: "provider_key_unavailable" });
    return;
  }
  const instruction = typeof req.body?.instruction === "string" && req.body.instruction.trim()
    ? req.body.instruction
    : "Find the most reliable Playwright locator and action for the target described by the original workflow.";
  try {
    const locators = await refineLocatorsWithStagehand(run.url, instruction, {
      provider,
      modelId: provider === "opencode" ? "big-pickle" : run.modelUsed || "gpt-4o-mini",
      apiKey: decryptKey(JSON.parse(keyRow.encryptedKey)),
    });
    res.json({ scriptId: script.id, locators });
  } catch (error) {
    logger.warn({ error, scriptId: script.id }, "Stagehand locator refinement failed");
    res.status(502).json({ error: "locator_refinement_failed" });
  }
});

router.get("/code-runs/:id", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const [run] = await db.select().from(codeRunsTable).where(and(eq(codeRunsTable.id, req.params.id as string), eq(codeRunsTable.userId, user.id))).limit(1);
  if (!run) {
    res.status(404).json({ error: "code_run_not_found" });
    return;
  }
  res.json(run);
});

router.get("/code-runs/:id/events", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const run = getCodeRun(req.params.id as string);
  if (!run || run.userId !== user.id) {
    res.status(404).json({ error: "code_run_not_found" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (["completed", "failed", "stopped"].includes(run.status)) {
    res.end();
    return;
  }
  const onEvent = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const persistEvents = async () => {
    const completedEvent = [...run.events].reverse().find((event) => event.event === "code_run_completed");
    const status = run.status;
    await db.update(codeRunsTable).set({
      status,
      events: run.events,
      error: completedEvent && typeof completedEvent.error === "string" ? completedEvent.error : null,
      completedAt: ["completed", "failed", "stopped"].includes(status) ? new Date() : undefined,
    }).where(eq(codeRunsTable.id, run.id));
  };
  const onPersistedEvent = (event: unknown) => {
    onEvent(event);
    void persistEvents();
  };
  run.emitter.on("event", onPersistedEvent);
  req.on("close", () => run.emitter.off("event", onPersistedEvent));
});

router.post("/code-runs/:id/stop", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const run = getCodeRun(req.params.id as string);
  if (!run || run.userId !== user.id) {
    res.status(404).json({ error: "code_run_not_found" });
    return;
  }
  await db.update(codeRunsTable).set({ status: "stopped", completedAt: new Date() }).where(eq(codeRunsTable.id, run.id));
  res.json({ stopped: stopCodeRun(run.id) });
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

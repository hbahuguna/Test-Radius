import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { agenticRunsTable, generatedTestScriptsTable, userApiKeysTable } from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser } from "../lib/auth";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";
import { createStagehand, collectMetrics } from "../lib/stagehand-client";
import { generateStagehandPlaywrightScript, type StagehandRecordedAction, type StagehandTraceStep } from "../lib/stagehand-playwright";

const router: IRouter = Router();
router.use(requireSignedUp);

function providerKey(provider: string): string | undefined {
  const envNames: Record<string, string> = {
    opencode: "OPENCODE_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    poolside: "POOLSIDE_API_KEY",
  };
  const name = envNames[provider];
  return name ? process.env[name] : undefined;
}

async function resolveConfig(userId: string, provider: string, modelId: string) {
  const [keyRow] = await db
    .select()
    .from(userApiKeysTable)
    .where(and(eq(userApiKeysTable.userId, userId), eq(userApiKeysTable.provider, provider)))
    .limit(1);
  const apiKey = keyRow ? decryptKey(JSON.parse(keyRow.encryptedKey)) : providerKey(provider);
  if (!apiKey) throw new Error(`No API key configured for Stagehand provider ${provider}.`);
  return { provider, modelId, apiKey };
}

function normalizeTrace(actions: StagehandRecordedAction[], url: string): StagehandTraceStep[] {
  const actionable = actions.filter((action) => {
    const type = String(action.type ?? "").toLowerCase();
    if (["ariatree", "screenshot"].includes(type)) return false;
    if (type === "extract" && action.success === false) return false;
    return ["act", "keys", "wait", "goto", "navigate", "scroll", "type", "input", "fill"].includes(type);
  });
  return [{ stepNumber: 1, url, actions: actionable }];
}

function writeEvent(res: Response, event: Record<string, unknown>): void {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function runObservedActions(
  stagehand: Awaited<ReturnType<typeof createStagehand>>,
  page: any,
  goal: string,
  maxSteps: number,
  res: Response,
): Promise<{ success: boolean; message: string; completed: boolean; actions: StagehandRecordedAction[] }> {
  const actions: StagehandRecordedAction[] = [];
  for (let index = 0; index < maxSteps; index++) {
    const observed = await stagehand.observe(goal, { page, timeout: 45_000 });
    const action = observed?.[0];
    if (!action) break;
    await stagehand.act(action, { page, timeout: 45_000 });
    actions.push({
      type: "act",
      action: action.method ?? "act",
      description: action.description,
      selector: action.selector,
      arguments: action.arguments,
      pageUrl: page.url(),
    });
    const screenshot = await page.screenshot({ type: "jpeg", quality: 65 }).catch(() => null);
    writeEvent(res, {
      event: "step",
      stepNumber: index + 1,
      url: page.url(),
      title: await page.title().catch(() => null),
      screenshot: screenshot ? `data:image/jpeg;base64,${screenshot.toString("base64")}` : null,
      actions: [{ name: action.method ?? "act", input: action.description }],
      text: action.description,
    });
    if (String(action.description).toLowerCase().includes("done")) break;
  }
  return {
    success: actions.length > 0,
    message: actions.length > 0 ? "Completed using Stagehand observe/act actions." : "Stagehand did not find an actionable element.",
    completed: actions.length > 0,
    actions,
  };
}

async function validateCompletion(page: any, goal: string, result: any): Promise<{ valid: boolean; reason: string | null; evidence: string }> {
  if (!result?.success) return { valid: false, reason: result?.message || "Stagehand did not complete the task.", evidence: "" };
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const combined = `${result.message || ""}\n${bodyText}`;
  const needsPriceEvidence = /\b(cheapest|lowest price|lowest fare|best price|flight|fare|ticket)\b/i.test(goal);
  if (needsPriceEvidence) {
    const hasPrice = /(?:[$€£₹]|\b(?:INR|USD|EUR|GBP)\b)\s?\d[\d,.]*|\d[\d,.]*\s?(?:[$€£₹]|INR|USD|EUR|GBP)\b/i.test(combined);
    if (!hasPrice) {
      return {
        valid: false,
        reason: "Stagehand reported completion, but no flight price or fare was found in the result or page content.",
        evidence: bodyText.slice(0, 2000),
      };
    }
  }
  return { valid: true, reason: null, evidence: bodyText.slice(0, 2000) };
}

router.post("/run", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { url, goal, model_provider = "opencode", model_id = "big-pickle", max_steps = 10 } = req.body ?? {};
  if (typeof url !== "string" || typeof goal !== "string" || !url || !goal) {
    res.status(400).json({ error: "invalid_request", message: "url and goal are required" });
    return;
  }

  const user = (await getOrCreateUser(authUser))!;
  const provider = String(model_provider).toLowerCase();
  const modelId = String(model_id);
  const boundedSteps = Math.max(1, Math.min(Number(max_steps) || 10, 30));
  const [run] = await db.insert(agenticRunsTable).values({
    userId: user.id,
    url,
    goal,
    status: "running",
    modelUsed: `${provider}/${modelId}`,
    metadata: { engine: "stagehand", traceVersion: 1 },
  }).returning();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  writeEvent(res, { event: "started", runId: run.id, url, goal });

  let stagehand: Awaited<ReturnType<typeof createStagehand>> | undefined;
  let screenshotTimer: ReturnType<typeof setInterval> | null = null;
  try {
    const config = await resolveConfig(user.id, provider, modelId);
    // Do not reuse agent cache entries during live evaluation; a cached done
    // result can claim success without reproducing the browser actions.
    stagehand = await createStagehand(config);
    const page = stagehand.context.pages()[0];
    await page.goto(url);
    const initialScreenshot = await page.screenshot({ type: "jpeg", quality: 65 }).catch(() => null);
    writeEvent(res, {
      event: "loading",
      url: page.url(),
      title: await page.title().catch(() => null),
      screenshot: initialScreenshot ? `data:image/jpeg;base64,${initialScreenshot.toString("base64")}` : null,
    });
    screenshotTimer = setInterval(async () => {
      const screenshot = await page.screenshot({ type: "jpeg", quality: 65 }).catch(() => null);
      if (screenshot) {
        writeEvent(res, {
          event: "step",
          stepNumber: 0,
          url: page.url(),
          title: await page.title().catch(() => null),
          screenshot: `data:image/jpeg;base64,${screenshot.toString("base64")}`,
          actions: [],
          text: "Stagehand is working…",
        });
      }
    }, 1000);
    let result: any;
    try {
      result = await stagehand.agent().execute({ instruction: goal, page, maxSteps: boundedSteps, toolTimeout: 45_000 });
    } catch (error) {
      if (!/(Invalid time value|action format|tool_choice|technical difficulties)/i.test(String(error))) throw error;
      result = await runObservedActions(stagehand, page, goal, boundedSteps, res);
    }
    clearInterval(screenshotTimer);
    screenshotTimer = null;
    if (!result.success && /(Invalid time value|action format|tool_choice|technical difficulties)/i.test(String(result.message))) {
      result = await runObservedActions(stagehand, page, goal, boundedSteps, res);
    }
    const validation = await validateCompletion(page, goal, result);
    if (!validation.valid) {
      result = {
        ...result,
        success: false,
        completed: false,
        message: validation.reason,
      };
    }
    const actions = Array.isArray(result.actions) ? result.actions as StagehandRecordedAction[] : [];
    const trace = normalizeTrace(actions, url);
    const generated = generateStagehandPlaywrightScript(url, goal, trace);
    const metadata = {
      engine: "stagehand",
      traceVersion: 1,
      stagehandTrace: trace,
      stagehandResult: { success: result.success, message: result.message, completed: result.completed },
      completionValidation: validation,
      metrics: await collectMetrics(stagehand),
      generatedPlaywrightCode: generated.code,
      generatedPlaywrightWarnings: generated.warnings,
    };
    await db.update(agenticRunsTable).set({
      status: result.success ? "completed" : "failed",
      success: result.success,
      error: result.success ? null : result.message,
      stepCount: actions.length,
      metadata,
      completedAt: new Date(),
    }).where(eq(agenticRunsTable.id, run.id));
    writeEvent(res, { event: "done", runId: run.id, status: result.success ? "completed" : "failed", result, trace, code: generated.code, warnings: generated.warnings, completionValidation: validation, metrics: metadata.metrics });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, runId: run.id }, "Stagehand agent run failed");
    await db.update(agenticRunsTable).set({ status: "failed", success: false, error: message, completedAt: new Date() }).where(eq(agenticRunsTable.id, run.id));
    writeEvent(res, { event: "error", error: "stagehand_run_failed", runId: run.id, message });
  } finally {
    if (screenshotTimer) clearInterval(screenshotTimer);
    await stagehand?.close();
    if (!res.writableEnded) res.end();
  }
});

router.post("/runs/:id/generate-code", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const [run] = await db.select().from(agenticRunsTable).where(and(eq(agenticRunsTable.id, req.params.id as string), eq(agenticRunsTable.userId, user.id))).limit(1);
  if (!run) {
    res.status(404).json({ error: "run_not_found" });
    return;
  }
  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata as Record<string, unknown> : {};
  const trace = Array.isArray(metadata.stagehandTrace) ? metadata.stagehandTrace as StagehandTraceStep[] : [];
  if (trace.length === 0) {
    res.status(409).json({ error: "trace_unavailable", message: "No Stagehand action trace was recorded for this run." });
    return;
  }
  const generated = generateStagehandPlaywrightScript(run.url, run.goal, trace);
  const [script] = await db.insert(generatedTestScriptsTable).values({
    userId: user.id,
    sourceRunId: run.id,
    version: 1,
    code: generated.code,
    description: run.goal,
    warnings: generated.warnings,
  }).returning();
  await db.update(agenticRunsTable).set({ metadata: { ...metadata, generatedPlaywrightCode: generated.code, generatedPlaywrightWarnings: generated.warnings } }).where(eq(agenticRunsTable.id, run.id));
  res.json({ scriptId: script.id, version: script.version, runId: run.id, language: "typescript", framework: "playwright", code: generated.code, warnings: generated.warnings });
});

router.get("/runs", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const runs = await db.select().from(agenticRunsTable).where(eq(agenticRunsTable.userId, user.id)).orderBy(desc(agenticRunsTable.createdAt)).limit(50);
  res.json({ runs: runs.filter((run) => (run.metadata as Record<string, unknown> | null)?.engine === "stagehand") });
});

export default router;

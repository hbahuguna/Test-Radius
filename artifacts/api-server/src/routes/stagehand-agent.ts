import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { agenticRunsTable, codeRunsTable, generatedTestScriptsTable, userApiKeysTable } from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser } from "../lib/auth";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";
import { createStagehand, collectMetrics, refineLocatorsWithStagehand, detectProviderCompatibilityIssue } from "../lib/stagehand-client";
import { generateStagehandPlaywrightScript, type StagehandRecordedAction, type StagehandTraceStep } from "../lib/stagehand-playwright";
import { isWorkerAvailable, startCodeRun, stopCodeRun, getCodeRun } from "../lib/code-runner";
import { repairPlaywrightScript } from "../lib/script-repair";
import type { GeneratedTraceStep } from "../lib/playwright-script";

const router: IRouter = Router();
router.use(requireSignedUp);

function providerKey(provider: string): string | undefined {
  const envNames: Record<string, string> = {
    opencode: "OPENCODE_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    poolside: "POOLSIDE_API_KEY",
    google: "GEMINI_API_KEY",
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

function writeEvent(res: Response, event: Record<string, unknown>): void {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ============================================================
// Agent accumulator: shared trace + live progress across execute and
// observe/act fallback paths so both yield the same normalized trace.
// ============================================================

interface Accumulator {
  actions: StagehandRecordedAction[];
  stepNumber: number;
  url: string;
  finalMessage: string;
  output: Record<string, unknown> | null;
}

function createAccumulator(initialUrl: string): Accumulator {
  return { actions: [], stepNumber: 0, url: initialUrl, finalMessage: "", output: null };
}

function liveEvidenceHandler(
  acc: Accumulator,
  res: Response,
  page: any,
): (event: unknown) => Promise<void> {
  return async (raw) => {
    try {
      const event = raw as {
        type?: string;
        actionName?: string;
        actionArgs?: Record<string, unknown>;
        reasoning?: string;
        url?: string;
        screenshot?: Buffer;
        message?: string;
        output?: Record<string, unknown>;
      };

      if (event.type === "screenshot" && event.screenshot) {
        writeEvent(res, {
          event: "step",
          stepNumber: 0,
          url: event.url ?? page.url(),
          title: await page.title().catch(() => null),
          screenshot: `data:image/png;base64,${event.screenshot.toString("base64")}`,
          actions: [],
          text: "Stagehand is working…",
        });
        return;
      }

      if (event.type === "step_observed" && typeof event.url === "string") {
        acc.url = event.url;
        return;
      }

      if (event.type === "step_finished" && typeof event.actionName === "string") {
        acc.stepNumber += 1;
        const args = event.actionArgs ?? {};
        const action: StagehandRecordedAction = {
          type: event.actionName,
          action: event.actionName,
          description: typeof args.description === "string" ? args.description : undefined,
          reasoning: event.reasoning || undefined,
          actionArgs: args,
          pageUrl: acc.url,
          success: true,
        };
        if (typeof args.selector === "string") action.selector = args.selector;
        if (typeof args.value === "string") action.value = args.value;
        if (typeof args.key === "string" && (event.actionName === "keys" || event.actionName === "press")) action.key = args.key;
        if (typeof args.url === "string") action.url = args.url;
        acc.actions.push(action);

        const label = String(
          (event.actionArgs as { description?: string })?.description ??
          event.reasoning ??
          event.actionName,
        );
        writeEvent(res, {
          event: "step",
          stepNumber: acc.stepNumber,
          url: acc.url,
          title: await page.title().catch(() => null),
          actions: [{ name: event.actionName, input: label }],
          text: event.reasoning ?? label,
        });
        return;
      }

      if (event.type === "final_answer") {
        acc.finalMessage = event.message ?? acc.finalMessage;
        if (event.output) acc.output = event.output;
      }
    } catch (error) {
      logger.warn({ error }, "Stagehand evidence handler skipped an event");
    }
  };
}

// observe/act fallback: no model-level actions; drive the page directly.
async function runObservedActions(
  stagehand: Awaited<ReturnType<typeof createStagehand>>,
  page: any,
  goal: string,
  maxSteps: number,
  res: Response,
  acc: Accumulator,
): Promise<{ success: boolean; message: string }> {
  for (let index = 0; index < maxSteps; index++) {
    const observed = await stagehand.observe(goal, { page, timeout: 45_000 });
    const action = observed?.[0];
    if (!action) break;
    await stagehand.act(action, { page, timeout: 45_000 });
    acc.actions.push({
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
    success: acc.actions.length > 0,
    message: acc.actions.length > 0
      ? "Completed using Stagehand observe/act actions."
      : "Stagehand did not find an actionable element.",
  };
}

// ============================================================
// Goal intent classification + completion validation
// ============================================================

type GoalIntent = "flight" | "purchase" | "search" | "extract" | "default";

function classifyGoal(goal: string): GoalIntent {
  const g = goal.toLowerCase();
  if (/(cheapest|lowest price|lowest fare|book .*flight|flight|fare|ticket|airline|departure|landing)/.test(g)) return "flight";
  if (/(purchase|buy|order|checkout|payment|cart|subscribe|sign up|booking.conf|reserve|pay for)/.test(g)) return "purchase";
  if (/(search|look for|compare|find .* results|browse)/.test(g)) return "search";
  if (/(extract|scrape|collect|list|gather|get the|retrieve)/.test(g)) return "extract";
  return "default";
}

function structuredOutputSchema(intent: GoalIntent): { schema?: z.ZodType; label?: string } {
  switch (intent) {
    case "flight":
      return {
        schema: z.object({
          price: z.string().nullish().describe("The best/cheapest flight price found, e.g. $199 or 199 USD"),
          airline: z.string().nullish().describe("The airline of the chosen flight"),
          route: z.string().nullish().describe("Origin to destination route, e.g. NYC to London"),
          departureTime: z.string().nullish().describe("Departure time of the chosen flight"),
        }),
        label: "flight",
      };
    case "purchase":
      return {
        schema: z.object({
          total: z.string().nullish().describe("The order total before confirmation"),
          item: z.string().nullish().describe("The purchased item or plan name"),
          confirmation: z.string().nullish().describe("Confirmation reference shown after purchase"),
        }),
        label: "purchase",
      };
    default:
      return {};
  }
}

function priceEvidencePresent(text: string): boolean {
  return /(?:[$€£₹]|\b(?:INR|USD|EUR|GBP|CAD|AUD)\b)\s?\d[\d,.]*|\d[\d,.]*\s?(?:[$€£₹]|INR|USD|EUR|GBP|CAD|AUD)\b/i.test(text);
}

async function validateCompletion(page: any, goal: string, result: any, url: string, output: Record<string, unknown> | null): Promise<{ valid: boolean; reason: string | null; evidence: string }> {
  if (!result?.success) {
    return { valid: false, reason: result?.message || "Stagehand did not complete the task.", evidence: "" };
  }
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const combined = `${result.message || ""}\n${bodyText}`;
  const intent = classifyGoal(goal);
  const currentUrl = page.url();

  switch (intent) {
    case "flight": {
      const hasPrices = priceEvidencePresent(combined);
      const hasOutputPrice = typeof output?.price === "string" && output.price.length > 0;
      if (!hasOutputPrice && !hasPrices) {
        return {
          valid: false,
          reason: "Stagehand reported completion, but no flight price or fare was found in the result, page content, or extracted output.",
          evidence: bodyText.slice(0, 2000),
        };
      }
      return { valid: true, reason: null, evidence: bodyText.slice(0, 2000) };
    }
    case "purchase": {
      const reachedCheckout = /(checkout|payment|booking-review|review|confirmation|thank-you|confirmed)/i.test(currentUrl)
        || /(checkout|payment|review your|place order|confirm|confirmation)/i.test(combined);
      if (!reachedCheckout) {
        return {
          valid: false,
          reason: "Purchase goal reported complete, but the run did not reach a checkout, review, or confirmation state.",
          evidence: `${currentUrl}\n\n${bodyText.slice(0, 1500)}`,
        };
      }
      return { valid: true, reason: null, evidence: bodyText.slice(0, 2000) };
    }
    case "search": {
      const meaningful = bodyText.replace(/\s+/g, " ").trim().length > 120;
      if (!meaningful) {
        return { valid: false, reason: "Search completed but the page returned no meaningful result content.", evidence: bodyText.slice(0, 1500) };
      }
      return { valid: true, reason: null, evidence: bodyText.slice(0, 2000) };
    }
    case "extract": {
      if (output && Object.keys(output).length > 0) {
        return { valid: true, reason: null, evidence: JSON.stringify(output).slice(0, 2000) };
      }
      return { valid: true, reason: null, evidence: bodyText.slice(0, 2000) };
    }
    default: {
      if (bodyText.replace(/\s+/g, "").length < 30) {
        return { valid: false, reason: "The page contained almost no content after the run; completion could not be verified.", evidence: bodyText.slice(0, 1500) };
      }
      return { valid: true, reason: null, evidence: bodyText.slice(0, 2000) };
    }
  }
}

// ============================================================
// Trace normalization + script persistence
// ============================================================

function normalizeTrace(actions: StagehandRecordedAction[], url: string): StagehandTraceStep[] {
  const actionable = actions.filter((action) => {
    const type = String(action.type ?? "").toLowerCase();
    if (["ariatree", "screenshot"].includes(type)) return false;
    if (type === "extract" && action.success === false) return false;
    return ["act", "keys", "wait", "goto", "navigate", "scroll", "type", "input", "fill", "click", "selectoption", "select", "check", "uncheck", "press", "hover", "focus"].includes(type);
  });
  return [{ stepNumber: 1, url, actions: actionable }];
}

function toGeneratedTrace(trace: StagehandTraceStep[]): GeneratedTraceStep[] {
  return trace.map((step) => ({
    stepNumber: step.stepNumber,
    url: step.url,
    title: null,
    actions: step.actions.map((a) => ({
      action: String(a.action ?? a.type ?? "act"),
      raw: a.actionArgs ?? a,
      element: a.selector ? { selector: a.selector } : null,
    })),
  }));
}

async function persistScript(userId: string, sourceRunId: string, code: string, warnings: string[], description: string): Promise<{ id: string | null; version: number }> {
  try {
    const [script] = await db.insert(generatedTestScriptsTable).values({
      userId,
      sourceRunId,
      version: 1,
      code,
      description,
      warnings,
    }).returning();
    return { id: script?.id ?? null, version: script?.version ?? 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("generated_test_scripts")) throw error;
    logger.error({ error, sourceRunId }, "Generated code could not be persisted");
    return { id: null, version: 0 };
  }
}

// ============================================================
// POST /run — live SSE execution with onEvidence trace capture
// ============================================================

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
  const intent = classifyGoal(goal);

  const [run] = await db.insert(agenticRunsTable).values({
    userId: user.id,
    url,
    goal,
    status: "running",
    modelUsed: `${provider}/${modelId}`,
    metadata: { engine: "stagehand", traceVersion: 1, intent },
  }).returning();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  writeEvent(res, { event: "started", runId: run.id, url, goal });

  let stagehand: Awaited<ReturnType<typeof createStagehand>> | undefined;
  const acc = createAccumulator(url);
  try {
    const config = await resolveConfig(user.id, provider, modelId);
    stagehand = await createStagehand(config);
    const page = stagehand.context.pages()[0];
    await page.goto(url);
    const initialScreenshot = await page.screenshot({ type: "png" }).catch(() => null);
    writeEvent(res, {
      event: "loading",
      url: page.url(),
      title: await page.title().catch(() => null),
      screenshot: initialScreenshot ? `data:image/png;base64,${initialScreenshot.toString("base64")}` : null,
    });
    acc.url = page.url();

    // Do NOT pass a structured `output` schema into execute(). Stagehand ends
    // such a run with a forced "done" call that sets tool_choice: "required",
    // which thinking-capable providers (opencode zen) reject with
    // "Thinking mode does not support this tool_choice". The main agent loop
    // tolerates tool_choice "auto", so dropping the schema lets the model close
    // with a normal done tool call. Structured data is extracted separately
    // after the run via extract(), which uses generateObject and no tool_choice.
    // (see earlier comment about why we do not pass an output schema)
    //
    // Thinking-capable providers (opencode zen) finish many runs with a plain
    // "stop" (just text), so stagehand.state.completed is false. Stagehand then
    // runs its end-of-run finalization, which forces tool_choice: "required",
    // and thinking-mode APIs reject that. Telling the model to close with the
    // "done" tool inside the main loop (tool_choice "auto" is allowed) means
    // state.completed becomes true and the forced finalization is skipped.
    const executeOptions = {
      instruction: `${goal}

When you have fully completed and verified the task, IMMEDIATELY call the "done" tool with { result, taskComplete: true }. If any data was gathered during the task, put it in the result object. Do NOT end with a plain text response and do NOT call "final_answer" without also calling "done".`,
      page,
      maxSteps: boundedSteps,
      toolTimeout: 45_000,
      callbacks: { onEvidence: liveEvidenceHandler(acc, res, page) },
    };

    let result: any;
    let erroredObserve = false;
    try {
      result = await stagehand.agent().execute(executeOptions as any);
    } catch (error) {
      const message = String(error);
      // Provider failures (thinking/tool_choice, time parsing, upstream issues)
      // degrade gracefully to the observe/act loop rather than failing the run.
      if (/(Invalid time value|action format|tool_choice|technical difficulties|thinking mode|upstream request|upstream issues)/i.test(message)) {
        erroredObserve = true;
      } else {
        throw error;
      }
    }
    if (erroredObserve) {
      result = await runObservedActions(stagehand, page, goal, boundedSteps, res, acc);
    } else if (result && !result.success && /(invalid time value|action format|tool_choice|technical difficulties|thinking mode|upstream request|upstream issues)/i.test(String(result.message))) {
      result = await runObservedActions(stagehand, page, goal, boundedSteps, res, acc);
    }

    // Structured output is harvested lazily after the run using extract()
    // (no tool_choice, so it is safe for thinking-capable providers). If the
    // provider already surfaced an output (rare), prefer it.
    let stagedOutput: Record<string, unknown> | null =
      result?.output && typeof result?.output === "object"
        ? result.output as Record<string, unknown>
        : null;
    if (!stagedOutput && result?.success && stagehand) {
      const { schema } = structuredOutputSchema(intent);
      if (schema) {
        try {
          const extracted = await stagehand.extract(
            `Extract the requested details from the current page for: ${goal}. Return null/omit any field you could not determine.`,
            schema as any,
            { page },
          );
          if (extracted && typeof extracted === "object") stagedOutput = extracted as Record<string, unknown>;
        } catch (extractError) {
          logger.warn({ extractError, runId: run.id }, "Post-run structured extraction failed; continuing without it");
        }
      }
    }
    const generatedOutput = stagedOutput;
    const validation = await validateCompletion(page, goal, result ?? { success: false, message: "No result" }, url, generatedOutput);

    const finalResult = validation.valid
      ? result
      : { ...result, success: false, completed: false, message: validation.reason };

    const actions = acc.actions;
    const trace = normalizeTrace(actions, url);
    const generated = generateStagehandPlaywrightScript(url, goal, trace, generatedOutput);

    // Some opencode-model providers (e.g. OpenCode Zen reasoning models) reject
    // Stagehand's forced tool_choice and structured/sampling mid-run, so the
    // agent "finishes" by reading the page without ever clicking. Detect the
    // known provider signatures and surface an honest warning + recommendation
    // instead of a silent ok.
    const providerFailure = detectProviderCompatibilityIssue(
      provider,
      modelId,
      finalResult?.message,
      acc.actions,
    );
    if (providerFailure) generated.warnings.push(providerFailure);

    const metadata: Record<string, unknown> = {
      engine: "stagehand",
      traceVersion: 1,
      intent,
      stagehandTrace: trace,
      stagehandOutput: generatedOutput,
      stagehandResult: { success: Boolean(finalResult?.success), message: finalResult?.message, completed: finalResult?.completed },
      completionValidation: validation,
      metrics: await collectMetrics(stagehand),
      generatedPlaywrightCode: generated.code,
      generatedPlaywrightWarnings: generated.warnings,
    };

    const persisted = await persistScript(user.id, run.id, generated.code, generated.warnings, goal);
    if (persisted.id) {
      metadata.scriptId = persisted.id;
    }

    await db.update(agenticRunsTable).set({
      status: finalResult?.success ? "completed" : "failed",
      success: finalResult?.success,
      error: finalResult?.success ? null : finalResult?.message,
      stepCount: actions.length,
      metadata,
      completedAt: new Date(),
    }).where(eq(agenticRunsTable.id, run.id));

    writeEvent(res, {
      event: "done",
      runId: run.id,
      status: finalResult?.success ? "completed" : "failed",
      result: finalResult,
      trace,
      output: generatedOutput,
      code: generated.code,
      warnings: generated.warnings,
      completionValidation: validation,
      metrics: metadata.metrics,
      scriptId: persisted.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, runId: run.id }, "Stagehand agent run failed");
    await db.update(agenticRunsTable).set({ status: "failed", success: false, error: message, completedAt: new Date() }).where(eq(agenticRunsTable.id, run.id));
    writeEvent(res, { event: "error", error: "stagehand_run_failed", runId: run.id, message });
  } finally {
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
  const output = metadata.stagehandOutput && typeof metadata.stagehandOutput === "object"
    ? metadata.stagehandOutput as Record<string, unknown>
    : null;
  const generated = generateStagehandPlaywrightScript(run.url, run.goal, trace, output);
  const persisted = await persistScript(user.id, run.id, generated.code, generated.warnings, run.goal);
  await db.update(agenticRunsTable).set({
    metadata: { ...metadata, generatedPlaywrightCode: generated.code, generatedPlaywrightWarnings: generated.warnings, scriptId: persisted.id ?? metadata.scriptId },
  }).where(eq(agenticRunsTable.id, run.id));
  res.json({
    scriptId: persisted.id,
    version: persisted.version,
    runId: run.id,
    language: "typescript",
    framework: "playwright",
    code: generated.code,
    warnings: generated.warnings,
  });
});

router.get("/runs", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const runs = await db.select().from(agenticRunsTable).where(eq(agenticRunsTable.userId, user.id)).orderBy(desc(agenticRunsTable.createdAt)).limit(50);
  res.json({ runs: runs.filter((run) => (run.metadata as Record<string, unknown> | null)?.engine === "stagehand") });
});

// ============================================================
// Generated script: run / repair / refine-locators, and code runs
// ============================================================

function latestScript(id: string, userId: string) {
  return db.select().from(generatedTestScriptsTable)
    .where(and(eq(generatedTestScriptsTable.id, id), eq(generatedTestScriptsTable.userId, userId)))
    .orderBy(desc(generatedTestScriptsTable.version)).limit(1);
}

async function latestScriptRow(id: string, userId: string) {
  const [row] = await latestScript(id, userId);
  return row ?? null;
}

router.post("/scripts/:id/run", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const script = await latestScriptRow(req.params.id as string, user.id);
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
  await db.insert(codeRunsTable).values({ id: codeRunId, userId: user.id, scriptId: script.id, status: "queued", events: [] });
  startCodeRun({ id: codeRunId, code: script.code, url, userId: user.id });
  res.status(202).json({ codeRunId, scriptId: script.id, version: script.version });
});

router.post("/scripts/:id/repair", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const script = await latestScriptRow(req.params.id as string, user.id);
  if (!script) {
    res.status(404).json({ error: "script_not_found" });
    return;
  }
  const [run] = await db.select().from(agenticRunsTable).where(eq(agenticRunsTable.id, script.sourceRunId)).limit(1);
  if (!run) {
    res.status(422).json({ error: "trace_unavailable" });
    return;
  }
  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata as Record<string, unknown> : {};
  const trace = Array.isArray(metadata.stagehandTrace) ? metadata.stagehandTrace as StagehandTraceStep[] : [];
  if (trace.length === 0) {
    res.status(422).json({ error: "trace_unavailable" });
    return;
  }
  const provider = typeof run.modelUsed === "string" && run.modelUsed.includes("/")
    ? run.modelUsed.split("/")[0]
    : "opencode";
  const [keyRow] = await db.select().from(userApiKeysTable).where(and(eq(userApiKeysTable.userId, user.id), eq(userApiKeysTable.provider, provider))).limit(1);
  let generated = generateStagehandPlaywrightScript(run.url, run.goal, trace, metadata.stagehandOutput as Record<string, unknown> | null | undefined);
  let explanation = "Regenerated from the source Stagehand trace.";
  const error = typeof req.body?.error === "string" ? req.body.error : "";
  if (keyRow) {
    try {
      const repaired = await repairPlaywrightScript({
        code: script.code,
        error,
        trace: toGeneratedTrace(trace),
        provider,
        apiKey: decryptKey(JSON.parse(keyRow.encryptedKey)),
      });
      generated = { code: repaired.code, warnings: repaired.warnings };
      explanation = repaired.explanation;
    } catch (repairError) {
      logger.warn({ repairError, scriptId: script.id }, "Model-assisted repair failed; using deterministic regeneration");
      generated.warnings.unshift("Model-assisted repair was unavailable; regenerated from the original Stagehand trace.");
    }
  } else {
    generated.warnings.unshift("No provider key available for model-assisted repair; regenerated from the original trace.");
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

router.post("/scripts/:id/refine-locators", async (req: Request, res: Response) => {
  const user = (await getOrCreateUser(req.user!))!;
  const script = await latestScriptRow(req.params.id as string, user.id);
  if (!script) {
    res.status(404).json({ error: "script_not_found" });
    return;
  }
  const [run] = await db.select().from(agenticRunsTable).where(eq(agenticRunsTable.id, script.sourceRunId)).limit(1);
  const provider = typeof run?.modelUsed === "string" && run.modelUsed.includes("/")
    ? run.modelUsed.split("/")[0]
    : "opencode";
  const [keyRow] = await db.select().from(userApiKeysTable).where(and(eq(userApiKeysTable.userId, user.id), eq(userApiKeysTable.provider, provider))).limit(1);
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
      modelId: provider === "opencode" ? "big-pickle" : (typeof run.modelUsed === "string" && run.modelUsed.includes("/") ? run.modelUsed.split("/")[1] : "gpt-4o-mini"),
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
  const onPersistedEvent = async (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      const completedEvent = [...run.events].reverse().find((e: any) => e.event === "code_run_completed");
      await db.update(codeRunsTable).set({
        status: run.status,
        events: run.events,
        error: completedEvent && typeof (completedEvent as any).error === "string" ? (completedEvent as any).error : null,
        completedAt: ["completed", "failed", "stopped"].includes(run.status) ? new Date() : undefined,
      }).where(eq(codeRunsTable.id, run.id));
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

export default router;
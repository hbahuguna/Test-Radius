import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { agenticRunsTable, userApiKeysTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser } from "../lib/auth";
import { proxyBrowserAutoStream, stopBrowserAutoRun, getBrowserAutoScreenshot } from "../lib/browser-use-client";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";

const CREDITS_ENABLED = process.env.CREDITS_ENABLED !== "false";
const BROWSER_USE_API_KEY = process.env.BROWSER_USE_API_KEY;

const router: IRouter = Router();

router.use(requireSignedUp);

/**
 * POST /api/browser-auto/run
 * Start a browser-auto test run.
 */
router.post("/run", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { url, goal, assertions, headless = true, max_turns = 30, use_vision = true, model } = req.body ?? {};

  if (!url || !goal) {
    res.status(400).json({ error: "invalid_request", message: "url and goal are required" });
    return;
  }

  const user = (await getOrCreateUser(authUser))!;

  // Resolve model provider + BYOK key
  const modelProvider = (req.body?.model_provider as string) || user.modelProvider || "opencode";

  // Poolside models don't support vision/multimodal - force use_vision to false
  const isPoolsideModel = typeof model === "string" && model.startsWith("poolside/");
  const effectiveUseVision = use_vision && !isPoolsideModel;

  const keyRow = await db
    .select()
    .from(userApiKeysTable)
    .where(eq(userApiKeysTable.userId, user.id))
    .limit(10);
  const match = keyRow.find((k) => k.provider === modelProvider);
  
  let byokKey: string | null = null;
  let byokHeader = modelProvider;
  
  if (match) {
    byokKey = decryptKey(JSON.parse(match.encryptedKey));
  } else if (!CREDITS_ENABLED && BROWSER_USE_API_KEY) {
    // Testing mode: use the default browser-use API key
    byokKey = BROWSER_USE_API_KEY;
    byokHeader = "poolside";
  } else {
    res.status(400).json({
      error: "no_api_key",
      message: `No ${modelProvider} API key configured. Add one in Settings.`,
    });
    return;
  }
  
  const agentBody: Record<string, unknown> = {
    url,
    goal,
    assertions: assertions ?? [],
    headless,
    max_turns,
    use_vision: effectiveUseVision, // False for poolside models
  };
  
  if (byokKey && byokHeader) {
    agentBody[`${byokHeader}_api_key`] = byokKey;
    agentBody.model_provider = byokHeader === "opencode" ? "built-in" : byokHeader;
    // For poolside models, strip the provider prefix from model name
    if (typeof model === "string" && model.trim()) {
      const modelName = model.trim();
      agentBody.model = byokHeader === "poolside" ? modelName.replace(/^poolside\//, "") : modelName;
    }
  }

  // Create run record
  const [run] = await db
    .insert(agenticRunsTable)
    .values({
      userId: user.id,
      url,
      goal,
      status: "running",
      modelUsed: modelProvider,
    })
    .returning();

  // Stream the agent response
  try {
    const summary = await proxyBrowserAutoStream(agentBody as never, res);

    const { success: finalSuccess, error: finalError } = summary;

    // Update run record
    await db
      .update(agenticRunsTable)
      .set({
        status: "completed",
        success: finalSuccess,
        error: finalError,
        completedAt: new Date(),
      } as any)
      .where(eq(agenticRunsTable.id, run.id));

    res.end();
  } catch (err) {
    logger.error({ err, runId: run.id }, "Browser-auto run failed");
    const errMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(agenticRunsTable)
      .set({ status: "failed", error: errMsg, completedAt: new Date() })
      .where(eq(agenticRunsTable.id, run.id));
    if (!res.headersSent) {
      res.status(502).json({ error: "agent_error", message: "Failed to run agent" });
    } else {
      res.end();
    }
  }
});

/**
 * GET /api/browser-auto/runs
 * List the user's past runs (newest first).
 */
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

/**
 * POST /api/browser-auto/run/last/stop
 * Stop the most recent run.
 */
router.post("/run/last/stop", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const [run] = await db
    .select()
    .from(agenticRunsTable)
    .where(eq(agenticRunsTable.userId, authUser.id))
    .orderBy(desc(agenticRunsTable.createdAt))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await stopBrowserAutoRun();
  await db
    .update(agenticRunsTable)
    .set({ status: "stopped", completedAt: new Date() })
    .where(eq(agenticRunsTable.id, run.id));
  res.json({ stopped: true });
});

/**
 * POST /api/browser-auto/run/:id/stop
 * Stop a specific run.
 */
router.post("/run/:id/stop", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const [run] = await db
    .select()
    .from(agenticRunsTable)
    .where(eq(agenticRunsTable.id, String(req.params.id)))
    .limit(1);
  if (!run || run.userId !== authUser.id) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await stopBrowserAutoRun();
  await db
    .update(agenticRunsTable)
    .set({ status: "stopped", completedAt: new Date() })
    .where(eq(agenticRunsTable.id, String(req.params.id)));
  res.json({ stopped: true });
});

/**
 * GET /api/browser-auto/screenshot
 * Return the agent's current live screenshot.
 */
router.get("/screenshot", async (_req: Request, res: Response) => {
  try {
    const buf = await getBrowserAutoScreenshot();
    if (!buf) {
      res.status(404).json({ error: "no_screenshot" });
      return;
    }
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.json({ screenshot: buf.toString("base64") });
  } catch (err) {
    logger.error({ err }, "Screenshot failed");
    res.status(500).json({ error: "screenshot_failed" });
  }
});

export default router;

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { agenticRunsTable, userApiKeysTable, usersTable, creditLedgerTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireSignedUp } from "../middlewares/auth";
import { getOrCreateUser, deductCredit } from "../lib/auth";
import { proxyAgenticStream, stopAgentRun, getAgentScreenshot } from "../lib/sdet-agent";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use(requireSignedUp);

/**
 * POST /api/tester/run
 * Start an agentic test run. Enforces credits, proxies to SDET agent, streams NDJSON.
 */
router.post("/run", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { url, goal, assertions, headless = true, max_turns = 30, model } = req.body ?? {};

  if (!url || !goal) {
    res.status(400).json({ error: "invalid_request", message: "url and goal are required" });
    return;
  }

  const user = (await getOrCreateUser(authUser))!;

  // Resolve model provider + BYOK key. Every model is bring-your-own-key;
  // TestRadius charges 1 credit per run regardless of provider.
  const modelProvider = (req.body?.model_provider as string) || user.modelProvider || "opencode";

  const keyRow = await db
    .select()
    .from(userApiKeysTable)
    .where(eq(userApiKeysTable.userId, user.id))
    .limit(10);
  const match = keyRow.find((k) => k.provider === modelProvider);
  if (!match) {
    res.status(400).json({
      error: "no_api_key",
      message: `No ${modelProvider} API key configured. Add one in Settings.`,
    });
    return;
  }
  const byokKey = decryptKey(JSON.parse(match.encryptedKey));
  const byokHeader = modelProvider;

  // Charge 1 TestRadius credit for the run.
  const ok = await deductCredit(user.id, "run");
  if (!ok) {
    res.status(402).json({
      error: "insufficient_credits",
      message: "You have no credits remaining. Buy more at /pricing.",
    });
    return;
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

  // Build agent request body
  const agentBody: Record<string, unknown> = {
    url,
    goal,
    assertions: assertions ?? [],
    headless,
    max_turns,
  };
  if (byokKey && byokHeader) {
    agentBody[`${byokHeader}_api_key`] = byokKey;
    agentBody.model_provider = byokHeader === "opencode" ? "built-in" : byokHeader;
    if (typeof model === "string" && model.trim()) {
      agentBody.model = model.trim();
    }
  }

  // Stream the agent response back to the client
  try {
    const agentRes = await proxyAgenticStream(agentBody as never);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = agentRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalSuccess: boolean | null = null;
    let finalAssertions: unknown = null;
    let finalCode: string | null = null;
    let finalError: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Forward complete NDJSON lines as they arrive
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.event === "done") {
            finalSuccess = Boolean(evt.success);
            finalError = typeof evt.error === "string" ? evt.error : null;
            finalAssertions = evt.trace?.assertions ?? null;
            finalCode = typeof evt.generated_code === "string" ? evt.generated_code : null;
            // Annotate the forwarded done event with the generated code so the
            // frontend can render the final Playwright test.
            if (finalCode) evt.generated_code = finalCode;
          }
        } catch {
          // ignore malformed line
        }
        res.write(line + "\n");
      }
    }
    if (buffer.trim()) res.write(buffer.trim() + "\n");

    // Refund the credit when the run failed purely because of an invalid BYOK
    // (bring-your-own-key) provider key — the user shouldn't pay for a config
    // mistake. Auth failures are surfaced by the agent with a recognizable msg.
    const isAuthFailure =
      finalSuccess === false &&
      !!finalError &&
      /rejected the API key|invalid API key|API key/i.test(finalError) &&
      user.modelProvider !== "opencode";
    if (isAuthFailure) {
      await db
        .update(usersTable)
        .set({
          creditsRemaining: user.creditsRemaining + 1,
          creditsUsed: Math.max(0, user.creditsUsed - 1),
        })
        .where(eq(usersTable.id, user.id));
      await db.insert(creditLedgerTable).values({
        userId: user.id,
        amount: 1,
        reason: "refund_auth_failure",
        runId: run.id,
      });
      logger.info({ runId: run.id, modelProvider: user.modelProvider }, "Refunded credit: BYOK auth failure");
    }

    // Update run record
    await db
      .update(agenticRunsTable)
      .set({
        status: "completed",
        success: finalSuccess,
        assertionResults: finalAssertions as never,
        completedAt: new Date(),
      })
      .where(eq(agenticRunsTable.id, run.id));

    res.end();
  } catch (err) {
    logger.error({ err, runId: run.id }, "Agentic run proxy failed");
    await db
      .update(agenticRunsTable)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(agenticRunsTable.id, run.id));
    if (!res.headersSent) {
      res.status(502).json({ error: "agent_error", message: "Failed to reach agent service" });
    } else {
      res.end();
    }
  }
});

/**
 * GET /api/tester/runs
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
 * GET /api/tester/run/:id
 * Get a single run's details.
 */
router.get("/run/:id", async (req: Request, res: Response) => {
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
  res.json({ run });
});

/**
 * POST /api/tester/run/:id/stop
 * Stop a running agentic run.
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
  await stopAgentRun();
  await db
    .update(agenticRunsTable)
    .set({ status: "stopped", completedAt: new Date() })
    .where(eq(agenticRunsTable.id, String(req.params.id)));
  res.json({ stopped: true });
});

/**
 * POST /api/tester/run/last/stop
 * Convenience alias used by the frontend's Stop button (no run id needed).
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
  await stopAgentRun();
  await db
    .update(agenticRunsTable)
    .set({ status: "stopped", completedAt: new Date() })
    .where(eq(agenticRunsTable.id, run.id));
  res.json({ stopped: true });
});

/**
 * GET /api/tester/screenshot
 * Return the agent's current live screenshot (base64) for the Live Browser panel.
 */
router.get("/screenshot", async (_req: Request, res: Response) => {
  try {
    const buf = await getAgentScreenshot();
    if (!buf) {
      res.status(404).json({ error: "no_screenshot" });
      return;
    }
    res.json({ screenshot: buf.toString("base64") });
  } catch {
    res.status(500).json({ error: "screenshot_failed" });
  }
});

/**
 * GET /api/tester/credits
 * Return the user's current credit balance.
 */
router.get("/credits", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const user = await getOrCreateUser(authUser, { allowCreate: false });
  if (!user) {
    res.status(403).json({ error: "signup_required", message: "Please sign up first." });
    return;
  }
  res.json({
    credits_remaining: user.creditsRemaining,
    credits_used: user.creditsUsed,
    plan: user.plan,
  });
});

/**
 * POST /api/tester/credits/spend
 * Spend 1 credit for a paid UI action (copying a test, pasting an imported
 * goal, etc.). `reason` identifies the action in the ledger. Returns the
 * updated balance, or 402 if the user has no credits left.
 */
router.post("/credits/spend", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const reason = (req.body?.reason as string) || "copy_test";
  const user = (await getOrCreateUser(authUser, { allowCreate: false }))!;
  const ok = await deductCredit(user.id, reason);
  if (!ok) {
    res.status(402).json({ error: "insufficient_credits", message: "No credits remaining." });
    return;
  }
  const refreshed = await getOrCreateUser(authUser, { allowCreate: false });
  res.json({
    credits_remaining: refreshed!.creditsRemaining,
    credits_used: refreshed!.creditsUsed,
  });
});

/**
 * Resolve the caller's connected Jira instance credentials from their vault.
 * Returns null (and writes a 400 response) if not connected / corrupt.
 */
async function resolveJiraCreds(
  authUser: { id: string },
  res: Response,
): Promise<{ baseUrl: string; email: string; token: string } | null> {
  const userKeys = await db
    .select()
    .from(userApiKeysTable)
    .where(eq(userApiKeysTable.userId, authUser.id))
    .limit(10);
  const jiraKey = userKeys.find((k) => k.provider === "jira");
  if (!jiraKey) {
    res.status(400).json({
      error: "jira_not_connected",
      message: "Connect your Jira instance in Settings first.",
    });
    return null;
  }
  try {
    return JSON.parse(decryptKey(JSON.parse(jiraKey.encryptedKey)));
  } catch {
    res.status(400).json({ error: "jira_invalid", message: "Stored Jira credentials are corrupt." });
    return null;
  }
}

/**
 * Convert a Jira description field to plain text.
 * Modern Jira returns descriptions as Atlassian Document Format (ADF) — a
 * nested `{ type, content, text }` tree — which would otherwise stringify to
 * "[object Object]". Older instances may still return a plain string.
 */
function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.text && typeof node.text === "string") {
    const nl = node.type === "hardBreak" ? "\n" : "";
    return node.text + nl;
  }
  if (Array.isArray(node.content)) {
    const sep = node.type === "paragraph" || node.type === "listItem" ? "\n" : "";
    return node.content.map(adfToText).join("") + sep;
  }
  return "";
}

/**
 * POST /api/tester/jira/search
 * Search the user's connected Jira instance by summary, description, or any
 * other text field. Returns a list of matching issues. Does NOT charge credits.
 */
router.post("/jira/search", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const query = (req.body?.query as string)?.trim();
  if (!query) {
    res.status(400).json({ error: "invalid_request", message: "A search query is required" });
    return;
  }

  const creds = await resolveJiraCreds(authUser, res);
  if (!creds) return;
  const { baseUrl, email, token } = creds;

  // Atlassian removed the `text` JQL keyword (returns 410). Search summary and
  // description with the still-supported `~` (contains) operator, OR-combined.
  // Use the POST /search/jql endpoint with a JSON body for reliable encoding.
  const safe = query.replace(/"/g, '\\"');
  const jql = `summary ~ "${safe}" OR description ~ "${safe}" ORDER BY updated DESC`;

  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/api/3/search/jql`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jql,
        maxResults: 20,
        fields: ["summary", "status", "issuetype", "updated"],
      }),
    });
    if (!resp.ok) {
      res.status(502).json({ error: "jira_error", message: `Jira returned ${resp.status}` });
      return;
    }
    const data = (await resp.json()) as {
      issues?: Array<{ key: string; fields?: Record<string, any> }>;
    };
    const results = (data.issues ?? []).map((i) => ({
      key: i.key,
      summary: i.fields?.summary ?? "",
      status: i.fields?.status?.name ?? "",
      type: i.fields?.issuetype?.name ?? "",
    }));
    res.json({ results });
  } catch (err) {
    logger.error({ err, query }, "Jira search failed");
    res.status(502).json({ error: "jira_error", message: "Failed to search Jira" });
  }
});

/**
 * POST /api/tester/jira
 * Import a Jira ticket's summary + acceptance criteria as a test goal.
 * Paid feature: deducts 1 credit. Requires the user to have connected their
 * own Jira instance (stored as a `jira` API key in their vault).
 */
router.post("/jira", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const ticket = (req.body?.ticket as string)?.trim();
  if (!ticket) {
    res.status(400).json({ error: "invalid_request", message: "A Jira ticket key or URL is required" });
    return;
  }

  const creds = await resolveJiraCreds(authUser, res);
  if (!creds) return;
  const { baseUrl, email, token } = creds;

  // Charge 1 credit for the import.
  const user = (await getOrCreateUser(authUser))!;
  const ok = await deductCredit(user.id, "jira_import");
  if (!ok) {
    res.status(402).json({ error: "insufficient_credits", message: "No credits remaining." });
    return;
  }

  // Extract the issue key (e.g. TEST-123) from a raw key or a browse URL.
  const keyMatch = ticket.match(/([A-Z][A-Z0-9_]+-\d+)/);
  const issueKey = keyMatch ? keyMatch[1] : ticket;
  const apiUrl = `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;

  try {
    const resp = await fetch(apiUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      res.status(502).json({ error: "jira_error", message: `Jira returned ${resp.status}` });
      return;
    }
    const data = (await resp.json()) as { fields?: Record<string, any> };
    const fields = data.fields ?? {};
    const summary: string = typeof fields.summary === "string" ? fields.summary : "";
    const description: string = adfToText(fields.description);
    const goal = `Jira ${issueKey}: ${summary}\n\n${description}`.trim();

    res.json({ goal, url: undefined, assertions: [] });
  } catch (err) {
    logger.error({ err, issueKey }, "Jira import failed");
    res.status(502).json({ error: "jira_error", message: "Failed to fetch Jira ticket" });
  }
});

export default router;

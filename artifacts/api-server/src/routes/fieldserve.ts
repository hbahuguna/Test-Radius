import fs from "node:fs";
import path from "node:path";
import { Router, type IRouter, type Request, type Response } from "express";
import { requireSignedUp } from "../middlewares/auth";
import { getFieldServeDb, FieldServeDataStore } from "../lib/fieldserve-db";
import { logger } from "../lib/logger";
import { startRecording, stopRecording, isRecording, getActiveSessionId, recordingMiddleware } from "../lib/fieldserve-recorder";
import { getOrCreateUser } from "../lib/auth";
import { API_SPEC } from "./fieldserve-ai";
import OpenAI from "openai";
import { db } from "@workspace/db";
import { userApiKeysTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { decryptKey } from "../lib/crypto";

const router: IRouter = Router();
router.use(requireSignedUp);

function getStore(): FieldServeDataStore {
  return new FieldServeDataStore(getFieldServeDb());
}

function handleError(res: Response, err: unknown): void {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; error: string; message: string };
    res.status(e.status).json({ error: e.error, message: e.message });
    return;
  }
  logger.error({ err }, "fieldserve: internal error");
  res.status(500).json({ error: "internal_error", message: "Internal server error" });
}

/**
 * Resolve a possibly-relative URL (e.g. "/api/fieldserve") against the
 * incoming request's host. Node's `fetch`/`new URL` reject relative URLs, so
 * the UI's default relative base/spec URLs must be made absolute here.
 */
function resolveAgainstHost(req: Request, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${req.protocol}://${req.get("host")}${url}`;
}

interface TestCase {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  expectedStatus: number;
  assertions: { target: string; operator: string; expected: string }[];
}

// ===== Jobs =====

router.get("/jobs", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { status, engineer_id, site_id, priority, page, limit, sort, order } = req.query;
    const result = store.listJobs({
      status: status as string | undefined,
      engineerId: engineer_id ? Number(engineer_id) : undefined,
      siteId: site_id ? Number(site_id) : undefined,
      priority: priority as string | undefined,
      page: page !== undefined ? Number(page) : undefined,
      limit: limit !== undefined ? Number(limit) : undefined,
      sort: sort as string | undefined,
      order: order as "asc" | "desc" | undefined,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const job = store.getJob(Number(req.params.id));
    if (!job) {
      res.status(404).json({ error: "not_found", message: `Job ${req.params.id} not found` });
      return;
    }
    res.json({ job });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { title, description, siteId, skillRequired, priority, scheduledDate, estimatedDuration, slaDeadline } = req.body ?? {};

    if (!title || !siteId || !skillRequired) {
      res.status(400).json({
        error: "invalid_request",
        message: "title, siteId, and skillRequired are required",
      });
      return;
    }

    const site = store.getSite(Number(siteId));
    if (!site) {
      res.status(400).json({ error: "invalid_request", message: `Site ${siteId} not found` });
      return;
    }

    const validPriorities = ["critical", "high", "medium", "low"];
    if (priority && !validPriorities.includes(priority)) {
      res.status(400).json({ error: "invalid_request", message: `priority must be one of: ${validPriorities.join(", ")}` });
      return;
    }

    const job = store.createJob({
      title,
      description,
      siteId: Number(siteId),
      skillRequired,
      priority,
      scheduledDate,
      estimatedDuration: estimatedDuration ? Number(estimatedDuration) : undefined,
      slaDeadline,
    });
    res.status(201).json({ job });
  } catch (err) {
    handleError(res, err);
  }
});

router.patch("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const job = store.updateJob(Number(req.params.id), req.body);
    if (!job) {
      res.status(404).json({ error: "not_found", message: `Job ${req.params.id} not found` });
      return;
    }
    res.json({ job });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const deleted = store.deleteJob(Number(req.params.id));
    if (!deleted) {
      const job = store.getJob(Number(req.params.id));
      if (!job) {
        res.status(404).json({ error: "not_found", message: `Job ${req.params.id} not found` });
      } else {
        res.status(409).json({
          error: "invalid_transition",
          message: `Cannot delete job in '${job.status}' status. Only 'created' jobs can be deleted.`,
        });
      }
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== State Transitions =====

function transitionHandler(targetStatus: string) {
  return async (req: Request, res: Response) => {
    try {
      const store = getStore();
      const { notes, lat, lng, engineerId } = req.body ?? {};
      const { job } = store.transitionJob(Number(req.params.id), targetStatus, {
        notes,
        engineerId: engineerId ? Number(engineerId) : undefined,
        lat: lat !== undefined ? Number(lat) : undefined,
        lng: lng !== undefined ? Number(lng) : undefined,
      });
      res.json({ job });
    } catch (err) {
      handleError(res, err);
    }
  };
}

router.post("/jobs/:id/schedule", transitionHandler("scheduled"));

router.post("/jobs/:id/assign", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { engineerId, notes } = req.body ?? {};
    if (!engineerId) {
      res.status(400).json({ error: "invalid_request", message: "engineerId is required" });
      return;
    }
    const engineer = store.getEngineer(Number(engineerId));
    if (!engineer) {
      res.status(400).json({ error: "invalid_request", message: `Engineer ${engineerId} not found` });
      return;
    }
    if (engineer.status !== "available") {
      res.status(409).json({ error: "engineer_unavailable", message: `Engineer '${engineer.firstName} ${engineer.lastName}' is '${engineer.status}', not available` });
      return;
    }
    store.updateEngineer(Number(engineerId), { status: "busy" });
    store.updateJob(Number(req.params.id), { scheduledDate: new Date().toISOString() });
    const { job } = store.transitionJob(Number(req.params.id), "assigned", { notes, engineerId: Number(engineerId) });
    res.json({ job });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs/:id/dispatch", transitionHandler("engineer-dispatched"));
router.post("/jobs/:id/en-route", transitionHandler("en-route"));

router.post("/jobs/:id/on-site", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { notes, lat, lng } = req.body ?? {};
    const { job } = store.transitionJob(Number(req.params.id), "on-site", {
      notes,
      lat: lat !== undefined ? Number(lat) : undefined,
      lng: lng !== undefined ? Number(lng) : undefined,
    });
    res.json({ job });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs/:id/check-in", transitionHandler("checking-in"));
router.post("/jobs/:id/grant-access", transitionHandler("waiting-for-access"));
router.post("/jobs/:id/equipment-received", transitionHandler("waiting-for-equipment"));
router.post("/jobs/:id/start-work", transitionHandler("in-progress"));

router.post("/jobs/:id/hold", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { notes } = req.body ?? {};
    if (!notes) {
      res.status(400).json({ error: "invalid_request", message: "notes are required when placing a job on hold" });
      return;
    }
    const { job } = store.transitionJob(Number(req.params.id), "on-hold", { notes });
    res.json({ job });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs/:id/resume", transitionHandler("in-progress"));

router.post("/jobs/:id/complete", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const job = store.getJob(Number(req.params.id));
    if (!job) {
      res.status(404).json({ error: "not_found", message: `Job ${req.params.id} not found` });
      return;
    }
    if (job.assignedEngineerId) {
      store.updateEngineer(job.assignedEngineerId, { status: "available" });
    }
    const { job: updated } = store.transitionJob(Number(req.params.id), "completed", { notes: req.body?.notes });
    res.json({ job: updated });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs/:id/fail", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { notes } = req.body ?? {};
    if (!notes) {
      res.status(400).json({ error: "invalid_request", message: "notes are required when marking a job as failed" });
      return;
    }
    const { job } = store.transitionJob(Number(req.params.id), "failed", { notes });
    res.json({ job });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs/:id/cancel", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { notes } = req.body ?? {};
    if (!notes) {
      res.status(400).json({ error: "invalid_request", message: "notes are required when cancelling a job" });
      return;
    }
    const job = store.getJob(Number(req.params.id));
    if (job?.assignedEngineerId) {
      store.updateEngineer(job.assignedEngineerId, { status: "available" });
    }
    const { job: updated } = store.transitionJob(Number(req.params.id), "cancelled", { notes });
    res.json({ job: updated });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs/:id/defer", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { notes } = req.body ?? {};
    if (!notes) {
      res.status(400).json({ error: "invalid_request", message: "notes are required when deferring a job" });
      return;
    }
    const job = store.getJob(Number(req.params.id));
    if (job?.assignedEngineerId) {
      store.updateEngineer(job.assignedEngineerId, { status: "available" });
    }
    const { job: updated } = store.transitionJob(Number(req.params.id), "deferred", { notes });
    res.json({ job: updated });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== Engineers =====

router.get("/engineers", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { skill, status, available } = req.query;
    const engineers = store.listEngineers({
      skill: skill as string | undefined,
      status: status as string | undefined,
      available: available === "true",
    });
    res.json({ engineers });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/engineers/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const engineer = store.getEngineer(Number(req.params.id));
    if (!engineer) {
      res.status(404).json({ error: "not_found", message: `Engineer ${req.params.id} not found` });
      return;
    }
    res.json({ engineer });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/engineers", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { firstName, lastName, email, phone, employeeId, skills } = req.body ?? {};
    if (!firstName || !lastName || !email || !employeeId) {
      res.status(400).json({ error: "invalid_request", message: "firstName, lastName, email, and employeeId are required" });
      return;
    }
    const engineer = store.createEngineer({ firstName, lastName, email, phone, employeeId, skills });
    res.status(201).json({ engineer });
  } catch (err) {
    if (err instanceof Error && err.message?.includes("UNIQUE")) {
      res.status(409).json({ error: "duplicate", message: "An engineer with that email or employeeId already exists" });
      return;
    }
    handleError(res, err);
  }
});

router.patch("/engineers/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const engineer = store.updateEngineer(Number(req.params.id), req.body);
    if (!engineer) {
      res.status(404).json({ error: "not_found", message: `Engineer ${req.params.id} not found` });
      return;
    }
    res.json({ engineer });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/engineers/:id/history", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const engineer = store.getEngineer(Number(req.params.id));
    if (!engineer) {
      res.status(404).json({ error: "not_found", message: `Engineer ${req.params.id} not found` });
      return;
    }
    const history = store.getEngineerHistory(Number(req.params.id));
    res.json({ history });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== Sites =====

router.get("/sites", async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    const sites = store.listSites();
    res.json({ sites });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/sites/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const site = store.getSite(Number(req.params.id));
    if (!site) {
      res.status(404).json({ error: "not_found", message: `Site ${req.params.id} not found` });
      return;
    }
    res.json({ site });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/sites", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const { name, address, city, postcode, lat, lng, accessInstructions, contactName, contactPhone } = req.body ?? {};
    if (!name || !address || !city || !postcode) {
      res.status(400).json({ error: "invalid_request", message: "name, address, city, and postcode are required" });
      return;
    }
    const site = store.createSite({ name, address, city, postcode, lat, lng, accessInstructions, contactName, contactPhone });
    res.status(201).json({ site });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== Job Updates =====

router.get("/jobs/:id/updates", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const job = store.getJob(Number(req.params.id));
    if (!job) {
      res.status(404).json({ error: "not_found", message: `Job ${req.params.id} not found` });
      return;
    }
    const updates = store.listJobUpdates(Number(req.params.id));
    res.json({ updates });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs/:id/updates", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const job = store.getJob(Number(req.params.id));
    if (!job) {
      res.status(404).json({ error: "not_found", message: `Job ${req.params.id} not found` });
      return;
    }
    const { engineerId, status, notes, lat, lng } = req.body ?? {};
    if (!status) {
      res.status(400).json({ error: "invalid_request", message: "status is required" });
      return;
    }
    const update = store.addJobUpdate(Number(req.params.id), engineerId ? Number(engineerId) : null, status, notes, lat, lng);
    res.status(201).json({ update });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== Attachments =====

router.get("/jobs/:id/attachments", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const job = store.getJob(Number(req.params.id));
    if (!job) {
      res.status(404).json({ error: "not_found", message: `Job ${req.params.id} not found` });
      return;
    }
    const attachments = store.listAttachments(Number(req.params.id));
    res.json({ attachments });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/jobs/:id/attachments", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const job = store.getJob(Number(req.params.id));
    if (!job) {
      res.status(404).json({ error: "not_found", message: `Job ${req.params.id} not found` });
      return;
    }
    const { engineerId, fileName, fileType, fileSize } = req.body ?? {};
    if (!fileName || !fileType || !fileSize) {
      res.status(400).json({ error: "invalid_request", message: "fileName, fileType, and fileSize are required" });
      return;
    }
    const attachment = store.addAttachment(Number(req.params.id), engineerId ? Number(engineerId) : null, fileName, fileType, Number(fileSize));
    res.status(201).json({ attachment });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== Dashboard =====

router.get("/dashboard/stats", async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    const stats = store.getDashboardStats();
    res.json({ stats });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/dashboard/overdue", async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    const jobs = store.getOverdueJobs();
    res.json({ jobs });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== Seed / Reset =====

router.post("/seed", async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    store.reset();
    store.seed();
    res.json({ ok: true, message: "Demo data seeded successfully" });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/reset", async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    store.reset();
    res.json({ ok: true, message: "All data cleared" });
  } catch (err) {
    handleError(res, err);
  }
});

// ===== Recording =====

router.post("/record/start", async (req: Request, res: Response) => {
  try {
    if (isRecording()) {
      res.status(409).json({ error: "Already recording", sessionId: getActiveSessionId() });
      return;
    }
    const { name = "API Recording", baseUrl = "http://localhost:3000", apiSpecUrl } = req.body || {};

    let apiSpec: string | undefined;
    if (apiSpecUrl) {
      try {
        const resp = await fetch(resolveAgainstHost(req, apiSpecUrl));
        if (resp.ok) {
          const text = await resp.text();
          // Validate it's parseable JSON
          JSON.parse(text);
          apiSpec = text;
        }
      } catch (specErr) {
        logger.warn({ err: specErr, url: apiSpecUrl }, "fieldserve: failed to fetch API spec, recording without it");
      }
    }

    const sessionId = startRecording(name, baseUrl, apiSpec, apiSpecUrl);
    res.json({ ok: true, sessionId, message: "Recording started", apiSpecLoaded: !!apiSpec });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/record/stop", async (_req: Request, res: Response) => {
  try {
    if (!isRecording()) {
      res.status(409).json({ error: "No active recording" });
      return;
    }
    const sessionId = getActiveSessionId();
    stopRecording();
    const store = getStore();
    const session = store.getRecordedSession(sessionId!);
    res.json({ ok: true, session, message: "Recording stopped" });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/record/status", async (_req: Request, res: Response) => {
  res.json({ recording: isRecording(), sessionId: getActiveSessionId() });
});

router.get("/record/sessions", async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    const sessions = store.listRecordedSessions();
    res.json({ ok: true, sessions });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/record/sessions/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const session = store.getRecordedSession(Number(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const steps = store.getRecordedSteps(session.id);
    res.json({ ok: true, session, steps });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/record/sessions/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    store.deleteRecordedSession(Number(req.params.id));
    res.json({ ok: true, message: "Session deleted" });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/record/sessions/:id/replay", async (req: Request, res: Response) => {
  const authUser = req.user!;
  try {
    const store = getStore();
    const session = store.getRecordedSession(Number(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const steps = store.getRecordedSteps(session.id);
    const { baseUrl, dryRun = false, autoReset = true, model_provider, model_id } = req.body || {};
    const targetUrl = baseUrl || session.baseUrl;
    const resolvedBase = resolveAgainstHost(req, targetUrl);

    // Use the current request's auth token — recorded tokens may be expired
    const currentAuth = req.headers.authorization;

    // Always reset + seed before replay so the data state is predictable.
    // Recorded IDs are guaranteed stale after this — the resolver below fixes them.
    if (autoReset) {
      try {
        await fetch(resolveAgainstHost(req, "/api/fieldserve/reset"), { method: "POST", headers: currentAuth ? { Authorization: currentAuth } : {} });
        await fetch(resolveAgainstHost(req, "/api/fieldserve/seed"), { method: "POST", headers: currentAuth ? { Authorization: currentAuth } : {} });
      } catch {
        // continue even if setup fails
      }
    }

    // ------------------------------------------------------------------
    // LLM healer — optional.  When a step fails with a 4xx/5xx error the
    // healer asks the LLM what prerequisite calls are needed and retries.
    // ------------------------------------------------------------------
    const PROVIDER_BASE_URLS: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      google: "https://generativelanguage.googleapis.com/v1beta/openai",
      openrouter: "https://openrouter.ai/api/v1",
      poolside: "https://inference.poolside.ai/v1",
    };
    const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
      openai: "gpt-4o-mini",
      google: "gemini-3.5-flash",
      openrouter: "poolside/laguna-xs-2.1",
      poolside: "poolside/laguna-xs-2.1",
    };

    let healerClient: OpenAI | null = null;
    let healerModel = "gpt-4o-mini";
    {
      const user = (await getOrCreateUser(authUser))!;
      const provider = (model_provider as string) || user.modelProvider || "openai";
      const keyRow = await db
        .select()
        .from(userApiKeysTable)
        .where(eq(userApiKeysTable.userId, user.id))
        .limit(10);
      const match = keyRow.find((k) => k.provider === provider);
      let apiKey: string | undefined;
      if (match) {
        apiKey = decryptKey(JSON.parse(match.encryptedKey));
      } else if (process.env.OPENAI_API_KEY) {
        apiKey = process.env.OPENAI_API_KEY;
      }
      if (apiKey && PROVIDER_BASE_URLS[provider]) {
        healerClient = new OpenAI({ apiKey, baseURL: PROVIDER_BASE_URLS[provider] });
        healerModel = (model_id as string) || PROVIDER_DEFAULT_MODELS[provider] || "gpt-4o-mini";
        logger.info({ provider, model: healerModel }, "replay: LLM healer initialised");
      } else {
        logger.warn({ provider, hasKey: !!apiKey, hasBaseUrl: !!PROVIDER_BASE_URLS[provider] }, "replay: LLM healer NOT initialised — healing disabled");
      }
    }

    /**
     * Ask the LLM what prerequisite API calls are needed before the failed
     * step can succeed.  Returns an array of { method, path, body } objects
     * to execute in order, or an empty array if the healer can't help.
     */
    async function healStep(
      failedStep: { method: string; path: string; requestBody: string | null },
      errorBody: string,
      currentDataSummary: string,
    ): Promise<Array<{ method: string; path: string; body?: Record<string, unknown> }>> {
      if (!healerClient) return [];
      try {
        const prompt = `A replay step failed. Figure out what prerequisite API calls are needed so the failed step can succeed.

API Spec:
${API_SPEC}

Current data state:
${currentDataSummary}

Failed step:
  ${failedStep.method} ${failedStep.path}
  Body: ${failedStep.requestBody ?? "(empty)"}

Error response:
${errorBody}

Reply with ONLY a JSON array of prerequisite calls (max 5). Each element:
{ "method": "GET|POST|PATCH|DELETE", "path": "relative path like /jobs or /sites", "body": {} }

Rules:
- If the error is "invalid_transition", call the intermediate transition endpoints first.
- If the error is "not found" or "not_found", you probably need to fix a URL path ID — do NOT create new entities.
- If the error mentions an entity being unavailable, find an available one by GETting the list first.
- Return [] (empty array) if you cannot determine a fix.
- Keep it minimal — only the calls strictly necessary.`;

        logger.debug({ model: healerModel, failedStep }, "replay: calling LLM healer");
        const completion = await healerClient.chat.completions.create({
          model: healerModel,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          response_format: { type: "json_object" },
        });

        const raw = completion.choices[0]?.message?.content ?? "";
        logger.debug({ raw: raw.slice(0, 500) }, "replay: LLM healer raw response");
        // The LLM may return { "fixes": [...] } or just [...]
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { logger.warn({ raw: raw.slice(0, 200) }, "replay: LLM healer returned unparseable JSON"); return []; }
        if (Array.isArray(parsed)) { logger.debug({ fixCount: parsed.length }, "replay: LLM healer returned array"); return parsed as Array<{ method: string; path: string; body?: Record<string, unknown> }>; }
        if (parsed && typeof parsed === "object" && "fixes" in parsed && Array.isArray((parsed as any).fixes)) { logger.debug({ fixCount: (parsed as any).fixes.length }, "replay: LLM healer returned { fixes: [...] }"); return (parsed as any).fixes; }
        logger.warn({ parsed }, "replay: LLM healer returned unexpected shape — returning empty");
        return [];
      } catch (err) {
        logger.error({ err }, "replay: healer LLM call failed");
        return [];
      }
    }

    // ------------------------------------------------------------------
    // Generic entity resolver
    // ------------------------------------------------------------------
    // Entity types are derived from the API spec.  For each type we keep:
    //   - a live list of current IDs (refreshed after each step)
    //   - a name→type mapping so `siteId` → `site`, `engineerId` → `engineer`
    //   - constraints (e.g. engineer must be "available" for assign)
    // ------------------------------------------------------------------

    interface EntityType {
      name: string;           // plural form used in URL paths, e.g. "sites"
      fields: string[];       // body field names that reference this type, e.g. ["siteId"]
      constraint?: (entity: Record<string, unknown>) => boolean;  // additional validity check
    }

    const ENTITY_TYPES: EntityType[] = [
      {
        name: "sites",
        fields: ["siteId"],
      },
      {
        name: "engineers",
        fields: ["engineerId"],
        constraint: (e) => e.status === "available",
      },
      {
        name: "jobs",
        fields: ["jobId"],
      },
    ];

    // Live registry: type name → array of valid entity objects
    function buildRegistry(): Record<string, Array<Record<string, unknown>>> {
      const reg: Record<string, Array<Record<string, unknown>>> = {};
      for (const et of ENTITY_TYPES) {
        if (et.name === "sites") reg[et.name] = store.listSites() as unknown as Array<Record<string, unknown>>;
        else if (et.name === "engineers") reg[et.name] = store.listEngineers() as unknown as Array<Record<string, unknown>>;
        else if (et.name === "jobs") reg[et.name] = (store.listJobs().jobs) as unknown as Array<Record<string, unknown>>;
      }
      return reg;
    }

    /** Return the first valid ID for an entity type, applying constraints. */
    function firstValidId(reg: Record<string, Array<Record<string, unknown>>>, typeName: string): number | undefined {
      const et = ENTITY_TYPES.find((t) => t.name === typeName);
      const entities = reg[typeName];
      if (!entities?.length || !et) return undefined;
      if (et.constraint) {
        const match = entities.find((e) => et.constraint!(e));
        return match ? Number(match.id) : undefined;
      }
      return Number(entities[0].id);
    }

    let registry = buildRegistry();

    /** Call after each step to pick up newly created entities. */
    function refreshRegistry() {
      registry = buildRegistry();
    }

    // Map body field names → entity type name.  "siteId" → "sites", "engineerId" → "engineers"
    const fieldToType = new Map<string, string>();
    for (const et of ENTITY_TYPES) {
      for (const f of et.fields) fieldToType.set(f, et.name);
    }

    // Map URL path segments → entity type name.  "/sites/" → "sites", "/engineers/" → "engineers"
    const pathToType = new Map<string, string>();
    for (const et of ENTITY_TYPES) {
      pathToType.set(`/${et.name}/`, et.name);
    }

    // Resolve stale entity IDs in a JSON body string.  Generic: any field
    // whose name matches a known FK pattern (siteId, engineerId, …) is
    // checked against the live registry and swapped if invalid.
    function resolveBodyIds(body: string | null): string | null {
      if (!body) return body;
      try {
        const parsed = JSON.parse(body);
        let changed = false;

        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val !== "number" || val <= 0) continue;
          const typeName = fieldToType.get(key);
          if (!typeName) continue;

          // Check whether the referenced entity exists AND satisfies constraints
          const entities = registry[typeName] ?? [];
          const et = ENTITY_TYPES.find((t) => t.name === typeName);
          const valid = entities.some((e) => {
            if (Number(e.id) !== val) return false;
            return et?.constraint ? et.constraint(e) : true;
          });

          if (!valid) {
            const substitute = firstValidId(registry, typeName);
            if (substitute != null) {
              parsed[key] = substitute;
              changed = true;
            }
          }
        }

        return changed ? JSON.stringify(parsed) : body;
      } catch {
        return body;
      }
    }

    // Resolve stale entity IDs in URL paths like /sites/83, /engineers/5/history.
    // Generic: any `/entityType/:id` segment where the entity doesn't exist is swapped.
    function resolvePathIds(stepPath: string): string {
      let result = stepPath;
      for (const [pattern, typeName] of pathToType) {
        const re = new RegExp(`(${pattern.replace(/\//g, "\\/")})(\\d+)`);
        result = result.replace(re, (_match, prefix: string, idStr: string) => {
          const id = Number(idStr);
          const entities = registry[typeName] ?? [];
          const exists = entities.some((e) => Number(e.id) === id);
          if (exists) return `${prefix}${id}`;
          const substitute = firstValidId(registry, typeName);
          return substitute != null ? `${prefix}${substitute}` : `${prefix}${id}`;
        });
      }
      return result;
    }

    // ------------------------------------------------------------------

    // Headers that must not be replayed (hop-by-hop + stale auth + we set our own)
    const STRIPPED_HEADERS = new Set([
      "authorization",
      "host",
      "connection",
      "accept-encoding",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-dest",
      "user-agent",
      "accept-language",
      "content-length",
      "content-type",
    ]);

    // Stream NDJSON so the frontend can show step-by-step progress
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const write = (obj: Record<string, unknown>) => {
      res.write(JSON.stringify(obj) + "\n");
    };

    write({ type: "start", sessionId: session.id, scenario: session.name, totalSteps: steps.length });

    const results: Array<{
      seq: number;
      method: string;
      path: string;
      status: number;
      expectedStatus: number;
      pass: boolean;
      duration: number;
      error?: string;
    }> = [];

    for (const step of steps) {
      try {
        const resolvedPath = resolvePathIds(step.path);
        const url = new URL(resolvedPath, resolvedBase);
        const replayHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (currentAuth) replayHeaders["Authorization"] = currentAuth;
        for (const [k, v] of Object.entries(step.requestHeaders || {})) {
          if (!STRIPPED_HEADERS.has(k.toLowerCase())) replayHeaders[k] = v;
        }
        const fetchOpts: RequestInit = { method: step.method, headers: replayHeaders };
        if (!["GET", "HEAD"].includes(step.method) && step.requestBody) {
          fetchOpts.body = resolveBodyIds(step.requestBody);
        }

        if (dryRun) {
          const r = { seq: step.seq, method: step.method, path: step.path, status: step.responseStatus, expectedStatus: step.responseStatus, pass: true, duration: 0 };
          results.push(r);
          write({ type: "step", ...r });
          continue;
        }

        const execStep = async (st: typeof step, opts: RequestInit): Promise<{ response: globalThis.Response; responseBody: string; duration: number }> => {
          const start = Date.now();
          const response = await fetch(new URL(resolvePathIds(st.path), resolvedBase).toString(), opts);
          const duration = Date.now() - start;
          let responseBody = "";
          if (!["GET", "HEAD"].includes(st.method)) {
            const text = await response.text().catch(() => "");
            responseBody = text.slice(0, 10240);
          }
          return { response, responseBody, duration };
        };

        let { response: stepResp, responseBody, duration } = await execStep(step, fetchOpts);

        // --- LLM healing: if the step returned a 4xx/5xx, ask the LLM for
        // prerequisite calls, execute them, then retry once. ---
        if (healerClient && stepResp.status >= 400) {
          logger.info({ seq: step.seq, method: step.method, path: step.path, status: stepResp.status }, "replay: step failed — attempting LLM heal");
          const dataSummary = ENTITY_TYPES.map((et) => {
            const entities = registry[et.name] ?? [];
            return `${et.name}: [${entities.map((e) => `id=${e.id}`).join(", ")}]`;
          }).join("\n");

          const fixes = await healStep(
            { method: step.method, path: step.path, requestBody: step.requestBody },
            responseBody,
            dataSummary,
          );

          if (fixes.length > 0) {
            logger.info({ seq: step.seq, fixes: fixes.map((f) => `${f.method} ${f.path}`) }, "replay: LLM heal produced fixes");
            write({ type: "healing", seq: step.seq, fixes: fixes.map((f) => `${f.method} ${f.path}`) });
            // Execute each prerequisite call
            for (const fix of fixes) {
              try {
                // The LLM may return relative paths like /jobs/123/schedule
                // without the /api/fieldserve prefix.  Detect and prepend it
                // so the URL resolves against the correct mount point.
                const fixPath = fix.path.startsWith("/api/fieldserve") ? fix.path : `/api/fieldserve${fix.path}`;
                const fixUrl = new URL(resolvePathIds(fixPath), resolvedBase);
                const fixOpts: RequestInit = {
                  method: fix.method,
                  headers: replayHeaders,
                  ...(fix.body && !["GET", "HEAD"].includes(fix.method) ? { body: JSON.stringify(fix.body) } : {}),
                };
                const fixResp = await fetch(fixUrl.toString(), fixOpts);
                logger.debug({ status: fixResp.status, method: fix.method, path: fix.path }, "replay: heal fix executed");
              } catch (fixErr) {
                logger.warn({ err: fixErr, method: fix.method, path: fix.path }, "replay: heal fix failed");
              }
            }
            refreshRegistry();
            // Retry the original step
            fetchOpts.body = undefined;
            if (!["GET", "HEAD"].includes(step.method) && step.requestBody) {
              fetchOpts.body = resolveBodyIds(step.requestBody);
            }
            const retry = await execStep(step, fetchOpts);
            stepResp = retry.response;
            responseBody = retry.responseBody;
            duration = retry.duration;
          } else {
            logger.warn({ seq: step.seq, method: step.method, path: step.path }, "replay: LLM healer returned no fixes — skipping healing");
          }
        }

        // After a successful creation, refresh the registry so subsequent
        // steps can reference the newly created entity.
        if (step.method === "POST" && stepResp.status >= 200 && stepResp.status < 300) {
          refreshRegistry();
        }

        const pass = stepResp.status === step.responseStatus;
        const r: typeof results[number] = { seq: step.seq, method: step.method, path: step.path, status: stepResp.status, expectedStatus: step.responseStatus, pass, duration, ...(pass ? {} : { error: responseBody.slice(0, 500) }) };
        results.push(r);
        write({ type: "step", ...r, responseBody: pass ? undefined : responseBody.slice(0, 10240) });
      } catch (err) {
        const r = { seq: step.seq, method: step.method, path: step.path, status: 0, expectedStatus: step.responseStatus, pass: false, duration: 0, error: err instanceof Error ? err.message : String(err) };
        results.push(r);
        write({ type: "step", ...r });
      }
    }

    const passed = results.filter((r) => r.pass).length;
    const { apiSpec: _strip, apiSpecUrl: _strip2, ...sessionSlim } = session;
    write({ type: "done", session: sessionSlim, results, summary: { total: results.length, passed, failed: results.length - passed } });
    res.end();
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/record/sessions/:id/csv", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const session = store.getRecordedSession(Number(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const steps = store.getRecordedSteps(session.id);
    const header = "name,method,path,headers,body,expected_status,expected_json_path,expected_value,expected_operator,extract_as";
    const rows = steps.map((s) => {
      const body = s.requestBody ? s.requestBody.replace(/"/g, '""') : "";
      const name = `recorded_${s.seq}_${s.method.toLowerCase()}_${s.path.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}`;
      return `${name},${s.method},${s.path},{},"${body}",${s.responseStatus},$,not_null,exists,`;
    });
    const csv = [header, ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="recorded-${session.id}.csv"`);
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------------
// OpenAPI schema extraction helpers
// ---------------------------------------------------------------------------

function extractEndpointSchemas(apiSpecJson: string, steps: Array<{ method: string; path: string }>): string {
  try {
    const spec = JSON.parse(apiSpecJson);
    const isV3 = spec.openapi?.startsWith("3") || spec.info?.openapi?.startsWith("3");
    const paths = spec.paths ?? {};
    const components = spec.components?.schemas ?? spec.definitions ?? {};

    const schemas: string[] = [];
    const seen = new Set<string>();

    for (const step of steps) {
      const method = step.method.toLowerCase();
      const pathKey = Object.keys(paths).find((p) => matchPath(p, step.path)) ?? step.path;
      const key = `${method}:${pathKey}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const operation = paths[pathKey]?.[method];
      if (!operation) continue;

      const lines: string[] = [`${step.method} ${pathKey}`];
      if (operation.summary) lines.push(`  Summary: ${operation.summary}`);
      if (operation.description) lines.push(`  Description: ${operation.description}`);

      // Parameters (path, query)
      const params = operation.parameters ?? [];
      if (params.length > 0) {
        lines.push(`  Parameters:`);
        for (const p of params) {
          const schema = isV3 ? p.schema : p;
          lines.push(`    - ${p.name} (${p.in}${p.required ? ", required" : ""}): ${describeSchema(schema, components)}`);
        }
      }

      // Request body (OpenAPI 3.x)
      if (operation.requestBody?.content) {
        const jsonContent = operation.requestBody.content["application/json"];
        if (jsonContent?.schema) {
          lines.push(`  Request body:`);
          lines.push(`    ${describeSchema(jsonContent.schema, components, 4)}`);
        }
      }

      // Request body (Swagger 2.0)
      if (operation.parameters?.some((p: any) => p.in === "body")) {
        const bodyParam = operation.parameters.find((p: any) => p.in === "body");
        if (bodyParam?.schema) {
          lines.push(`  Request body:`);
          lines.push(`    ${describeSchema(bodyParam.schema, components, 4)}`);
        }
      }

      // Response schema
      const okResponse = operation.responses?.["200"] ?? operation.responses?.["201"];
      if (okResponse?.content) {
        const jsonResp = okResponse.content["application/json"];
        if (jsonResp?.schema) {
          lines.push(`  Response (200):`);
          lines.push(`    ${describeSchema(jsonResp.schema, components, 4)}`);
        }
      } else if (okResponse?.schema) {
        // Swagger 2.0
        lines.push(`  Response (200):`);
        lines.push(`    ${describeSchema(okResponse.schema, components, 4)}`);
      }

      schemas.push(lines.join("\n"));
    }

    return schemas.join("\n\n");
  } catch {
    return "";
  }
}

function matchPath(template: string, actual: string): boolean {
  const templateParts = template.split("/");
  const actualParts = actual.split("/");
  if (templateParts.length !== actualParts.length) return false;
  return templateParts.every((part, i) => part.startsWith("{") || part === actualParts[i]);
}

function describeSchema(schema: any, components: Record<string, any>, indent = 2): string {
  if (!schema) return "any";
  const pad = " ".repeat(indent);

  if (schema.$ref) {
    const refName = schema.$ref.split("/").pop();
    const resolved = components[refName];
    if (resolved) return describeSchema(resolved, components, indent);
    return refName;
  }

  if (schema.type === "object" || schema.properties) {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(props).map(([k, v]: [string, any]) => {
      const type = v.$ref ? v.$ref.split("/").pop() : v.type ?? "any";
      const req = required.has(k) ? " (required)" : "";
      return `${pad}  ${k}: ${type}${req}`;
    });
    if (fields.length === 0) return "{}";
    return `{\n${fields.join("\n")}\n${pad}}`;
  }

  if (schema.type === "array" && schema.items) {
    return `[${describeSchema(schema.items, components, indent)}]`;
  }

  if (schema.enum) {
    return schema.enum.join(" | ");
  }

  return schema.type ?? "any";
}

router.post("/record/sessions/:id/generate", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { model_provider, model_id, scenario } = req.body ?? {};

  try {
    const store = getStore();
    const session = store.getRecordedSession(Number(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const steps = store.getRecordedSteps(session.id);

    const user = (await getOrCreateUser(authUser))!;
    const provider = (model_provider as string) || user.modelProvider || "openai";

    const keyRow = await db
      .select()
      .from(userApiKeysTable)
      .where(eq(userApiKeysTable.userId, user.id))
      .limit(10);
    const match = keyRow.find((k) => k.provider === provider);
    if (!match) {
      res.status(400).json({ error: "no_api_key", message: `No ${provider} API key configured.` });
      return;
    }
    const apiKey = decryptKey(JSON.parse(match.encryptedKey));

    const trafficSummary = steps.map((s) =>
      `${s.method} ${s.path} → ${s.responseStatus} (${s.durationMs}ms)` +
      (s.requestBody ? `\n  Body: ${s.requestBody.slice(0, 200)}` : ""),
    ).join("\n");

    // Extract endpoint schemas from stored OpenAPI spec
    const schemaContext = session.apiSpec
      ? `\n\nEndpoint schemas from OpenAPI spec:\n${extractEndpointSchemas(session.apiSpec, steps)}`
      : "";

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const client = new OpenAI({ apiKey });

    const scenarioContext = scenario
      ? `\n\nUser's test scenario: "${scenario}"\nFocus on generating tests that validate this specific scenario.`
      : "";

    const specSource = session.apiSpec
      ? "the stored OpenAPI spec (schemas provided below)"
      : "the built-in FieldServe API spec";

    const stream = await client.chat.completions.create({
      model: (model_id as string) || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an API test case generator. Given recorded HTTP traffic and ${specSource}, generate structured test cases.

API Specification:
${API_SPEC}${schemaContext}

Each test case must be a JSON object:
{
  "name": "string — short descriptive name",
  "method": "GET|POST|PATCH|DELETE",
  "path": "string — relative path",
  "headers": {},
  "body": "string — JSON body matching the API spec, or empty string for GET/DELETE",
  "expectedStatus": number,
  "assertions": [
    { "target": "string — json path like $.job.status", "operator": "equals|contains|exists|matches", "expected": "string" }
  ]
}

Rules:
- Use the API spec to construct correct request bodies (field names, types, required fields)
- Convert each recorded request into a test case with proper assertions
- For new tests beyond recorded traffic, use the spec to generate valid payloads
- Follow the state machine transitions — generate tests for valid and invalid transitions
- Test edge cases: missing required fields, invalid status transitions, non-existent IDs
- Use IDs from the recorded traffic; for new tests use IDs 1-5 (seed data)
- Return ONLY a JSON array, no markdown fences, no explanation
- Generate 5-20 test cases`,
        },
        {
          role: "user",
          content: `Recorded API traffic from session "${session.name}" (${steps.length} requests):\n\n${trafficSummary}${scenarioContext}`,
        },
      ],
      temperature: 0.3,
      stream: true,
    });

    let fullContent = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullContent += delta;
        res.write(JSON.stringify({ type: "chunk", content: delta }) + "\n");
      }
    }

    let testCases: TestCase[] = [];
    try {
      const jsonMatch = fullContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) testCases = JSON.parse(jsonMatch[0]);
    } catch { /* ignore */ }

    res.write(JSON.stringify({ type: "done", testCases }) + "\n");
    res.end();
  } catch (err) {
    logger.error({ err }, "fieldserve: generate from recording failed");
    res.write(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "Generation failed" }) + "\n");
    res.end();
  }
});

// ===== Autopilot Recording (AI-driven) =====
//
// A non-technical user writes a plain-English scenario; this endpoint runs an
// agentic loop: the LLM picks the next API call (using the API spec + the last
// response), the server executes it as a real HTTP round-trip (captured by the
// active recorder), feeds the response back, and repeats until the LLM signals
// `done` or the step budget is exhausted. The resulting session is replayable
// like any manual recording.

router.post("/record/autopilot", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const {
    scenario,
    baseUrl = "/api/fieldserve",
    apiSpecUrl,
    model_provider,
    model_id,
    maxSteps = 12,
    autoReset = true,
  } = req.body ?? {};

  if (!scenario || !scenario.trim()) {
    res.status(400).json({ error: "invalid_request", message: "scenario is required" });
    return;
  }
  if (isRecording()) {
    res.status(409).json({ error: "Already recording", sessionId: getActiveSessionId() });
    return;
  }

  const user = (await getOrCreateUser(authUser))!;
  const provider = (model_provider as string) || user.modelProvider || "openai";
  const keyRow = await db
    .select()
    .from(userApiKeysTable)
    .where(eq(userApiKeysTable.userId, user.id))
    .limit(10);
  const match = keyRow.find((k) => k.provider === provider);
  let apiKey: string | undefined;
  if (match) {
    apiKey = decryptKey(JSON.parse(match.encryptedKey));
  } else if (process.env.OPENAI_API_KEY) {
    // Dev fallback: use a server-side key if no per-user key is configured.
    apiKey = process.env.OPENAI_API_KEY;
  }
  if (!apiKey) {
    res.status(400).json({ error: "no_api_key", message: `No ${provider} API key configured. Add one in Settings.` });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const write = (obj: unknown): void => { res.write(JSON.stringify(obj) + "\n"); };

  const resolvedBase = resolveAgainstHost(req, baseUrl);
  const authHeader: Record<string, string> = req.headers.authorization
    ? { Authorization: String(req.headers.authorization) }
    : {};

  let sessionId: number | null = null;

  try {
    const PROVIDER_BASE_URLS: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      google: "https://generativelanguage.googleapis.com/v1beta/openai",
      openrouter: "https://openrouter.ai/api/v1",
      poolside: "https://inference.poolside.ai/v1",
    };
    const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
      openai: "gpt-4o-mini",
      google: "gemini-3.5-flash",
      openrouter: "poolside/laguna-xs-2.1",
      poolside: "poolside/laguna-xs-2.1",
    };
    const baseURL = PROVIDER_BASE_URLS[provider];
    if (!baseURL) {
      write({ type: "error", message: `Provider "${provider}" is not supported for autopilot. Use openai, google, openrouter, or poolside.` });
      return;
    }
    const client = new OpenAI({ apiKey, baseURL });

    // Clean slate BEFORE recording so setup isn't captured as test traffic.
    if (autoReset) {
      try {
        await fetch(resolveAgainstHost(req, "/api/fieldserve/reset"), { method: "POST", headers: authHeader });
        await fetch(resolveAgainstHost(req, "/api/fieldserve/seed"), { method: "POST", headers: authHeader });
      } catch {
        // continue even if setup fails
      }
    }

    // Load API spec (fetched URL or built-in text). Stored on the session for
    // later AI generation, and injected into the agent system prompt.
    let apiSpec: string = API_SPEC;
    let apiSpecLoaded = false;
    const specUrl = apiSpecUrl ? resolveAgainstHost(req, apiSpecUrl) : undefined;
    if (specUrl) {
      try {
        const r = await fetch(specUrl);
        if (r.ok) {
          const t = await r.text();
          JSON.parse(t); // validate
          apiSpec = `${API_SPEC}\n\nOpenAPI spec JSON:\n${t}`;
          apiSpecLoaded = true;
        }
      } catch {
        // fall back to built-in spec
      }
    }

    sessionId = startRecording(
      scenario.trim().slice(0, 80) || "Autopilot",
      baseUrl,
      apiSpecLoaded ? apiSpec : undefined,
      apiSpecUrl,
    );
    write({ type: "start", sessionId, apiSpecLoaded });

    const systemPrompt = `You are an autonomous API test agent for the FieldServe API. You validate a user's scenario by calling endpoints, observing responses, and deciding the next call.

${apiSpec}

Each turn you MUST respond with a single JSON object only (no markdown, no prose) of this exact shape:
{
  "thinking": "brief reasoning for this step",
  "next_goal": "short label of what this step achieves",
  "method": "GET|POST|PATCH|DELETE",
  "path": "relative path, e.g. /jobs or /jobs/8/assign (include query string if needed)",
  "body": {},
  "done": false
}

Rules:
- Discover real IDs by listing first (GET /jobs, /engineers, /sites) — seeded IDs are NOT 1,2,3.
- Chain calls using IDs you observed in previous responses (e.g. a job id you just created).
- Follow the state machine for valid transitions.
- Validate the scenario by reading responses: e.g. after assigning an engineer, GET the job to confirm assignedEngineerId; after completing, GET to confirm status=completed.
- Do NOT call /reset or /seed — a clean state was already prepared.
- Keep paths relative to the base (no host).
- Set "done": true only when the scenario is fully validated.`;

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Test scenario: "${scenario.trim()}"\n\nStart now: choose the first API call to make.` },
    ];

    let stepNumber = 0;
    const MAX_STEPS = Math.min(Math.max(1, Number(maxSteps) || 12), 30);

    for (let i = 0; i < MAX_STEPS; i++) {
      // --- LLM turn ---
      let actionRaw = "";
      try {
        const stream = await client.chat.completions.create({
          model: (model_id as string) || PROVIDER_DEFAULT_MODELS[provider] || "gpt-4o-mini",
          messages: messages as never,
          temperature: 0.2,
          response_format: { type: "json_object" },
          stream: true,
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            actionRaw += delta;
            write({ type: "thinking", content: delta });
          }
        }
      } catch (llmErr) {
        const detail = llmErr instanceof Error ? llmErr.message : "LLM call failed";
        logger.error({ err: llmErr, provider, baseURL, model: (model_id as string) || PROVIDER_DEFAULT_MODELS[provider] }, "autopilot: LLM call failed");
        write({ type: "error", message: detail });
        break;
      }

      // --- Parse the agent's chosen action ---
      let action: { thinking?: string; next_goal?: string; method?: string; path?: string; body?: unknown; done?: boolean } | undefined;
      try {
        action = JSON.parse(actionRaw);
      } catch {
        const m = actionRaw.match(/\{[\s\S]*\}/);
        if (m) {
          try { action = JSON.parse(m[0]); } catch { /* leave undefined */ }
        }
      }
      if (!action) {
        write({ type: "error", message: "Agent returned invalid JSON" });
        break;
      }
      messages.push({ role: "assistant", content: actionRaw });

      if (action.done) {
        stepNumber++;
        write({ type: "step", stepNumber, thinking: action.thinking ?? "", nextGoal: action.next_goal ?? "done", method: "", path: "", status: 0, duration: 0, done: true });
        break;
      }

      // --- Execute the call (real HTTP round-trip → captured by recorder) ---
      const method = String(action.method ?? "GET").toUpperCase();
      const stepPath = String(action.path ?? "/");
      let bodyStr: string | undefined;
      if (action.body != null) {
        bodyStr = typeof action.body === "string" ? action.body : JSON.stringify(action.body);
        if (bodyStr === "" || bodyStr === "{}") bodyStr = undefined;
      }

      const url = new URL(stepPath, resolvedBase);
      const start = Date.now();
      let status = 0;
      let respBody = "";
      let errMsg: string | undefined;
      try {
        const r = await fetch(url.toString(), {
          method,
          headers: { "Content-Type": "application/json", ...authHeader },
          body: ["GET", "HEAD"].includes(method) ? undefined : bodyStr,
        });
        status = r.status;
        respBody = await r.text();
      } catch (e) {
        errMsg = e instanceof Error ? e.message : String(e);
      }
      const duration = Date.now() - start;
      stepNumber++;
      write({ type: "step", stepNumber, thinking: action.thinking ?? "", nextGoal: action.next_goal ?? "", method, path: stepPath, status, duration, error: errMsg, requestBody: bodyStr ?? null, responseBody: respBody || null });

      // --- Feed the response back to the agent ---
      const observation = errMsg
        ? `Error executing ${method} ${stepPath}: ${errMsg}`
        : `Response to ${method} ${stepPath}: HTTP ${status}\n${respBody.slice(0, 4000)}`;
      messages.push({ role: "user", content: observation });
    }

    // --- Persist ---
    stopRecording();
    const store = getStore();
    const session = sessionId ? store.getRecordedSession(sessionId) : null;
    write({ type: "done", session });
    res.end();
  } catch (err) {
    if (isRecording()) stopRecording();
    logger.error({ err }, "fieldserve: autopilot failed");
    write({ type: "error", message: err instanceof Error ? err.message : "Autopilot failed" });
    res.end();
  }
});

// ===== OpenAPI Spec =====

router.get("/openapi.json", (_req: Request, res: Response) => {
  // Resolve the spec relative to the module location. When running from TS
  // source the file is two levels up (src/routes -> api-server); when running
  // the bundled dist/index.mjs it is one level up (dist -> api-server). Try
  // both candidates so it works in dev and production.
  const candidates = [
    path.join(import.meta.dirname, "../../fieldserve-openapi.json"),
    path.join(import.meta.dirname, "../fieldserve-openapi.json"),
  ];
  const specPath = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  try {
    if (!specPath) throw new Error("spec not found");
    const content = fs.readFileSync(specPath, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(content);
  } catch {
    res.status(404).json({ error: "not_found", message: "OpenAPI spec not found" });
  }
});

// ===== Health =====

router.get("/health", async (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "fieldserve", timestamp: new Date().toISOString() });
});

export default router;

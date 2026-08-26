import { Router, type IRouter, type Request, type Response } from "express";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { db } from "@workspace/db";
import { userApiKeysTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireSignedUp, type AuthedUser } from "../middlewares/auth";
import { getOrCreateUser } from "../lib/auth";
import { decryptKey } from "../lib/crypto";
import { logger } from "../lib/logger";
import { getFieldServeDb, FieldServeDataStore } from "../lib/fieldserve-db";
import { API_SPEC } from "./fieldserve-ai";
import OpenAI from "openai";
import {
  openDatabase,
  DataStore,
  ReplayRunner,
  LLMStepHealer,
  OpenAIChatClient,
  BrowserSession,
  LiveAgent,
  ChromeLaunchError,
  stepToEnglish,
  detectGoogleSignIn,
  resolveGoogleChromePath,
  SuiteRunner,
  TrainRunner,
  resolveMode,
  summarizeTestName,
  uniqueTestName,
  type ReplayEvent,
  type BrowseAgentEvent,
  type Page,
  type TestWithSteps,
  type NewStep,
  type NewSlot,
  type TestSource,
  type RecordedStep,
  type SuiteRunnerEvent,
  type TrainRunnerEvent,
  type SuiteRun,
  type TrainRun,
} from "@workspace/nlp-runner";

const CHROME_WARMING_UP_MSG =
  "Chrome is still downloading on this server (first cold start takes ~3 minutes). Please wait a moment and try again.";

// Force headless on all Linux servers (including Replit) for performance.
// Headful Chrome with Xvfb rendering is too slow on cloud environments.
// Headless with real Chrome + pipe + --headless=new works fine for Google sign-in.
const isHeadlessServer = process.platform === "linux";

/**
 * Prepend variable values to the recording goal so the browser-use agent
 * always uses the provided values when filling forms instead of inventing its
 * own. Variables are provided as { "First Name": "Ada", "email": "ada@..." }.
 */
function buildGoalWithVariables(query: string, variables?: Record<string, string>): string {
  if (!variables || Object.keys(variables).length === 0) return query;
  const lines = Object.entries(variables)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return `${query}\n\nIMPORTANT — When filling in any form fields, always use EXACTLY these values (do not invent alternatives):\n${lines}`;
}
import { ShadowRecorder, stableUrlFragment, type BrowserUseStepEvent } from "../lib/browser-use-recorder.js";
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

// ----- batch run registry (suite/train runs — one per user) -------------------
interface ActiveBatchRun {
  controller: AbortController;
  kind: "suite" | "train";
  entityId: number;
  name: string;
}
const batchRuns = new Map<string, ActiveBatchRun>();

function getBatch(userId: string): ActiveBatchRun | null {
  return batchRuns.get(userId) ?? null;
}

function clearBatch(userId: string): void {
  batchRuns.delete(userId);
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
function qfDataDir(): string {
  return process.env.QF_DATA_DIR ?? `${process.env.HOME ?? ""}/.queryfirst`;
}
function getStore(): DataStore {
  if (!_store) {
    const db2 = openDatabase(qfDataDir());
    _store = new DataStore(db2);
  }
  return _store;
}

function suiteScreenshotsDir(): string {
  return join(qfDataDir(), "screenshots");
}

// ----- utilities -------------------------------------------------------------

/**
 * Extract a short success phrase from the browser-use agent's done message so
 * it can be stored as the test's `completionHint` and used during replay to
 * detect an already-achieved goal state.
 *
 * Strategy: find single-quoted strings longer than 15 characters, exclude
 * anything that looks like an email address or URL, then return the longest
 * match — which is almost always the confirmation message the agent explicitly
 * quotes (e.g. "Thanks for signing up to the Mitie Newsletter…").
 */
function extractCompletionHint(doneMessage: string): string | null {
  const matches = [...doneMessage.matchAll(/'([^']{15,200})'/g)]
    .map((m) => m[1].trim())
    .filter((s) => !s.includes("@") && !s.startsWith("http") && !s.startsWith("//"));
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.length > a.length ? b : a));
}

// ----- API suite runner -------------------------------------------------------

function resolveAgainstHost(req: Request, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${req.protocol}://${req.get("host")}${url}`;
}

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

async function runApiSuite(
  req: Request,
  res: Response,
  suite: { id: number; name: string; mode: string },
  authUser: AuthedUser,
  signal: AbortSignal,
): Promise<SuiteRun> {
  const fsStore = new FieldServeDataStore(getFieldServeDb());
  const store = getStore();
  const currentAuth = req.headers.authorization;

  // Reset + seed for a clean baseline
  try {
    await fetch(resolveAgainstHost(req, "/api/fieldserve/reset"), { method: "POST", headers: currentAuth ? { Authorization: currentAuth } : {} });
    await fetch(resolveAgainstHost(req, "/api/fieldserve/seed"), { method: "POST", headers: currentAuth ? { Authorization: currentAuth } : {} });
  } catch { /* continue even if setup fails */ }

  // --- Entity ID resolution (same as fieldserve replay) ---
  interface EntityType { name: string; fields: string[]; constraint?: (e: Record<string, unknown>) => boolean }
  const ENTITY_TYPES: EntityType[] = [
    { name: "sites", fields: ["siteId"] },
    { name: "engineers", fields: ["engineerId"], constraint: (e) => e.status === "available" },
    { name: "jobs", fields: ["jobId"] },
  ];
  const fieldToType = new Map<string, string>();
  const pathToType = new Map<string, string>();
  for (const et of ENTITY_TYPES) {
    for (const f of et.fields) fieldToType.set(f, et.name);
    pathToType.set(`/${et.name}/`, et.name);
  }

  function buildRegistry(): Record<string, Array<Record<string, unknown>>> {
    const reg: Record<string, Array<Record<string, unknown>>> = {};
    for (const et of ENTITY_TYPES) {
      if (et.name === "sites") reg[et.name] = fsStore.listSites() as unknown as Array<Record<string, unknown>>;
      else if (et.name === "engineers") reg[et.name] = fsStore.listEngineers() as unknown as Array<Record<string, unknown>>;
      else if (et.name === "jobs") reg[et.name] = fsStore.listJobs().jobs as unknown as Array<Record<string, unknown>>;
    }
    return reg;
  }
  function firstValidId(reg: Record<string, Array<Record<string, unknown>>>, typeName: string): number | undefined {
    const et = ENTITY_TYPES.find((t) => t.name === typeName);
    const entities = reg[typeName];
    if (!entities?.length || !et) return undefined;
    if (et.constraint) { const m = entities.find((e) => et.constraint!(e)); return m ? Number(m.id) : undefined; }
    return Number(entities[0].id);
  }
  function firstValidIdForState(reg: Record<string, Array<Record<string, unknown>>>, typeName: string, state: string): number | undefined {
    const et = ENTITY_TYPES.find((t) => t.name === typeName);
    const entities = reg[typeName];
    if (!entities?.length || !et) return undefined;
    if (et.constraint) {
      const m = entities.find((e) => et.constraint!(e) && (e as Record<string, unknown>).status === state);
      if (m) return Number(m.id);
      const any = entities.find((e) => et.constraint!(e));
      return any ? Number(any.id) : undefined;
    }
    const m = entities.find((e) => (e as Record<string, unknown>).status === state);
    return m ? Number(m.id) : entities[0] ? Number(entities[0].id) : undefined;
  }
  let registry = buildRegistry();
  function refreshRegistry() { registry = buildRegistry(); }

  const idMapping: Record<string, Map<number, number>> = {};
  for (const et of ENTITY_TYPES) idMapping[et.name] = new Map();

  function resolveBodyIds(body: string | null): string | null {
    if (!body) return body;
    try {
      const parsed = JSON.parse(body);
      let changed = false;
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val !== "number" || val <= 0) continue;
        const typeName = fieldToType.get(key);
        if (!typeName) continue;
        const mapped = idMapping[typeName]?.get(val);
        if (mapped != null) { parsed[key] = mapped; changed = true; continue; }
        const entities = registry[typeName] ?? [];
        const et = ENTITY_TYPES.find((t) => t.name === typeName);
        const valid = entities.some((e) => Number(e.id) === val && (!et?.constraint || et.constraint(e)));
        if (!valid) { const sub = firstValidId(registry, typeName); if (sub != null) { parsed[key] = sub; changed = true; } }
      }
      return changed ? JSON.stringify(parsed) : body;
    } catch { return body; }
  }

  function resolvePathIds(stepPath: string, preferState?: string): string {
    let result = stepPath;
    for (const [pattern, typeName] of pathToType) {
      const re = new RegExp(`(${pattern.replace(/\//g, "\\/")})(\\d+)`);
      result = result.replace(re, (_m, prefix: string, idStr: string) => {
        const id = Number(idStr);
        const mapped = idMapping[typeName]?.get(id);
        if (mapped != null) return `${prefix}${mapped}`;
        const entity = (registry[typeName] ?? []).find((e) => Number(e.id) === id);
        if (entity) {
          if (preferState && typeName === "jobs" && (entity as Record<string, unknown>).status !== preferState) {
            const alt = firstValidIdForState(registry, typeName, preferState);
            if (alt != null) return `${prefix}${alt}`;
          }
          return `${prefix}${id}`;
        }
        const sub = preferState ? firstValidIdForState(registry, typeName, preferState) : firstValidId(registry, typeName);
        return sub != null ? `${prefix}${sub}` : `${prefix}${id}`;
      });
    }
    return result;
  }
  // --- end entity resolution ---

  // --- Healing: deterministic state machine + LLM fallback ---

  // The FieldServe job state machine (from fieldserve-db.ts)
  const JOB_TRANSITIONS: Record<string, string[]> = {
    created: ["scheduled", "cancelled"],
    scheduled: ["assigned", "cancelled"],
    assigned: ["engineer-dispatched", "cancelled"],
    "engineer-dispatched": ["en-route", "cancelled"],
    "en-route": ["on-site", "cancelled"],
    "on-site": ["checking-in", "cancelled"],
    "checking-in": ["waiting-for-access", "waiting-for-equipment", "in-progress"],
    "waiting-for-access": ["waiting-for-equipment", "in-progress", "facility-not-accessible"],
    "waiting-for-equipment": ["in-progress", "parts-required"],
    "in-progress": ["on-hold", "completed", "failed"],
    "on-hold": ["in-progress", "cancelled"],
    completed: [],
    failed: ["requires-rescheduling"],
    cancelled: [],
  };

  // Map API path segment → target state name
  const PATH_TO_STATE: Record<string, string> = {
    schedule: "scheduled",
    assign: "assigned",
    dispatch: "engineer-dispatched",
    "en-route": "en-route",
    "on-site": "on-site",
    "check-in": "checking-in",
    "grant-access": "waiting-for-access",
    "equipment-received": "waiting-for-equipment",
    "start-work": "in-progress",
  };

  // Map state name → API path segment (for calling intermediate transitions)
  const STATE_TO_PATH: Record<string, string> = Object.fromEntries(Object.entries(PATH_TO_STATE).map(([k, v]) => [v, k]));

  /** BFS shortest path through the state machine from `from` to `to`. */
  function findTransitionPath(from: string, to: string): string[] {
    if (from === to) return [];
    const visited = new Set<string>([from]);
    const queue: Array<{ state: string; path: string[] }> = [{ state: from, path: [] }];
    while (queue.length > 0) {
      const { state, path } = queue.shift()!;
      for (const next of JOB_TRANSITIONS[state] ?? []) {
        if (next === to) return [...path, next];
        if (!visited.has(next)) { visited.add(next); queue.push({ state: next, path: [...path, next] }); }
      }
    }
    return [];
  }

  /** Parse "Cannot transition from 'X' to 'Y'" from error body. */
  function parseTransitionError(errorBody: string): { from: string; to: string } | null {
    try {
      const parsed = JSON.parse(errorBody);
      const msg: string = parsed.message ?? "";
      const m = msg.match(/Cannot transition from '(\w[\w-]*)' to '(\w[\w-]*)'/);
      if (m) return { from: m[1], to: m[2] };
    } catch { /* not JSON */ }
    return null;
  }

  /** Extract the job ID from a path like /api/fieldserve/jobs/123/dispatch. */
  function extractJobId(stepPath: string): number | null {
    const m = stepPath.match(/\/jobs\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  /**
   * Deterministic state-machine healing: when a transition fails with 409,
   * compute the exact intermediate calls needed via BFS and execute them.
   * Returns true if healing was performed.
   */
  async function healStateMachine(
    step: { method: string; path: string; requestBody: string | null },
    respStatus: number,
    errorBody: string,
    baseUrl: string,
    headers: Record<string, string>,
  ): Promise<boolean> {
    if (respStatus !== 409) return false;
    const parsed = parseTransitionError(errorBody);
    if (!parsed) return false;

    const pathSegment = step.path.split("/").filter(Boolean).pop() ?? "";
    const targetState = PATH_TO_STATE[pathSegment];
    if (!targetState) return false;

    const jobId = extractJobId(step.path);
    if (jobId == null) return false;

    const transitionPath = findTransitionPath(parsed.from, targetState);
    if (transitionPath.length === 0) {
      logger.warn({ from: parsed.from, to: targetState }, "api-suite: no valid transition path");
      return false;
    }

    // Prefer a job already in `from` state so we heal the right entity
    const preferState = parsed.from;
    logger.info({ jobId, from: parsed.from, to: targetState, steps: transitionPath }, "api-suite: state-machine healing");
    let allOk = true;
    for (const state of transitionPath) {
      const segment = STATE_TO_PATH[state];
      if (!segment) { logger.warn({ state }, "api-suite: no API path for state"); allOk = false; break; }
      const healPath = resolvePathIds(`/api/fieldserve/jobs/${jobId}/${segment}`, preferState);
      const healUrl = new URL(healPath, baseUrl).toString();
      try {
        const resp = await fetch(healUrl, { method: "POST", headers });
        logger.debug({ state, status: resp.status }, "api-suite: heal transition");
        if (resp.status >= 400) {
          logger.warn({ state, status: resp.status }, "api-suite: heal transition failed — aborting");
          allOk = false;
          break;
        }
      } catch (err) {
        logger.warn({ err, state }, "api-suite: heal transition failed");
        allOk = false;
        break;
      }
    }
    refreshRegistry();
    return allOk;
  }

  // --- LLM healer (fallback for non-state-machine errors) ---
  const PROVIDER_BASE_URLS: Record<string, string> = { openai: "https://api.openai.com/v1", google: "https://generativelanguage.googleapis.com/v1beta/openai", openrouter: "https://openrouter.ai/api/v1", poolside: "https://inference.poolside.ai/v1" };
  const PROVIDER_DEFAULT_MODELS: Record<string, string> = { openai: "gpt-4o-mini", google: "gemini-3.5-flash", openrouter: "poolside/laguna-xs-2.1", poolside: "poolside/laguna-xs-2.1" };
  let healerClient: OpenAI | null = null;
  let healerModel = "gpt-4o-mini";
  {
    const user = (await getOrCreateUser(authUser))!;
    const provider = user.modelProvider || "openai";
    const keyRow = await db.select().from(userApiKeysTable).where(eq(userApiKeysTable.userId, user.id)).limit(10);
    const match = keyRow.find((k) => k.provider === provider);
    let apiKey: string | undefined;
    if (match) apiKey = decryptKey(JSON.parse(match.encryptedKey));
    else if (process.env.OPENAI_API_KEY) apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && PROVIDER_BASE_URLS[provider]) {
      healerClient = new OpenAI({ apiKey, baseURL: PROVIDER_BASE_URLS[provider] });
      healerModel = PROVIDER_DEFAULT_MODELS[provider] || "gpt-4o-mini";
      logger.info({ provider, model: healerModel }, "api-suite: LLM healer initialised");
    }
  }

  async function healStepLLM(
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

      const completion = await healerClient.chat.completions.create({ model: healerModel, messages: [{ role: "user", content: prompt }], temperature: 0.1, response_format: { type: "json_object" } });
      const raw = completion.choices[0]?.message?.content ?? "";
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return []; }
      if (Array.isArray(parsed)) return parsed as Array<{ method: string; path: string; body?: Record<string, unknown> }>;
      if (parsed && typeof parsed === "object" && "fixes" in parsed && Array.isArray((parsed as any).fixes)) return (parsed as any).fixes;
      return [];
    } catch (err) {
      logger.error({ err }, "api-suite: healer LLM call failed");
      return [];
    }
  }

  function dataSummary(): string {
    return ENTITY_TYPES.map((et) => {
      const entities = registry[et.name] ?? [];
      return `${et.name}: [${entities.map((e) => `id=${e.id}`).join(", ")}]`;
    }).join("\n");
  }
  // --- end healing ---

  const suiteRun = store.createSuiteRun({ suiteId: suite.id, status: "running", mode: suite.mode as "sequential" });
  const emit = (event: SuiteRunnerEvent) => sseWrite(res, { event: "suite", ...event });

  function ensureTest(sessionName: string) {
    const testName = `[API] ${sessionName}`;
    const existing = store.listTests().find((t) => t.name === testName);
    if (existing) return existing;
    return store.createTest({ name: testName, source: "template" });
  }

  try {
    const suiteWithSessions = store.getSuiteWithApiSessions(suite.id);
    if (!suiteWithSessions) throw new Error(`Suite #${suite.id} not found`);
    const sessions = suiteWithSessions.apiSessions;
    let anySessionFailed = false;

    for (const sa of sessions) {
      if (signal.aborted) throw new Error("Aborted");

      const session = fsStore.getRecordedSession(sa.sessionId);
      if (!session) {
        anySessionFailed = true;
        emit({ type: "test-done", suiteRunId: suiteRun.id, testId: sa.sessionId, runId: 0, success: false, error: `Session #${sa.sessionId} not found` });
        continue;
      }
      const steps = fsStore.getRecordedSteps(session.id);
      const test = ensureTest(session.name);
      const run = store.createRun({ testId: test.id, status: "running", suiteRunId: suiteRun.id });

      let sessionFailed = false;
      let stepIdx = 0;
      for (const step of steps) {
        if (signal.aborted) throw new Error("Aborted");
        const resolvedPath = resolvePathIds(step.path);
        const url = new URL(resolvedPath, resolveAgainstHost(req, session.baseUrl)).toString();
        const replayHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (currentAuth) replayHeaders["Authorization"] = currentAuth;
        for (const [k, v] of Object.entries(step.requestHeaders || {})) {
          if (!STRIPPED_HEADERS.has(k.toLowerCase())) replayHeaders[k] = v;
        }
        const fetchOpts: RequestInit = { method: step.method, headers: replayHeaders };
        if (!["GET", "HEAD"].includes(step.method) && step.requestBody) {
          fetchOpts.body = resolveBodyIds(step.requestBody) ?? step.requestBody;
        }

        try {
          const start = Date.now();
          let resp = await fetch(url, fetchOpts);
          let duration = Date.now() - start;
          let respBody = "";
          respBody = (await resp.text().catch(() => "")).slice(0, 10240);

          // Healing: try deterministic state-machine first, then LLM fallback
          if (resp.status >= 400) {
            const healHeaders: Record<string, string> = { "Content-Type": "application/json" };
            if (currentAuth) healHeaders["Authorization"] = currentAuth;
            let healed = false;

            // 1) Deterministic state-machine healing (no LLM needed)
            let preferState: string | undefined;
            if (resp.status === 409) {
              const errParsed = parseTransitionError(respBody);
              if (errParsed) preferState = errParsed.from;
              healed = await healStateMachine(step, resp.status, respBody, resolveAgainstHost(req, session.baseUrl), healHeaders);
            }

            // 2) LLM fallback for non-state-machine errors
            if (!healed && healerClient) {
              const fixes = await healStepLLM({ method: step.method, path: step.path, requestBody: step.requestBody }, respBody, dataSummary());
              if (fixes.length > 0) {
                logger.info({ seq: step.seq, fixes: fixes.map((f) => `${f.method} ${f.path}`) }, "api-suite: LLM heal produced fixes");
                for (const fix of fixes) {
                  try {
                    const fixPath = fix.path.startsWith("/api/fieldserve") ? fix.path : `/api/fieldserve${fix.path}`;
                    const fixUrl = new URL(resolvePathIds(fixPath), resolveAgainstHost(req, session.baseUrl));
                    const fixOpts: RequestInit = { method: fix.method, headers: healHeaders, ...(fix.body && !["GET", "HEAD"].includes(fix.method) ? { body: JSON.stringify(fix.body) } : {}) };
                    await fetch(fixUrl.toString(), fixOpts);
                  } catch { /* continue */ }
                }
                refreshRegistry();
                healed = true;
              }
            }

            // Retry the original step after healing
            if (healed) {
              const retryResolvedPath = resolvePathIds(step.path, preferState);
              const retryUrl = new URL(retryResolvedPath, resolveAgainstHost(req, session.baseUrl)).toString();
              fetchOpts.body = undefined;
              if (!["GET", "HEAD"].includes(step.method) && step.requestBody) {
                fetchOpts.body = resolveBodyIds(step.requestBody) ?? step.requestBody;
              }
              const retryStart = Date.now();
              resp = await fetch(retryUrl, fetchOpts);
              duration = Date.now() - retryStart;
              respBody = "";
              respBody = (await resp.text().catch(() => "")).slice(0, 10240);
            }
          }

          const pass = resp.status === step.responseStatus ||
            (resp.status >= 200 && resp.status < 300 && step.responseStatus >= 400);
          if (!pass) sessionFailed = true;
          if (step.method === "POST" && resp.status >= 200 && resp.status < 300) {
            // Track old→new ID mapping so subsequent steps use the correct entity.
            for (const et of ENTITY_TYPES) {
              const createRe = new RegExp(`\\/${et.name}\\/?$`);
              if (createRe.test(step.path)) {
                try {
                  const oldParsed = JSON.parse(step.responseBody ?? "{}");
                  const newParsed = JSON.parse(respBody || "{}");
                  const singular = et.name.endsWith("s") ? et.name.slice(0, -1) : et.name;
                  const oldEntity = oldParsed[singular] ?? oldParsed;
                  const newEntity = newParsed[singular] ?? newParsed;
                  const oldId = Number(oldEntity?.id);
                  const newId = Number(newEntity?.id);
                  if (oldId > 0 && newId > 0 && oldId !== newId) {
                    idMapping[et.name].set(oldId, newId);
                    logger.info({ oldId, newId, type: et.name }, "api-suite: tracked id mapping");
                  }
                } catch { /* ignore parse errors */ }
              }
            }
            refreshRegistry();
          }
          const stepDetail = { method: step.method, path: step.path, status: resp.status, expected: step.responseStatus, duration, requestBody: step.requestBody ?? null, responseBody: respBody || null };
          store.addRunStep(run.id, { idx: stepIdx, status: pass ? "passed" : "failed", detail: stepDetail });
          emit({
            type: "step",
            suiteRunId: suiteRun.id,
            testId: test.id,
            runId: run.id,
            idx: stepIdx,
            status: pass ? "passed" : "failed",
            intent: `${step.method} ${step.path} → ${resp.status} (expected ${step.responseStatus})`,
            detail: stepDetail,
          });
        } catch (err) {
          sessionFailed = true;
          const errorDetail = { method: step.method, path: step.path, requestBody: step.requestBody ?? null, error: err instanceof Error ? err.message : String(err) };
          store.addRunStep(run.id, { idx: stepIdx, status: "failed", detail: errorDetail });
          emit({
            type: "step",
            suiteRunId: suiteRun.id,
            testId: test.id,
            runId: run.id,
            idx: stepIdx,
            status: "failed",
            intent: `${step.method} ${step.path} → error`,
            detail: errorDetail,
          });
        }
        stepIdx++;
      }

      store.finishRun(run.id, sessionFailed ? "failed" : "passed");
      if (sessionFailed) anySessionFailed = true;
      emit({ type: "test-done", suiteRunId: suiteRun.id, testId: test.id, runId: run.id, success: !sessionFailed, ...(sessionFailed ? { error: `Session "${session.name}" had failures` } : {}) });
    }

    store.finishSuiteRun(suiteRun.id, anySessionFailed ? "failed" : "passed");
    const finalRun = store.getSuiteRun(suiteRun.id)!;
    emit({ type: "suite-done", suiteRunId: finalRun.id, success: !anySessionFailed });
    return finalRun;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.finishSuiteRun(suiteRun.id, "failed", msg);
    const failed = store.getSuiteRun(suiteRun.id)!;
    emit({ type: "suite-done", suiteRunId: failed.id, success: false, error: msg });
    return failed;
  }
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
        steps: steps.map((s) => ({
          id: s.id,
          idx: s.idx,
          action: s.action,
          selector: s.selector,
          value: s.value,
          optional: s.optional ?? false,
          assertion: s.assertion ?? null,
          intent: stepToEnglish(s),
        })),
        slots: slots.map((s: { name: string; kind: string; defaultValue: string | null }) => ({
          name: s.name,
          kind: s.kind,
          defaultValue: s.defaultValue,
        })),
        completionHint: t.completionHint ?? null,
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

// DELETE /queryfirst/tests/:testId/steps/:stepId — remove one recorded step
router.delete("/tests/:testId/steps/:stepId", async (req: Request, res: Response) => {
  try {
    const testId = Number(req.params.testId);
    const stepId = Number(req.params.stepId);
    if (!Number.isInteger(testId) || !Number.isInteger(stepId)) {
      res.status(400).json({ error: "invalid_params", message: "testId and stepId must be integers" });
      return;
    }
    const store = getStore();
    const step = store.getStep(stepId);
    if (!step || step.testId !== testId) {
      res.status(404).json({ error: "step_not_found", message: "Step not found on this test" });
      return;
    }
    const existing = store.listStepsByTest(testId);
    if (existing.length <= 1) {
      res.status(400).json({ error: "cannot_delete_last_step", message: "Cannot delete the last step of a test" });
      return;
    }
    store.deleteStep(stepId);
    const updated = store.listStepsByTest(testId);
    res.json({
      ok: true,
      steps: updated.map((s) => ({
        id: s.id,
        idx: s.idx,
        action: s.action,
        selector: s.selector,
        value: s.value,
        optional: s.optional ?? false,
        assertion: s.assertion ?? null,
        intent: stepToEnglish(s),
      })),
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: delete step failed");
    res.status(500).json({ error: "internal_error", message: "Failed to delete step" });
  }
});

// PATCH /queryfirst/tests/:testId/steps/:stepId — edit one recorded step
// (e.g. update/clear an assertion, fix a selector or value).
router.patch("/tests/:testId/steps/:stepId", async (req: Request, res: Response) => {
  try {
    const testId = Number(req.params.testId);
    const stepId = Number(req.params.stepId);
    if (!Number.isInteger(testId) || !Number.isInteger(stepId)) {
      res.status(400).json({ error: "invalid_params", message: "testId and stepId must be integers" });
      return;
    }
    const store = getStore();
    const step = store.getStep(stepId);
    if (!step || step.testId !== testId) {
      res.status(404).json({ error: "step_not_found", message: "Step not found on this test" });
      return;
    }
    const { action, selector, value, assertion } = req.body ?? {};
    const patch: Parameters<typeof store.updateStep>[1] = {};
    if (action !== undefined) {
      if (typeof action !== "string") {
        res.status(400).json({ error: "invalid_action" });
        return;
      }
      patch.action = action as NewStep["action"];
    }
    if (selector !== undefined) {
      patch.selector = selector === null || selector === "" ? null : String(selector);
    }
    if (value !== undefined) {
      patch.value = value === null ? null : String(value);
    }
    if (assertion !== undefined) {
      if (assertion === null) {
        patch.assertion = null;
      } else if (typeof assertion === "object" && typeof assertion.op === "string") {
        const op = assertion.op as string;
        if (!["url", "text", "visible"].includes(op)) {
          res.status(400).json({ error: "invalid_assertion_op", message: "op must be url, text, or visible" });
          return;
        }
        patch.assertion = {
          op,
          expected: "expected" in assertion ? assertion.expected : undefined,
        };
      } else {
        res.status(400).json({ error: "invalid_assertion", message: "assertion must be {op, expected} or null" });
        return;
      }
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "empty_patch", message: "Nothing to update" });
      return;
    }
    const updated = store.updateStep(stepId, patch);
    res.json({
      ok: true,
      step: {
        id: updated.id,
        idx: updated.idx,
        action: updated.action,
        selector: updated.selector,
        value: updated.value,
        optional: updated.optional ?? false,
        assertion: updated.assertion ?? null,
        intent: stepToEnglish(updated),
      },
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: patch step failed");
    res.status(500).json({ error: "internal_error", message: "Failed to update step" });
  }
});

// POST /queryfirst/tests/:testId/steps — insert a new step at a position
// (defaults to appending at the end). Used to add an assertion after recording.
router.post("/tests/:testId/steps", async (req: Request, res: Response) => {
  try {
    const testId = Number(req.params.testId);
    if (!Number.isInteger(testId)) {
      res.status(400).json({ error: "invalid_test_id" });
      return;
    }
    const store = getStore();
    const test = store.getTest(testId);
    if (!test) {
      res.status(404).json({ error: "test_not_found", message: "Test not found" });
      return;
    }
    const { idx, action, selector, value, assertion } = req.body ?? {};
    const stepAction = typeof action === "string" ? (action as string) : "assert";
    if (!["navigate", "click", "fill", "select", "scroll", "assert", "extract", "wait", "go_back"].includes(stepAction)) {
      res.status(400).json({ error: "invalid_action", message: `Unsupported action "${stepAction}"` });
      return;
    }
    if (stepAction === "assert") {
      if (!assertion || typeof assertion !== "object" || typeof assertion.op !== "string") {
        res.status(400).json({ error: "invalid_assertion", message: "assert steps require an assertion {op, expected}" });
        return;
      }
      if (!["url", "text", "visible"].includes(assertion.op)) {
        res.status(400).json({ error: "invalid_assertion_op", message: "op must be url, text, or visible" });
        return;
      }
    }
    const existing = store.listStepsByTest(testId);
    const rawIdx = typeof idx === "number" && Number.isFinite(idx) ? (idx as number) : existing.length;
    const position = Math.min(Math.max(0, rawIdx), existing.length);
    const newStep: NewStep = {
      action: stepAction as NewStep["action"],
      selector: selector === undefined ? null : selector === "" ? null : String(selector),
      value: value === undefined ? null : value === "" ? null : String(value),
      locators: [],
      elementFingerprint: null,
      pageSignatureBefore: null,
      pageSignatureAfter: null,
      waitCondition: null,
      assertion:
        stepAction === "assert" && assertion
          ? { op: assertion.op, expected: "expected" in assertion ? assertion.expected : undefined }
          : null,
      optional: false,
    };
    const inserted = store.insertStepAt(testId, position, newStep);
    res.json({
      ok: true,
      step: {
        id: inserted.id,
        idx: inserted.idx,
        action: inserted.action,
        selector: inserted.selector,
        value: inserted.value,
        optional: inserted.optional ?? false,
        assertion: inserted.assertion ?? null,
        intent: stepToEnglish(inserted),
      },
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: insert step failed");
    res.status(500).json({ error: "internal_error", message: "Failed to insert step" });
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
  const batch = getBatch(req.user!.id);
  if (batch) {
    batch.controller.abort(new Error("Stopped by user"));
  }
  res.json({ ok: true });
});

// GET /queryfirst/active-run — the user's currently running suite/train run (if any)
router.get("/active-run", async (req: Request, res: Response) => {
  const batch = getBatch(req.user!.id);
  res.json({
    active: batch ? { kind: batch.kind, entityId: batch.entityId, name: batch.name } : null,
  });
});

// POST /queryfirst/record — SSE: record a new test using browser-use agent + shadow CDP recorder
router.post("/record", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { query, entry_url, variables, model_id, provider, api_key, use_vision, max_steps, skip_dry_run } = req.body ?? {};

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

  // Summarize the recording query into a unique, permanent test name (LLM with
  // heuristic fallback). Numeric id remains the canonical identifier.
  const nameLlm = new OpenAIChatClient({
    baseUrl: llmCfg.baseUrl,
    apiKey: llmCfg.apiKey,
    model: llmCfg.model,
  });
  const generatedName = uniqueTestName(
    store.listTestNames(),
    await summarizeTestName(nameLlm, query),
  );

  let browserSession: BrowserInstance | null = null;
  let recorder: ShadowRecorder | null = null;
  let savedTestId: number | null = null;

  try {
    // 1. Launch our own Chrome with a known debug port (or pipe if Google is detected)
    const google = detectGoogleSignIn({ query, url: entry_url });
    browserSession = await BrowserSession.launch({
      headless: isHeadlessServer ? true : !google, // headful for Google sign-in
      timeoutMs: 30_000,
      ...(google
        ? { pipe: true, chromePath: resolveGoogleChromePath() }
        : process.env.QF_CHROME_PATH && process.env.QF_CHROME_PATH !== "auto"
          ? { chromePath: process.env.QF_CHROME_PATH }
          : {}),
    });
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
          goal: buildGoalWithVariables(query, variables),
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
            name: generatedName,
            source: "recorder",
            entryUrl: result.entryUrl || entry_url || "",
            stepHash: result.stepHash,
            query,
            steps: newSteps,
            slots: newSlots,
          });
          savedTestId = saved.id;
          logger.info({ testId: saved.id }, "queryfirst: record — test saved");

          // Extract and persist completion hint from the agent's done message
          const doneMsg = (event as BrowserAgentDoneEvent).message ?? "";
          if ((event as BrowserAgentDoneEvent).success && doneMsg) {
            const hint = extractCompletionHint(doneMsg);
            if (hint) {
              store.updateCompletionHint(saved.id, hint);
              logger.info({ testId: saved.id, hint }, "queryfirst: record — completion hint captured");
            }
          }

          // 7. Dry-run gate (skip if requested — recording right after the live
          // run is state-dependent: cookies/session/subscriptions may have
          // changed, making an immediate replay more likely to fail spuriously)
          const gateResult = skip_dry_run
            ? { success: true as const }
            : await runDryRunGate(store, saved.id, variables);
          sseWrite(res, {
            event: "done",
            ok: gateResult.success,
            testId: saved.id,
            testName: generatedName,
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
        name: generatedName,
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
      const gateResult = skip_dry_run
        ? { success: true as const }
        : await runDryRunGate(store, saved.id, variables);
      sseWrite(res, {
        event: "done",
        ok: gateResult.success,
        testId: saved.id,
        testName: generatedName,
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

    // Deterministic auto-assert: guarantee an entry assertion even when the
    // agent starts on the URL directly and never issues a navigate action.
    const entryFragment = stableUrlFragment(entryUrl);
    if (entryFragment) {
      steps.push({
        action: "assert",
        value: null,
        selector: null,
        locators: [],
        elementFingerprint: null,
        pageSignatureBefore: null,
        pageSignatureAfter: null,
        waitCondition: null,
        assertion: { op: "url", expected: entryFragment },
        optional: false,
      });
    }
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
      optional: s.optional ?? false,
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
  const testWithSteps = store.getTestWithSteps(testId);
  if (!testWithSteps) return { success: false, error: "test not found" };

  const google = detectGoogleSignIn({
    query: testWithSteps.query ?? undefined,
    url: testWithSteps.entryUrl ?? undefined,
  });

  try {
    gateSession = await BrowserSession.launch({
      headless: isHeadlessServer ? true : !google,
      timeoutMs: 20_000,
      ...(google
        ? { pipe: true, chromePath: resolveGoogleChromePath() }
        : process.env.QF_CHROME_PATH && process.env.QF_CHROME_PATH !== "auto"
          ? { chromePath: process.env.QF_CHROME_PATH }
          : {}),
    });
    gatePage = await gateSession.newPage();
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
    const google = detectGoogleSignIn({
      query: test.query ?? undefined,
      url: entry_url ?? test.entryUrl ?? undefined,
    });
    browserSession = await BrowserSession.launch({
      headless: isHeadlessServer ? true : (headful === true ? false : !google),
      timeoutMs: 20_000,
      ...(google
        ? { pipe: true, chromePath: resolveGoogleChromePath() }
        : process.env.QF_CHROME_PATH && process.env.QF_CHROME_PATH !== "auto"
          ? { chromePath: process.env.QF_CHROME_PATH }
          : {}),
    });
    const page = await browserSession.newPage();
    active.session = browserSession;
    active.page = page;

    // If an entry_url override is given, navigate there first
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
      completionHint: test.completionHint ?? undefined,
      onEvent: (event: ReplayEvent) => {
        if (active.stopped) return;
        sseWrite(res, { event: "replay", ...event });
      },
    });

    // Deterministically capture the final page state: the frontend's live
    // browser view polls /screenshot, but that races the grace period and
    // browser teardown — and during a navigation-triggering step the capture
    // fails or returns a blank frame, so the last view users see is the page
    // *before* the final step. Settle the page, then push the definitive
    // screenshot over SSE so the live view always shows the final state.
    await page.waitForSettled();
    const finalShot = await captureScreenshot(page);
    if (finalShot) {
      active.latestScreenshot = finalShot;
      sseWrite(res, { event: "screenshot", screenshot: finalShot });
    }

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

// ----- suites & trains -------------------------------------------------------

function parseMode(v: unknown): "sequential" | "parallel" | null {
  return v === "sequential" || v === "parallel" ? v : null;
}

function asIdList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  return ids;
}

interface MemberInput {
  id: number;
  parallel: boolean;
}

/** Parse a members array: either `[{testId, parallel}]` or a bare `[id, …]`. */
function parseMembers(raw: unknown, idKey: string): MemberInput[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MemberInput[] = [];
  for (const entry of raw) {
    if (typeof entry === "number") {
      if (!Number.isInteger(entry) || entry <= 0) return null;
      out.push({ id: entry, parallel: false });
      continue;
    }
    if (entry && typeof entry === "object") {
      const id = Number((entry as Record<string, unknown>)[idKey]);
      if (!Number.isInteger(id) || id <= 0) return null;
      out.push({ id, parallel: (entry as Record<string, unknown>).parallel === true });
      continue;
    }
    return null;
  }
  return out;
}

function suitePayload(store: DataStore, suiteId: number) {
  const s = store.getSuite(suiteId);
  if (!s) return null;
  if (s.type === "api") {
    const apiS = store.getSuiteWithApiSessions(suiteId);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      mode: s.mode,
      type: s.type,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      tests: [],
      apiSessions: (apiS?.apiSessions ?? []).map((as) => ({ suiteApiSessionId: as.id, sessionId: as.sessionId, position: as.position })),
    };
  }
  const loaded = store.getSuiteWithTests(suiteId);
  if (!loaded) return null;
  return {
    id: loaded.id,
    name: loaded.name,
    description: loaded.description,
    mode: loaded.mode,
    type: loaded.type,
    createdAt: loaded.createdAt,
    updatedAt: loaded.updatedAt,
    apiSessions: [],
    tests: loaded.tests.map((t) => {
      const test = store.getTest(t.testId);
      return {
        suiteTestId: t.id,
        testId: t.testId,
        position: t.position,
        parallel: t.parallel,
        name: test?.name ?? `#${t.testId}`,
      };
    }),
  };
}

function trainPayload(store: DataStore, trainId: number) {
  const t = store.getTrainWithSuites(trainId);
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    mode: t.mode,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    suites: t.suites.map((s) => {
      const suite = store.getSuite(s.suiteId);
      return {
        trainSuiteId: s.id,
        suiteId: s.suiteId,
        position: s.position,
        parallel: s.parallel,
        name: suite?.name ?? `#${s.suiteId}`,
        mode: suite?.mode ?? null,
      };
    }),
  };
}

function suiteRunPayload(store: DataStore, suiteRunId: number) {
  const run = store.getSuiteRunWithRuns(suiteRunId);
  if (!run) return null;
  const suite = store.getSuite(run.suiteId);
  return {
    id: run.id,
    suiteId: run.suiteId,
    suiteName: suite?.name ?? `Suite #${run.suiteId}`,
    trainRunId: run.trainRunId,
    status: run.status,
    mode: run.mode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error instanceof Error ? run.error.message : run.error,
    runs: run.runs.map((r) => {
      const test = store.getTest(r.testId);
      return {
        runId: r.id,
        testId: r.testId,
        name: test?.name ?? `#${r.testId}`,
        status: r.status,
        llmCalls: r.llmCalls,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error instanceof Error ? r.error.message : r.error,
      };
    }),
  };
}

function trainRunPayload(store: DataStore, trainRunId: number) {
  const run = store.getTrainRun(trainRunId);
  if (!run) throw new Error(`No train run with id ${trainRunId}`);
  const loaded = store.getTrainRunWithSuiteRuns(trainRunId);
  return {
    id: run.id,
    trainId: run.trainId,
    status: run.status,
    mode: run.mode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error instanceof Error ? run.error.message : run.error,
    suiteRuns: loaded.suiteRuns.map((sr) => suiteRunPayload(store, sr.id)),
  };
}

function listSuiteScreenshots(suiteRunId: number): string[] {
  const root = join(suiteScreenshotsDir(), String(suiteRunId));
  if (!existsSync(root)) return [];
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.png$/i.test(f))
    .sort();
}

/** Screenshots belonging to one member test run of a suite run. */
function listScreenshotsForTestRun(suiteRunId: number, testId: number, runId: number): { path: string; url: string }[] {
  const root = join(suiteScreenshotsDir(), String(suiteRunId), String(testId));
  if (!existsSync(root)) return [];
  const prefix = `${runId}-`;
  return (readdirSync(root) as string[])
    .filter((f) => f.startsWith(prefix) && /\.png$/i.test(f))
    .sort()
    .map((f) => ({
      path: f,
      url: `/api/queryfirst/suite-runs/${suiteRunId}/screenshots/${testId}/${f}`,
    }));
}

function suiteRunSummary(store: DataStore, run: SuiteRun) {
  const suite = store.getSuite(run.suiteId);
  const loaded = store.getSuiteRunWithRuns(run.id);
  const runs = loaded?.runs ?? [];
  return {
    id: run.id,
    suiteId: run.suiteId,
    suiteName: suite?.name ?? `Suite #${run.suiteId}`,
    trainRunId: run.trainRunId,
    status: run.status,
    mode: run.mode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error instanceof Error ? run.error.message : run.error,
    testCount: runs.length,
    passed: runs.filter((r) => r.status === "passed").length,
    failed: runs.filter((r) => r.status === "failed").length,
  };
}

function trainRunSummary(store: DataStore, run: TrainRun) {
  const train = store.getTrain(run.trainId);
  return {
    id: run.id,
    trainId: run.trainId,
    trainName: train?.name ?? `Train #${run.trainId}`,
    status: run.status,
    mode: run.mode,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error instanceof Error ? run.error.message : run.error,
    suiteCount: store.getTrainRunWithSuiteRuns(run.id).suiteRuns.length,
  };
}

// GET /queryfirst/suites — list all suites (optionally filter by ?type=ui|api)
router.get("/suites", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const type = req.query.type as string | undefined;
    if (type && type !== "ui" && type !== "api") {
      res.status(400).json({ error: "invalid_request", message: "type must be 'ui' or 'api'" });
      return;
    }
    res.json({ suites: store.listSuites(type).map((s) => suitePayload(store, s.id)) });
  } catch (err) {
    logger.error({ err }, "queryfirst: list suites failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list suites" });
  }
});

// POST /queryfirst/suites — create a suite (optionally with member tests or API sessions)
router.post("/suites", async (req: Request, res: Response) => {
  try {
    const { name, description, mode, testIds, tests, type, apiSessionIds } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "invalid_request", message: "name is required" });
      return;
    }
    const suiteType = type === "api" ? "api" : "ui";
    const m = parseMode(mode);
    if (m === null && mode !== undefined) {
      res.status(400).json({ error: "invalid_request", message: "mode must be sequential or parallel" });
      return;
    }
    const store = getStore();
    if (suiteType === "api") {
      const sessionIds: number[] = Array.isArray(apiSessionIds) ? apiSessionIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
      const suite = store.createSuite({ name, description: description ?? null, mode: m ?? "sequential", type: "api" });
      if (sessionIds.length > 0) store.setSuiteApiSessions(suite.id, sessionIds);
      res.status(201).json({ suite: suitePayload(store, suite.id) });
    } else {
      const members = tests !== undefined ? parseMembers(tests, "testId") : testIds !== undefined ? parseMembers(testIds, "testId") : [];
      if (members === null) {
        res.status(400).json({ error: "invalid_request", message: "tests/testIds must be an array of {testId, parallel?} or positive ids" });
        return;
      }
      for (const mem of members) {
        if (!store.getTest(mem.id)) {
          res.status(400).json({ error: "invalid_request", message: `Test #${mem.id} not found` });
          return;
        }
      }
      const suite = store.createSuite({ name, description: description ?? null, mode: m ?? "sequential", type: "ui" });
      if (members.length > 0) store.setSuiteTests(suite.id, members.map((mem) => ({ testId: mem.id, parallel: mem.parallel })));
      res.status(201).json({ suite: suitePayload(store, suite.id) });
    }
  } catch (err) {
    logger.error({ err }, "queryfirst: create suite failed");
    res.status(500).json({ error: "internal_error", message: "Failed to create suite" });
  }
});

// GET /queryfirst/suites/:id
router.get("/suites/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const payload = suitePayload(store, Number(req.params.id));
    if (!payload) {
      res.status(404).json({ error: "not_found", message: `Suite #${req.params.id} not found` });
      return;
    }
    res.json({ suite: payload });
  } catch (err) {
    logger.error({ err }, "queryfirst: get suite failed");
    res.status(500).json({ error: "internal_error", message: "Failed to get suite" });
  }
});

// PATCH /queryfirst/suites/:id
router.patch("/suites/:id", async (req: Request, res: Response) => {
  try {
    const { name, description, mode } = req.body ?? {};
    const m = parseMode(mode);
    if (m === null && mode !== undefined) {
      res.status(400).json({ error: "invalid_request", message: "mode must be sequential or parallel" });
      return;
    }
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getSuite(id)) {
      res.status(404).json({ error: "not_found", message: `Suite #${id} not found` });
      return;
    }
    store.updateSuite(id, {
      name: typeof name === "string" ? name : undefined,
      description: description === undefined ? undefined : description,
      mode: m ?? undefined,
    });
    res.json({ suite: suitePayload(store, id) });
  } catch (err) {
    logger.error({ err }, "queryfirst: update suite failed");
    res.status(500).json({ error: "internal_error", message: "Failed to update suite" });
  }
});

// DELETE /queryfirst/suites/:id
router.delete("/suites/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getSuite(id)) {
      res.status(404).json({ error: "not_found", message: `Suite #${id} not found` });
      return;
    }
    store.deleteSuite(id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "queryfirst: delete suite failed");
    res.status(500).json({ error: "internal_error", message: "Failed to delete suite" });
  }
});

// PUT /queryfirst/suites/:id/tests — replace member tests (order = position, per-member parallel flag)
router.put("/suites/:id/tests", async (req: Request, res: Response) => {
  try {
    const { tests, testIds } = req.body ?? {};
    const members = tests !== undefined ? parseMembers(tests, "testId") : testIds !== undefined ? parseMembers(testIds, "testId") : null;
    if (members === null) {
      res.status(400).json({ error: "invalid_request", message: "tests/testIds must be an array of {testId, parallel?} or positive ids" });
      return;
    }
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getSuite(id)) {
      res.status(404).json({ error: "not_found", message: `Suite #${id} not found` });
      return;
    }
    for (const mem of members) {
      if (!store.getTest(mem.id)) {
        res.status(400).json({ error: "invalid_request", message: `Test #${mem.id} not found` });
        return;
      }
    }
    store.setSuiteTests(id, members.map((mem) => ({ testId: mem.id, parallel: mem.parallel })));
    res.json({ suite: suitePayload(store, id) });
  } catch (err) {
    logger.error({ err }, "queryfirst: set suite tests failed");
    res.status(500).json({ error: "internal_error", message: "Failed to set suite tests" });
  }
});

// PUT /queryfirst/suites/:id/api-sessions — replace API session members
router.put("/suites/:id/api-sessions", async (req: Request, res: Response) => {
  try {
    const { apiSessionIds } = req.body ?? {};
    if (!Array.isArray(apiSessionIds)) {
      res.status(400).json({ error: "invalid_request", message: "apiSessionIds must be an array of session IDs" });
      return;
    }
    const sessionIds = apiSessionIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
    const store = getStore();
    const id = Number(req.params.id);
    const suite = store.getSuite(id);
    if (!suite) {
      res.status(404).json({ error: "not_found", message: `Suite #${id} not found` });
      return;
    }
    if (suite.type !== "api") {
      res.status(400).json({ error: "invalid_request", message: "This endpoint is only for API suites" });
      return;
    }
    store.setSuiteApiSessions(id, sessionIds);
    res.json({ suite: suitePayload(store, id) });
  } catch (err) {
    logger.error({ err }, "queryfirst: set suite api sessions failed");
    res.status(500).json({ error: "internal_error", message: "Failed to set suite API sessions" });
  }
});

// GET /queryfirst/suites/:id/runs — suite run history
router.get("/suites/:id/runs", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getSuite(id)) {
      res.status(404).json({ error: "not_found", message: `Suite #${id} not found` });
      return;
    }
    const runs = store.listSuiteRuns(id);
    res.json({
      runs: runs.map((r) => ({
        id: r.id,
        suiteId: r.suiteId,
        status: r.status,
        mode: r.mode,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error instanceof Error ? r.error.message : r.error,
      })),
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: list suite runs failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list suite runs" });
  }
});

// POST /queryfirst/suites/:id/run — SSE: run the suite (headless)
router.post("/suites/:id/run", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const suiteId = Number(req.params.id);
  const store = getStore();
  const suite = store.getSuiteWithTests(suiteId);
  if (!suite) {
    res.status(404).json({ error: "not_found", message: `Suite #${suiteId} not found` });
    return;
  }
  if (getBatch(authUser.id)) {
    sseHeaders(res);
    sseWrite(res, { event: "error", message: "A suite/train run is already in progress. Stop it first." });
    res.end();
    return;
  }

  const controller = new AbortController();
  batchRuns.set(authUser.id, { controller, kind: "suite", entityId: suiteId, name: suite.name });
  sseHeaders(res);
  sseWrite(res, { event: "started", kind: "suite", suiteId, suiteName: suite.name });

  try {
    let suiteRun: SuiteRun;
    if (suite.type === "api") {
      suiteRun = await runApiSuite(req, res, suite, authUser, controller.signal);
    } else {
      const runner = new SuiteRunner(store, {
        launch: async () => {
          const s = await BrowserSession.launch({ headless: true, timeoutMs: 20_000 });
          return { page: await s.newPage(), close: () => s.close() };
        },
        screenshotBaseDir: suiteScreenshotsDir(),
        concurrency: 4,
      });
      suiteRun = await runner.runSuite(suiteId, {
        signal: controller.signal,
        onEvent: (event: SuiteRunnerEvent) => {
          sseWrite(res, { event: "suite", ...event });
        },
      });
    }
    sseWrite(res, {
      event: "done",
      kind: "suite",
      suiteRunId: suiteRun.id,
      ok: suiteRun.status === "passed",
      status: suiteRun.status,
      error: suiteRun.error !== null ? String(suiteRun.error) : undefined,
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: suite run failed");
    sseWrite(res, { event: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearBatch(authUser.id);
  }
  res.end();
});

// ----- trains ----------------------------------------------------------------

// GET /queryfirst/trains — list all trains
router.get("/trains", async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    res.json({ trains: store.listTrains().map((t) => trainPayload(store, t.id)) });
  } catch (err) {
    logger.error({ err }, "queryfirst: list trains failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list trains" });
  }
});

// POST /queryfirst/trains — create a train (optionally with member suites)
router.post("/trains", async (req: Request, res: Response) => {
  try {
    const { name, description, mode, suiteIds, suites } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "invalid_request", message: "name is required" });
      return;
    }
    const m = parseMode(mode);
    if (m === null && mode !== undefined) {
      res.status(400).json({ error: "invalid_request", message: "mode must be sequential or parallel" });
      return;
    }
    const members = suites !== undefined ? parseMembers(suites, "suiteId") : suiteIds !== undefined ? parseMembers(suiteIds, "suiteId") : [];
    if (members === null) {
      res.status(400).json({ error: "invalid_request", message: "suites/suiteIds must be an array of {suiteId, parallel?} or positive ids" });
      return;
    }
    const store = getStore();
    for (const mem of members) {
      if (!store.getSuite(mem.id)) {
        res.status(400).json({ error: "invalid_request", message: `Suite #${mem.id} not found` });
        return;
      }
    }
    const train = store.createTrain({ name, description: description ?? null, mode: m ?? "sequential" });
    if (members.length > 0) store.setTrainSuites(train.id, members.map((mem) => ({ suiteId: mem.id, parallel: mem.parallel })));
    res.status(201).json({ train: trainPayload(store, train.id) });
  } catch (err) {
    logger.error({ err }, "queryfirst: create train failed");
    res.status(500).json({ error: "internal_error", message: "Failed to create train" });
  }
});

// GET /queryfirst/trains/:id
router.get("/trains/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const payload = trainPayload(store, Number(req.params.id));
    if (!payload) {
      res.status(404).json({ error: "not_found", message: `Train #${req.params.id} not found` });
      return;
    }
    res.json({ train: payload });
  } catch (err) {
    logger.error({ err }, "queryfirst: get train failed");
    res.status(500).json({ error: "internal_error", message: "Failed to get train" });
  }
});

// PATCH /queryfirst/trains/:id
router.patch("/trains/:id", async (req: Request, res: Response) => {
  try {
    const { name, description, mode } = req.body ?? {};
    const m = parseMode(mode);
    if (m === null && mode !== undefined) {
      res.status(400).json({ error: "invalid_request", message: "mode must be sequential or parallel" });
      return;
    }
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getTrain(id)) {
      res.status(404).json({ error: "not_found", message: `Train #${id} not found` });
      return;
    }
    store.updateTrain(id, {
      name: typeof name === "string" ? name : undefined,
      description: description === undefined ? undefined : description,
      mode: m ?? undefined,
    });
    res.json({ train: trainPayload(store, id) });
  } catch (err) {
    logger.error({ err }, "queryfirst: update train failed");
    res.status(500).json({ error: "internal_error", message: "Failed to update train" });
  }
});

// DELETE /queryfirst/trains/:id
router.delete("/trains/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getTrain(id)) {
      res.status(404).json({ error: "not_found", message: `Train #${id} not found` });
      return;
    }
    store.deleteTrain(id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "queryfirst: delete train failed");
    res.status(500).json({ error: "internal_error", message: "Failed to delete train" });
  }
});

// PUT /queryfirst/trains/:id/suites — replace member suites (order = position, per-member parallel flag)
router.put("/trains/:id/suites", async (req: Request, res: Response) => {
  try {
    const { suites, suiteIds } = req.body ?? {};
    const members = suites !== undefined ? parseMembers(suites, "suiteId") : suiteIds !== undefined ? parseMembers(suiteIds, "suiteId") : null;
    if (members === null) {
      res.status(400).json({ error: "invalid_request", message: "suites/suiteIds must be an array of {suiteId, parallel?} or positive ids" });
      return;
    }
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getTrain(id)) {
      res.status(404).json({ error: "not_found", message: `Train #${id} not found` });
      return;
    }
    for (const mem of members) {
      if (!store.getSuite(mem.id)) {
        res.status(400).json({ error: "invalid_request", message: `Suite #${mem.id} not found` });
        return;
      }
    }
    store.setTrainSuites(id, members.map((mem) => ({ suiteId: mem.id, parallel: mem.parallel })));
    res.json({ train: trainPayload(store, id) });
  } catch (err) {
    logger.error({ err }, "queryfirst: set train suites failed");
    res.status(500).json({ error: "internal_error", message: "Failed to set train suites" });
  }
});

// GET /queryfirst/trains/:id/runs — train run history
router.get("/trains/:id/runs", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getTrain(id)) {
      res.status(404).json({ error: "not_found", message: `Train #${id} not found` });
      return;
    }
    const runs = store.listTrainRuns(id);
    res.json({
      runs: runs.map((r) => ({
        id: r.id,
        trainId: r.trainId,
        status: r.status,
        mode: r.mode,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error instanceof Error ? r.error.message : r.error,
      })),
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: list train runs failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list train runs" });
  }
});

// POST /queryfirst/trains/:id/run — SSE: run the train (headless)
router.post("/trains/:id/run", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const trainId = Number(req.params.id);
  const store = getStore();
  const train = store.getTrainWithSuites(trainId);
  if (!train) {
    res.status(404).json({ error: "not_found", message: `Train #${trainId} not found` });
    return;
  }
  if (getBatch(authUser.id)) {
    sseHeaders(res);
    sseWrite(res, { event: "error", message: "A suite/train run is already in progress. Stop it first." });
    res.end();
    return;
  }

  const controller = new AbortController();
  batchRuns.set(authUser.id, { controller, kind: "train", entityId: trainId, name: train.name });
  sseHeaders(res);
  sseWrite(res, { event: "started", kind: "train", trainId, trainName: train.name });

  const suiteRunner = new SuiteRunner(store, {
    launch: async () => {
      const s = await BrowserSession.launch({ headless: true, timeoutMs: 20_000 });
      return { page: await s.newPage(), close: () => s.close() };
    },
    screenshotBaseDir: suiteScreenshotsDir(),
    concurrency: 4,
  });
  const runner = new TrainRunner(store, suiteRunner);

  try {
    const trainRun = await runner.runTrain(trainId, {
      signal: controller.signal,
      onEvent: (event: TrainRunnerEvent) => {
        sseWrite(res, { event: "train", ...event });
      },
    });
    sseWrite(res, {
      event: "done",
      kind: "train",
      trainRunId: trainRun.id,
      ok: trainRun.status === "passed",
      status: trainRun.status,
      error: trainRun.error !== null ? String(trainRun.error) : undefined,
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: train run failed");
    sseWrite(res, { event: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearBatch(authUser.id);
  }
  res.end();
});

// ----- run results & screenshots ---------------------------------------------

// GET /queryfirst/suite-runs — global suite-run history (newest first, paginated)
router.get("/suite-runs", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const page = store.listSuiteRunsPage({ limit, offset });
    res.json({
      runs: page.runs.map((r) => suiteRunSummary(store, r)),
      hasMore: page.hasMore,
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: list suite runs failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list suite runs" });
  }
});

// GET /queryfirst/train-runs — global train-run history (newest first, paginated)
router.get("/train-runs", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const page = store.listTrainRunsPage({ limit, offset });
    res.json({
      runs: page.runs.map((r) => trainRunSummary(store, r)),
      hasMore: page.hasMore,
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: list train runs failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list train runs" });
  }
});

// GET /queryfirst/test-runs/:runId — one test run with steps + screenshots
router.get("/test-runs/:runId", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const run = store.getRunWithSteps(Number(req.params.runId));
    if (!run) {
      res.status(404).json({ error: "not_found", message: `Test run #${req.params.runId} not found` });
      return;
    }
    const test = store.getTest(run.testId);
    const intentByIdx = new Map(store.listStepsByTest(run.testId).map((s) => [s.idx, s]));
    const steps = run.steps.map((rs) => ({
      idx: rs.idx,
      status: rs.status,
      intent: intentByIdx.has(rs.idx) ? stepToEnglish(intentByIdx.get(rs.idx)!) : null,
      detail: rs.detail ?? null,
    }));
    const screenshots = run.suiteRunId !== null
      ? listScreenshotsForTestRun(run.suiteRunId, run.testId, run.id)
      : [];
    res.json({
      run: {
        runId: run.id,
        testId: run.testId,
        testName: test?.name ?? `Test #${run.testId}`,
        suiteRunId: run.suiteRunId,
        status: run.status,
        llmCalls: run.llmCalls,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error instanceof Error ? run.error.message : run.error,
        steps,
        screenshots,
      },
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: get test run failed");
    res.status(500).json({ error: "internal_error", message: "Failed to get test run" });
  }
});

// GET /queryfirst/train-runs/:id/suites — suite runs of a train run (summary only)
router.get("/train-runs/:id/suites", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getTrainRun(id)) {
      res.status(404).json({ error: "not_found", message: `Train run #${id} not found` });
      return;
    }
    const loaded = store.getTrainRunWithSuiteRuns(id);
    res.json({ suiteRuns: loaded.suiteRuns.map((sr) => suiteRunSummary(store, sr)) });
  } catch (err) {
    logger.error({ err }, "queryfirst: list train run suites failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list train run suites" });
  }
});

// GET /queryfirst/suite-runs/:id — suite run with member test runs
router.get("/suite-runs/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const payload = suiteRunPayload(store, Number(req.params.id));
    if (!payload) {
      res.status(404).json({ error: "not_found", message: `Suite run #${req.params.id} not found` });
      return;
    }
    res.json({ suiteRun: payload });
  } catch (err) {
    logger.error({ err }, "queryfirst: get suite run failed");
    res.status(500).json({ error: "internal_error", message: "Failed to get suite run" });
  }
});

// GET /queryfirst/train-runs/:id — train run with nested suite runs
router.get("/train-runs/:id", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getTrainRun(id)) {
      res.status(404).json({ error: "not_found", message: `Train run #${req.params.id} not found` });
      return;
    }
    res.json({ trainRun: trainRunPayload(store, id) });
  } catch (err) {
    logger.error({ err }, "queryfirst: get train run failed");
    res.status(500).json({ error: "internal_error", message: "Failed to get train run" });
  }
});

// GET /queryfirst/suite-runs/:id/screenshots — list persisted step screenshots
router.get("/suite-runs/:id/screenshots", async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const id = Number(req.params.id);
    if (!store.getSuiteRun(id)) {
      res.status(404).json({ error: "not_found", message: `Suite run #${req.params.id} not found` });
      return;
    }
    const files = listSuiteScreenshots(id);
    res.json({
      screenshots: files.map((f) => ({
        path: f,
        url: `/api/queryfirst/suite-runs/${id}/screenshots/${f}`,
      })),
    });
  } catch (err) {
    logger.error({ err }, "queryfirst: list suite screenshots failed");
    res.status(500).json({ error: "internal_error", message: "Failed to list suite screenshots" });
  }
});

// GET /queryfirst/suite-runs/:id/screenshots/:testId/:file — serve a persisted screenshot
router.get("/suite-runs/:id/screenshots/:testId/:file", async (req: Request, res: Response) => {
  const suiteRunId = Number(req.params.id);
  const testId = req.params.testId as string;
  const file = req.params.file as string;
  if (!/^[A-Za-z0-9._-]+$/.test(testId) || !/^[A-Za-z0-9._-]+$/.test(file)) {
    res.status(400).json({ error: "invalid_path", message: "Invalid screenshot path" });
    return;
  }
  const rel = `${testId}/${file}`;
  const root = resolve(suiteScreenshotsDir(), String(suiteRunId));
  res.sendFile(rel, { root });
});

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
    const google = detectGoogleSignIn({ query, url: entry_url });
    browserSession = await BrowserSession.launch({
      headless: isHeadlessServer ? true : !google, // headful for Google sign-in
      timeoutMs: 30_000,
      ...(google
        ? { pipe: true, chromePath: resolveGoogleChromePath() }
        : process.env.QF_CHROME_PATH && process.env.QF_CHROME_PATH !== "auto"
          ? { chromePath: process.env.QF_CHROME_PATH }
          : {}),
    });
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
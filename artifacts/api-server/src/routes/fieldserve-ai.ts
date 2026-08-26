import { Router, type IRouter, type Request, type Response } from "express";
import { requireSignedUp } from "../middlewares/auth";
import { logger } from "../lib/logger";
import OpenAI from "openai";
import { db } from "@workspace/db";
import { userApiKeysTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { decryptKey } from "../lib/crypto";
import { getOrCreateUser } from "../lib/auth";

const router: IRouter = Router();
router.use(requireSignedUp);

export const API_SPEC = `
FieldServe API — Base URL: /api/fieldserve
Auth: Bearer token (Supabase JWT) in Authorization header.

Resources:
- Jobs: CRUD + state machine transitions
- Engineers: CRUD + history
- Sites: CRUD
- Dashboard: stats, overdue

Endpoints:
GET    /jobs                          List jobs (?status, ?engineer_id, ?site_id, ?priority, ?page, ?limit, ?sort, ?order)
GET    /jobs/:id                      Get job with site, engineer, updates, attachments
POST   /jobs                          Create job (body: title, siteId, skillRequired, priority?, description?, scheduledDate?, estimatedDuration?, slaDeadline?)
PATCH  /jobs/:id                      Update job (partial body)
DELETE /jobs/:id                      Delete job (only status=created)

POST   /jobs/:id/schedule             Schedule job (created → scheduled)

POST   /jobs/:id/assign               Assign engineer (body: engineerId, notes?)
POST   /jobs/:id/dispatch             Dispatch (body: notes?)
POST   /jobs/:id/en-route             En route (body: notes?)
POST   /jobs/:id/on-site              On site (body: notes?, lat?, lng?)
POST   /jobs/:id/check-in             Check in (body: notes?)
POST   /jobs/:id/grant-access         Grant access (body: notes?)
POST   /jobs/:id/equipment-received   Equipment received (body: notes?)
POST   /jobs/:id/start-work           Start work (body: notes?)
POST   /jobs/:id/hold                 Put on hold (body: notes — required)
POST   /jobs/:id/resume               Resume work (body: notes?)
POST   /jobs/:id/complete             Complete (body: notes?)
POST   /jobs/:id/fail                 Fail (body: notes — required)
POST   /jobs/:id/cancel               Cancel (body: notes — required)
POST   /jobs/:id/defer                Defer (body: notes — required)

GET    /engineers                     List engineers (?skill, ?status, ?available=true)
GET    /engineers/:id                 Get engineer with active job
POST   /engineers                     Create (body: firstName, lastName, email, employeeId, skills?)
PATCH  /engineers/:id                 Update (body: firstName, lastName, email, status, skills?)
GET    /engineers/:id/history         Past jobs

GET    /sites                         List sites
GET    /sites/:id                     Get site
POST   /sites                         Create (body: name, address, city, postcode, lat?, lng?, accessInstructions?, contactName?, contactPhone?)

GET    /jobs/:id/updates              Job update history
POST   /jobs/:id/updates              Add update (body: status, engineerId?, notes?, lat?, lng?)
GET    /jobs/:id/attachments          List attachments
POST   /jobs/:id/attachments          Add attachment (body: fileName, fileType, fileSize, engineerId?)

GET    /dashboard/stats               Aggregate stats
GET    /dashboard/overdue             Overdue jobs
POST   /seed                          Seed demo data
POST   /reset                         Clear all data
GET    /health                        Health check

Job statuses (in order): created, scheduled, assigned, engineer-dispatched, en-route, on-site, checking-in, waiting-for-access, waiting-for-equipment, in-progress, on-hold, completed, failed, cancelled, deferred, facility-not-accessible, parts-required, requires-rescheduling
Priorities: critical, high, medium, low
Engineer skills: electrical, plumbing, hvac, fire-safety, general-maintenance
Engineer statuses: available, busy, on-leave

Valid transitions:
created → scheduled | cancelled
scheduled → assigned | cancelled
assigned → engineer-dispatched | cancelled
engineer-dispatched → en-route | cancelled
en-route → on-site | cancelled
on-site → checking-in | cancelled
checking-in → waiting-for-access | waiting-for-equipment | in-progress
waiting-for-access → waiting-for-equipment | in-progress | facility-not-accessible
waiting-for-equipment → in-progress | parts-required
in-progress → on-hold | completed | failed
on-hold → in-progress | cancelled
completed → (terminal)
failed → requires-rescheduling
cancelled → (terminal)
deferred → created
facility-not-accessible → requires-rescheduling | cancelled
parts-required → in-progress | cancelled
requires-rescheduling → created | cancelled
`;

interface TestCase {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  expectedStatus: number;
  assertions: { target: string; operator: string; expected: string }[];
}

router.post("/generate", async (req: Request, res: Response) => {
  const authUser = req.user!;
  const { prompt, model_provider } = req.body ?? {};

  if (!prompt) {
    res.status(400).json({ error: "invalid_request", message: "prompt is required" });
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
  if (!match) {
    res.status(400).json({ error: "no_api_key", message: `No ${provider} API key configured. Add one in Settings.` });
    return;
  }
  const apiKey = decryptKey(JSON.parse(match.encryptedKey));

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const client = new OpenAI({ apiKey });

  try {
    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an API test case generator. Given the FieldServe API specification and a user's description of what to test, generate a JSON array of test cases.

Each test case must be a JSON object with this exact schema:
{
  "name": "string — short descriptive name",
  "method": "GET|POST|PATCH|DELETE",
  "path": "string — relative path like /jobs, /jobs/1/assign",
  "headers": {},
  "body": "string — JSON body matching the API spec, or empty string for GET/DELETE",
  "expectedStatus": number,
  "assertions": [
    { "target": "string — json path like $.job.status or $.error", "operator": "equals|contains|exists|matches", "expected": "string" }
  ]
}

Rules:
- Use the API spec to construct correct request bodies with proper field names, types, and required fields
- Follow the state machine transitions for workflow tests
- Test both valid paths and error cases (missing required fields, invalid transitions, non-existent IDs)
- Use realistic IDs (1-5 for jobs, 1-10 for engineers, 1-5 for sites) assuming seed data is loaded
- Return ONLY the JSON array, no markdown fences, no explanation
- Generate 5-20 test cases based on the user's request
- Do not include auth headers — they are added automatically.`,
        },
        { role: "user", content: `API Spec:\n${API_SPEC}\n\nUser request: ${prompt}` },
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

    // Parse the complete response as JSON
    let testCases: TestCase[] = [];
    try {
      // Try to extract JSON array from the response
      const jsonMatch = fullContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        testCases = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      logger.warn({ err: parseErr }, "fieldserve-ai: failed to parse LLM response as JSON");
    }

    res.write(JSON.stringify({ type: "done", testCases }) + "\n");
    res.end();
  } catch (err) {
    logger.error({ err }, "fieldserve-ai: generation failed");
    res.write(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "Generation failed" }) + "\n");
    res.end();
  }
});

export default router;

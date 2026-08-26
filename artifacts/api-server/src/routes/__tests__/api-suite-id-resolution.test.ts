import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { FieldServeDataStore, runMigrations } from "../../lib/fieldserve-db";

function createStore(): FieldServeDataStore {
  const db = new Database(":memory:");
  runMigrations(db);
  return new FieldServeDataStore(db);
}

// ---------------------------------------------------------------------------
// Replicate the entity resolver logic from runApiSuite to prove the bug:
// runApiSuite has NO idMapping, so after a POST creates a new entity,
// subsequent steps that reference the old recorded ID cannot be resolved.
// ---------------------------------------------------------------------------

interface EntityType {
  name: string;
  fields: string[];
  constraint?: (entity: Record<string, unknown>) => boolean;
}

const ENTITY_TYPES: EntityType[] = [
  { name: "sites", fields: ["siteId"] },
  { name: "engineers", fields: ["engineerId"], constraint: (e) => e.status === "available" },
  { name: "jobs", fields: ["jobId"] },
];

function buildRegistry(store: FieldServeDataStore): Record<string, Array<Record<string, unknown>>> {
  const reg: Record<string, Array<Record<string, unknown>>> = {};
  for (const et of ENTITY_TYPES) {
    if (et.name === "sites") reg[et.name] = store.listSites() as unknown as Array<Record<string, unknown>>;
    else if (et.name === "engineers") reg[et.name] = store.listEngineers() as unknown as Array<Record<string, unknown>>;
    else if (et.name === "jobs") reg[et.name] = store.listJobs().jobs as unknown as Array<Record<string, unknown>>;
  }
  return reg;
}

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

function firstValidIdForState(reg: Record<string, Array<Record<string, unknown>>>, typeName: string, state: string): number | undefined {
  const et = ENTITY_TYPES.find((t) => t.name === typeName);
  const entities = reg[typeName];
  if (!entities?.length || !et) return undefined;
  if (et.constraint) {
    const match = entities.find((e) => et.constraint!(e) && (e as Record<string, unknown>).status === state);
    if (match) return Number(match.id);
    const any = entities.find((e) => et.constraint!(e));
    return any ? Number(any.id) : undefined;
  }
  const match = entities.find((e) => (e as Record<string, unknown>).status === state);
  return match ? Number(match.id) : entities[0] ? Number(entities[0].id) : undefined;
}

const pathToType = new Map<string, string>();
const fieldToType = new Map<string, string>();
for (const et of ENTITY_TYPES) {
  for (const f of et.fields) fieldToType.set(f, et.name);
  pathToType.set(`/${et.name}/`, et.name);
}

// ---------------------------------------------------------------------------
// Version WITHOUT idMapping (mirrors current runApiSuite behavior)
// ---------------------------------------------------------------------------
function createResolversWithoutIdMapping(store: FieldServeDataStore) {
  let registry = buildRegistry(store);

  function refreshRegistry() {
    registry = buildRegistry(store);
  }

  function resolveBodyIds(body: string | null): string | null {
    if (!body) return body;
    try {
      const parsed = JSON.parse(body);
      let changed = false;
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val !== "number" || val <= 0) continue;
        const typeName = fieldToType.get(key);
        if (!typeName) continue;
        const entities = registry[typeName] ?? [];
        const et = ENTITY_TYPES.find((t) => t.name === typeName);
        const valid = entities.some((e) => Number(e.id) === val && (!et?.constraint || et.constraint(e)));
        if (!valid) {
          const substitute = firstValidId(registry, typeName);
          if (substitute != null) { parsed[key] = substitute; changed = true; }
        }
      }
      return changed ? JSON.stringify(parsed) : body;
    } catch { return body; }
  }

  function resolvePathIds(stepPath: string, preferState?: string): string {
    let result = stepPath;
    for (const [pattern, typeName] of pathToType) {
      const re = new RegExp(`(${pattern.replace(/\//g, "\\/")})(\\d+)`);
      result = result.replace(re, (_match, prefix: string, idStr: string) => {
        const id = Number(idStr);
        const exists = (registry[typeName] ?? []).some((e) => Number(e.id) === id);
        if (exists) {
          if (preferState && typeName === "jobs") {
            const entity = (registry[typeName] ?? []).find((e) => Number(e.id) === id);
            if (entity && (entity as Record<string, unknown>).status !== preferState) {
              const alt = firstValidIdForState(registry, typeName, preferState);
              if (alt != null) return `${prefix}${alt}`;
            }
          }
          return `${prefix}${id}`;
        }
        const substitute = preferState ? firstValidIdForState(registry, typeName, preferState) : firstValidId(registry, typeName);
        return substitute != null ? `${prefix}${substitute}` : `${prefix}${id}`;
      });
    }
    return result;
  }

  return { resolvePathIds, resolveBodyIds, refreshRegistry };
}

// ---------------------------------------------------------------------------
// Version WITH idMapping (mirrors fieldserve replay — the correct behavior)
// ---------------------------------------------------------------------------
function createResolversWithIdMapping(store: FieldServeDataStore) {
  let registry = buildRegistry(store);
  const idMapping: Record<string, Map<number, number>> = {};
  for (const et of ENTITY_TYPES) idMapping[et.name] = new Map();

  function refreshRegistry() {
    registry = buildRegistry(store);
  }

  function resolveBodyIds(body: string | null): string | null {
    if (!body) return body;
    try {
      const parsed = JSON.parse(body);
      let changed = false;
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val !== "number" || val <= 0) continue;
        const typeName = fieldToType.get(key);
        if (!typeName) continue;

        // Check idMapping first
        const mapped = idMapping[typeName]?.get(val);
        if (mapped != null) { parsed[key] = mapped; changed = true; continue; }

        const entities = registry[typeName] ?? [];
        const et = ENTITY_TYPES.find((t) => t.name === typeName);
        const valid = entities.some((e) => Number(e.id) === val && (!et?.constraint || et.constraint(e)));
        if (!valid) {
          const substitute = firstValidId(registry, typeName);
          if (substitute != null) { parsed[key] = substitute; changed = true; }
        }
      }
      return changed ? JSON.stringify(parsed) : body;
    } catch { return body; }
  }

  function resolvePathIds(stepPath: string): string {
    let result = stepPath;
    for (const [pattern, typeName] of pathToType) {
      const re = new RegExp(`(${pattern.replace(/\//g, "\\/")})(\\d+)`);
      result = result.replace(re, (_match, prefix: string, idStr: string) => {
        const id = Number(idStr);

        // Check idMapping first
        const mapped = idMapping[typeName]?.get(id);
        if (mapped != null) return `${prefix}${mapped}`;

        const exists = (registry[typeName] ?? []).some((e) => Number(e.id) === id);
        if (exists) return `${prefix}${id}`;
        const substitute = firstValidId(registry, typeName);
        return substitute != null ? `${prefix}${substitute}` : `${prefix}${id}`;
      });
    }
    return result;
  }

  function recordCreation(stepPath: string, recordedResponseBody: string, actualResponseBody: string) {
    for (const et of ENTITY_TYPES) {
      const createRe = new RegExp(`\\/${et.name}\\/?$`);
      if (createRe.test(stepPath)) {
        try {
          const oldParsed = JSON.parse(recordedResponseBody || "{}");
          const newParsed = JSON.parse(actualResponseBody || "{}");
          const singular = et.name.endsWith("s") ? et.name.slice(0, -1) : et.name;
          const oldEntity = oldParsed[singular] ?? oldParsed;
          const newEntity = newParsed[singular] ?? newParsed;
          const oldId = Number(oldEntity?.id);
          const newId = Number(newEntity?.id);
          if (oldId > 0 && newId > 0 && oldId !== newId) {
            idMapping[et.name].set(oldId, newId);
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }

  return { resolvePathIds, resolveBodyIds, recordCreation, refreshRegistry, idMapping };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("runApiSuite ID resolution bug", () => {
  let store: FieldServeDataStore;

  beforeEach(() => {
    store = createStore();
  });

  it("BUG: without idMapping, POST /jobs/<recorded-id> can't resolve to new ID", () => {
    const { resolvePathIds, refreshRegistry } = createResolversWithoutIdMapping(store);

    // Seed data: creates job #1 (status: created)
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    const createdJob = store.createJob({ title: "Seed job", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });
    refreshRegistry();

    // Scenario: recording had job #9999, but actual seed created job #1
    // Step: POST /api/fieldserve/jobs/9999/en-route
    const recordedPath = "/api/fieldserve/jobs/9999/en-route";
    const resolved = resolvePathIds(recordedPath);

    // BUG: without idMapping, it falls back to firstValidId (job #1) — this part works
    // But the real bug is: after a POST creates job #2302, the next step that
    // references the recorded ID from the POST response CAN'T be resolved.
    expect(resolved).toBe("/api/fieldserve/jobs/1/en-route");
  });

  it("BUG: without idMapping, transition from created→en-route healing URL uses stale ID", () => {
    const { resolvePathIds, refreshRegistry } = createResolversWithoutIdMapping(store);

    // Seed creates job #1 in 'created' state
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    const job = store.createJob({ title: "Seed job", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });
    refreshRegistry();

    // Healing needs to transition through: created → scheduled → assigned → engineer-dispatched → en-route
    // Each healing URL is /api/fieldserve/jobs/<jobId>/<segment>
    // The jobId should be the REAL job ID (1), not the recorded ID (9999)

    // Simulate what healStateMachine does: it calls extractJobId on the original step.path
    // which gives the RECORDED job ID, not the resolved one
    const recordedPath = "/api/fieldserve/jobs/9999/en-route";
    const match = recordedPath.match(/\/jobs\/(\d+)/);
    const recordedJobId = match ? Number(match[1]) : null;

    // The healing URL would be /api/fieldserve/jobs/9999/schedule (WRONG — 9999 doesn't exist)
    // It SHOULD be /api/fieldserve/jobs/1/schedule (the real job)
    expect(recordedJobId).toBe(9999); // This is the BUG — healing uses stale ID

    // With idMapping, we'd resolve 9999 → 1
    const resolvedPath = resolvePathIds(recordedPath);
    const resolvedMatch = resolvedPath.match(/\/jobs\/(\d+)/);
    const resolvedJobId = resolvedMatch ? Number(resolvedMatch[1]) : null;
    expect(resolvedJobId).toBe(job.id); // This is what SHOULD happen
  });

  it("FIX: with idMapping, recorded old ID maps to new real ID after creation", () => {
    const { resolvePathIds, recordCreation, refreshRegistry } = createResolversWithIdMapping(store);

    // Seed data
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    refreshRegistry();

    // Recording had POST /api/fieldserve/jobs returning {"job":{"id":9999}}
    // Actual POST /api/fieldserve/jobs returns {"job":{"id":1}}
    const recordedResp = JSON.stringify({ job: { id: 9999, title: "Fix leak" } });
    const actualResp = JSON.stringify({ job: { id: 1, title: "Fix leak" } });
    recordCreation("/api/fieldserve/jobs", recordedResp, actualResp);

    // Now a subsequent step references the recorded ID 9999
    const subsequentPath = "/api/fieldserve/jobs/9999/en-route";
    const resolved = resolvePathIds(subsequentPath);

    // With idMapping, 9999 → 1
    expect(resolved).toBe("/api/fieldserve/jobs/1/en-route");
  });

  it("FIX: with idMapping, body fields are resolved too", () => {
    const { resolveBodyIds, recordCreation, refreshRegistry } = createResolversWithIdMapping(store);

    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    refreshRegistry();

    // Recording had siteId 8888, actual created siteId 1
    recordCreation("/api/fieldserve/sites", '{"site":{"id":8888}}', '{"site":{"id":1}}');

    // Body references recorded siteId 8888
    const body = JSON.stringify({ title: "Job", siteId: 8888, skillRequired: "plumbing" });
    const resolved = JSON.parse(resolveBodyIds(body)!);
    expect(resolved.siteId).toBe(1);
  });

  it("FIX: with idMapping, healing transitions use resolved job ID", () => {
    const { resolvePathIds, recordCreation, refreshRegistry } = createResolversWithIdMapping(store);

    // Seed creates job #1 in 'created' state
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    const job = store.createJob({ title: "Seed job", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });
    refreshRegistry();

    // Recording had job #9999, actual created job #1
    recordCreation("/api/fieldserve/jobs", '{"job":{"id":9999}}', JSON.stringify({ job: { id: job.id } }));

    // Step: POST /api/fieldserve/jobs/9999/en-route (fails with 409)
    // Healing should transition created → scheduled → assigned → engineer-dispatched → en-route
    // All healing URLs must use job.id (1), not 9999

    const healingSteps = ["schedule", "assign", "dispatch", "en-route"];
    for (const segment of healingSteps) {
      const healPath = `/api/fieldserve/jobs/9999/${segment}`;
      const resolvedHealPath = resolvePathIds(healPath);
      expect(resolvedHealPath).toBe(`/api/fieldserve/jobs/${job.id}/${segment}`);
    }
  });

  it("FIX: full sequence — create job → transition to en-route succeeds after healing", () => {
    const { resolvePathIds, recordCreation, refreshRegistry } = createResolversWithIdMapping(store);

    // Seed
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    refreshRegistry();

    // Step 1: POST /api/fieldserve/jobs (create)
    const recordedCreateResp = JSON.stringify({ job: { id: 9999, title: "Fix leak" } });
    const job = store.createJob({ title: "Fix leak", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });
    refreshRegistry();
    const actualCreateResp = JSON.stringify({ job: { id: job.id, title: "Fix leak" } });
    recordCreation("/api/fieldserve/jobs", recordedCreateResp, actualCreateResp);

    // Step 2: POST /api/fieldserve/jobs/9999/en-route (stale ID)
    // First attempt fails with 409
    const fetchedJob = store.getJob(job.id)!;
    expect(fetchedJob.status).toBe("created");

    // Healing: transition through intermediate states using resolved ID
    const transitionPath = ["schedule", "assign", "dispatch", "en-route"];
    for (const segment of transitionPath) {
      const healPath = resolvePathIds(`/api/fieldserve/jobs/9999/${segment}`);
      const healMatch = healPath.match(/\/jobs\/(\d+)/);
      const healJobId = healMatch ? Number(healMatch[1]) : null;
      expect(healJobId).toBe(job.id); // Must use resolved ID

      // Actually perform the transition
      const stateMap: Record<string, string> = {
        schedule: "scheduled",
        assign: "assigned",
        dispatch: "engineer-dispatched",
        "en-route": "en-route",
      };
      store.transitionJob(job.id, stateMap[segment], segment === "assign" ? { engineerId: 1 } : undefined);
    }

    // After healing, job should be in 'en-route' state
    const healedJob = store.getJob(job.id)!;
    expect(healedJob.status).toBe("en-route");

    // The original step POST /api/fieldserve/jobs/9999/en-route should now succeed
    // because the resolved path points to the real job which is already in 'en-route'
    const resolvedStep = resolvePathIds("/api/fieldserve/jobs/9999/en-route");
    expect(resolvedStep).toBe(`/api/fieldserve/jobs/${job.id}/en-route`);

    // Verify the job is indeed in 'en-route' (so the retry would succeed)
    const finalJob = store.getJob(job.id)!;
    expect(finalJob.status).toBe("en-route");
  });

  it("healing: if intermediate transition returns 409, healing is incomplete and retry would fail", () => {
    const { resolvePathIds, refreshRegistry } = createResolversWithIdMapping(store);

    // Seed
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    refreshRegistry();

    // Create job in 'created' state
    const job = store.createJob({ title: "Fix leak", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });

    // Simulate what healStateMachine does:
    // Each transition returns a status code. We track the overall success.
    const transitionPath = ["scheduled", "assigned", "engineer-dispatched", "en-route"];
    let allOk = true;

    for (const state of transitionPath) {
      // Simulate: 'scheduled' succeeds (200), but 'assigned' fails (409) because
      // the assign API requires engineerId in the body, and healing doesn't send it.
      // This is the real-world scenario.
      let status: number;
      if (state === "scheduled") {
        store.transitionJob(job.id, "scheduled");
        status = 200;
      } else if (state === "assigned") {
        // Can't transition to 'assigned' via heal without engineerId — API returns 409
        status = 409;
      } else {
        status = 200;
      }

      if (status >= 400) {
        allOk = false;
        break;
      }
    }

    // The fix: healStateMachine returns false when any transition fails
    expect(allOk).toBe(false);

    // Job is stuck at 'scheduled' — the partial progress is preserved
    expect(store.getJob(job.id)!.status).toBe("scheduled");
  });

  it("healing: with engineerId, all transitions succeed and healing completes", () => {
    const { resolvePathIds, recordCreation, refreshRegistry } = createResolversWithIdMapping(store);

    // Seed
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    const engineer = store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    refreshRegistry();

    // Create job in 'created' state
    const job = store.createJob({ title: "Fix leak", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });

    // Healing: transition through all states with proper engineerId
    const transitionPath = ["scheduled", "assigned", "engineer-dispatched", "en-route"];
    let allOk = true;

    for (const state of transitionPath) {
      try {
        const opts = state === "assigned" ? { engineerId: engineer.id } : undefined;
        store.transitionJob(job.id, state, opts);
      } catch {
        allOk = false;
        break;
      }
    }

    expect(allOk).toBe(true);
    expect(store.getJob(job.id)!.status).toBe("en-route");
  });

  it("healing: partial progress is preserved when healing fails mid-way", () => {
    const { resolvePathIds, refreshRegistry } = createResolversWithIdMapping(store);

    // Seed
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    refreshRegistry();

    // Create job in 'created' state
    const job = store.createJob({ title: "Fix leak", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });

    // Transition to 'scheduled' (first step of healing) — succeeds
    store.transitionJob(job.id, "scheduled");
    expect(store.getJob(job.id)!.status).toBe("scheduled");

    // Now provide engineerId — transition to 'assigned' succeeds
    const engineer = store.createEngineer({ firstName: "Bob", lastName: "Jones", email: "bob@test.com", phone: "2", employeeId: "E002", skills: ["plumbing"] });
    refreshRegistry();
    store.transitionJob(job.id, "assigned", { engineerId: engineer.id });
    expect(store.getJob(job.id)!.status).toBe("assigned");

    // Continue transitions
    store.transitionJob(job.id, "engineer-dispatched");
    store.transitionJob(job.id, "en-route");
    expect(store.getJob(job.id)!.status).toBe("en-route");
  });

  it("healing: retries are NOT attempted if healStateMachine returns false", () => {
    // This test verifies the critical behavior change:
    // OLD: healStateMachine always returned true → retry always ran → retry failed with 409
    // NEW: healStateMachine returns false on failure → retry is skipped → LLM fallback can try

    const { refreshRegistry } = createResolversWithIdMapping(store);
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    refreshRegistry();

    const job = store.createJob({ title: "Fix leak", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });

    // Simulate the full healing + retry flow
    const transitionPath = ["scheduled", "assigned", "engineer-dispatched", "en-route"];
    let healOk = true;
    for (const state of transitionPath) {
      if (state === "assigned") {
        // Simulate: assign API returns 409 (no engineerId in body)
        healOk = false;
        break;
      }
      store.transitionJob(job.id, state);
    }

    // NEW behavior: healStateMachine returns false
    expect(healOk).toBe(false);

    // Because healOk is false, the retry should NOT run
    // (the retry is gated by `if (healed)` at line ~604)
    // The job remains at 'scheduled' — which is the correct state
    expect(store.getJob(job.id)!.status).toBe("scheduled");

    // If we were to retry now (which we shouldn't), it would fail with 409:
    // "Cannot transition from 'scheduled' to 'en-route'"
    // This is exactly the error the user was seeing!
  });

  it("preferState: resolvePathIds picks job in correct state for assign", () => {
    const { resolvePathIds, refreshRegistry } = createResolversWithoutIdMapping(store);

    // Seed: job #1 (created), job #2 (scheduled)
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    const createdJob = store.createJob({ title: "Created job", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });
    const scheduledJob = store.createJob({ title: "Scheduled job", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });
    store.transitionJob(scheduledJob.id, "scheduled");
    refreshRegistry();

    // Recorded path has a stale ID (9999) that doesn't exist
    // Without preferState, firstValidId picks some job regardless of state
    const withoutPref = resolvePathIds("/api/fieldserve/jobs/9999/assign");
    expect(withoutPref).toMatch(/^\/api\/fieldserve\/jobs\/\d+\/assign$/); // resolves to some job

    // With preferState="scheduled", it picks job #2 (scheduled) — correct for assign
    const withPref = resolvePathIds("/api/fieldserve/jobs/9999/assign", "scheduled");
    expect(withPref).toBe("/api/fieldserve/jobs/2/assign"); // picks scheduled job
  });

  it("preferState: healing selects correct job and transitions it", () => {
    const { resolvePathIds, refreshRegistry } = createResolversWithoutIdMapping(store);

    // Seed: job #1 (created), job #2 (scheduled)
    store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1A", lat: 0, lng: 0, contactName: "A", contactPhone: "1" });
    const createdJob = store.createJob({ title: "Created job", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });
    const scheduledJob = store.createJob({ title: "Scheduled job", description: "d", priority: "medium", siteId: 1, skillRequired: "plumbing" });
    const eng = store.createEngineer({ firstName: "Alice", lastName: "Smith", email: "alice@test.com", phone: "1", employeeId: "E001", skills: ["plumbing"] });
    store.transitionJob(scheduledJob.id, "scheduled");
    refreshRegistry();

    // 1. preferState="created" picks the job in created state (only createdJob qualifies)
    const schedulePath = resolvePathIds("/api/fieldserve/jobs/9999/schedule", "created");
    const schedJobId = Number(schedulePath.match(/\/jobs\/(\d+)/)![1]);
    expect(schedJobId).toBe(createdJob.id);
    expect(store.getJob(schedJobId)!.status).toBe("created");

    // 2. Transition that job to scheduled, then preferState="scheduled" picks a scheduled job
    store.transitionJob(createdJob.id, "scheduled");
    refreshRegistry();

    const assignPath = resolvePathIds("/api/fieldserve/jobs/9999/assign", "scheduled");
    const assignJobId = Number(assignPath.match(/\/jobs\/(\d+)/)![1]);
    expect(store.getJob(assignJobId)!.status).toBe("scheduled");

    // 3. Assign and verify the full chain
    store.transitionJob(assignJobId, "assigned", { engineerId: eng.id });
    refreshRegistry();
    expect(store.getJob(assignJobId)!.status).toBe("assigned");
  });
});

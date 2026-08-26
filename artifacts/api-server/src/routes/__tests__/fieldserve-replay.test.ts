import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { FieldServeDataStore, runMigrations } from "../../lib/fieldserve-db";

// ---------------------------------------------------------------------------
// Helper: create an in-memory FieldServeDataStore
// ---------------------------------------------------------------------------
function createStore(): FieldServeDataStore {
  const db = new Database(":memory:");
  runMigrations(db);
  return new FieldServeDataStore(db);
}

// ---------------------------------------------------------------------------
// Replicate the entity resolver logic from the replay handler so we can
// test it in isolation without starting an HTTP server.
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
    else if (et.name === "jobs") reg[et.name] = (store.listJobs().jobs) as unknown as Array<Record<string, unknown>>;
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

function createResolvers(store: FieldServeDataStore) {
  let registry = buildRegistry(store);

  const idMapping: Record<string, Map<number, number>> = {};
  for (const et of ENTITY_TYPES) idMapping[et.name] = new Map();

  function refreshRegistry() {
    registry = buildRegistry(store);
  }

  const fieldToType = new Map<string, string>();
  for (const et of ENTITY_TYPES) {
    for (const f of et.fields) fieldToType.set(f, et.name);
  }

  const pathToType = new Map<string, string>();
  for (const et of ENTITY_TYPES) {
    pathToType.set(`/${et.name}/`, et.name);
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

        const mapped = idMapping[typeName]?.get(val);
        if (mapped != null) {
          parsed[key] = mapped;
          changed = true;
          continue;
        }

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

  function resolvePathIds(stepPath: string): string {
    let result = stepPath;
    for (const [pattern, typeName] of pathToType) {
      const re = new RegExp(`(${pattern.replace(/\//g, "\\/")})(\\d+)`);
      result = result.replace(re, (_match, prefix: string, idStr: string) => {
        const id = Number(idStr);
        const mapped = idMapping[typeName]?.get(id);
        if (mapped != null) return `${prefix}${mapped}`;
        const entities = registry[typeName] ?? [];
        const exists = entities.some((e) => Number(e.id) === id);
        if (exists) return `${prefix}${id}`;
        const substitute = firstValidId(registry, typeName);
        return substitute != null ? `${prefix}${substitute}` : `${prefix}${id}`;
      });
    }
    return result;
  }

  /** Simulate the ID-mapping update that runs after each successful POST. */
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
        break;
      }
    }
    refreshRegistry();
  }

  return { resolvePathIds, resolveBodyIds, recordCreation, refreshRegistry, idMapping, getRegistry: () => registry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FieldServe replay entity ID resolution", () => {
  let store: FieldServeDataStore;

  beforeEach(() => {
    store = createStore();
    store.reset();
    store.seed();
  });

  it("should map stale job ID to the newly created job ID", () => {
    const { resolvePathIds, recordCreation, idMapping } = createResolvers(store);

    // Simulate: recording created job 9999, but replay creates job with a different ID.
    // The recorded response wraps the entity: { "job": { "id": 9999, ... } }
    const recordedResponseBody = JSON.stringify({ job: { id: 9999, title: "Test Job", siteId: 1, skillRequired: "plumbing", status: "created" } });

    // Create a job through the real store to get the actual new ID
    const newJob = store.createJob({ title: "Test Job", siteId: 1, skillRequired: "plumbing" });
    const actualResponseBody = JSON.stringify({ job: newJob });

    // Record the creation mapping
    recordCreation("/api/fieldserve/jobs", recordedResponseBody, actualResponseBody);

    // Verify mapping was set
    expect(idMapping["jobs"].get(9999)).toBe(newJob.id);

    // Verify resolvePathIds uses the mapping
    const resolved = resolvePathIds(`/api/fieldserve/jobs/9999`);
    expect(resolved).toBe(`/api/fieldserve/jobs/${newJob.id}`);
  });

  it("should map stale site ID in request body", () => {
    const { resolveBodyIds, recordCreation, idMapping } = createResolvers(store);

    // Recording created site 8888, but replay creates site with real ID
    const recordedResponseBody = JSON.stringify({ site: { id: 8888, name: "HQ" } });
    const newSite = store.createSite({ name: "HQ", address: "123 Main", city: "London", postcode: "EC1" });
    const actualResponseBody = JSON.stringify({ site: newSite });

    recordCreation("/api/fieldserve/sites", recordedResponseBody, actualResponseBody);
    expect(idMapping["sites"].get(8888)).toBe(newSite.id);

    // A subsequent job creation body references the old site ID
    const body = JSON.stringify({ title: "Fix", siteId: 8888, skillRequired: "plumbing" });
    const resolved = resolveBodyIds(body);
    const parsed = JSON.parse(resolved!);
    expect(parsed.siteId).toBe(newSite.id);
  });

  it("should handle full replay sequence: create → transition → get", () => {
    const { resolvePathIds, resolveBodyIds, recordCreation } = createResolvers(store);

    // --- Get seeded data ---
    const sites = store.listSites();
    const engineers = store.listEngineers();
    const seededSite = sites[0];
    const seededEngineer = engineers.find((e) => e.status === "available")!;

    // --- Simulate recorded steps (stale IDs from a previous run) ---
    const recordedSteps = [
      { method: "POST", path: "/api/fieldserve/jobs", body: JSON.stringify({ title: "Fix leak", siteId: seededSite.id, skillRequired: "plumbing" }), recordedResponse: JSON.stringify({ job: { id: 9001, title: "Fix leak", siteId: seededSite.id, skillRequired: "plumbing", status: "created" } }) },
      { method: "POST", path: "/api/fieldserve/jobs/9001/schedule", body: null, recordedResponse: null },
      { method: "POST", path: "/api/fieldserve/jobs/9001/assign", body: JSON.stringify({ engineerId: seededEngineer.id }), recordedResponse: null },
      { method: "GET", path: "/api/fieldserve/jobs/9001", body: null, recordedResponse: null },
    ];

    // --- Step 1: POST /jobs → creates a new job ---
    const step1 = recordedSteps[0];
    const newJob = store.createJob({ title: "Fix leak", siteId: seededSite.id, skillRequired: "plumbing" });
    const actualResponse1 = JSON.stringify({ job: newJob });
    recordCreation(step1.path, step1.recordedResponse!, actualResponse1);

    // --- Step 2: POST /jobs/9001/schedule ---
    const step2 = recordedSteps[1];
    const resolvedPath2 = resolvePathIds(step2.path);
    expect(resolvedPath2).toBe(`/api/fieldserve/jobs/${newJob.id}/schedule`);

    // Actually transition the job through the state machine
    store.transitionJob(newJob.id, "scheduled");

    // --- Step 3: POST /jobs/9001/assign ---
    const step3 = recordedSteps[2];
    const resolvedPath3 = resolvePathIds(step3.path);
    expect(resolvedPath3).toBe(`/api/fieldserve/jobs/${newJob.id}/assign`);

    const resolvedBody3 = JSON.parse(resolveBodyIds(step3.body)!);
    expect(resolvedBody3.engineerId).toBe(seededEngineer.id);

    // Actually assign
    store.transitionJob(newJob.id, "assigned", { engineerId: seededEngineer.id });

    // --- Step 4: GET /jobs/9001 ---
    const step4 = recordedSteps[3];
    const resolvedPath4 = resolvePathIds(step4.path);
    expect(resolvedPath4).toBe(`/api/fieldserve/jobs/${newJob.id}`);

    // Verify the job is fetchable at the resolved path
    const fetchedJob = store.getJob(newJob.id);
    expect(fetchedJob).toBeDefined();
    expect(fetchedJob!.id).toBe(newJob.id);
    expect(fetchedJob!.title).toBe("Fix leak");
  });

  it("should map multiple creation steps (sites + jobs + engineers)", () => {
    const { resolvePathIds, recordCreation } = createResolvers(store);

    // Recording created site 7777 → replay creates real site
    const recordedSiteResp = JSON.stringify({ site: { id: 7777, name: "Old Site" } });
    const newSite = store.createSite({ name: "New Site", address: "456 Oak", city: "Manchester", postcode: "M1" });
    recordCreation("/api/fieldserve/sites", recordedSiteResp, JSON.stringify({ site: newSite }));

    // Recording created engineer 6666 → replay creates real engineer
    const recordedEngResp = JSON.stringify({ engineer: { id: 6666, firstName: "John" } });
    const newEng = store.createEngineer({ firstName: "Jane", lastName: "Doe", email: "jane@test.com", employeeId: "E001", skills: ["plumbing"] });
    recordCreation("/api/fieldserve/engineers", recordedEngResp, JSON.stringify({ engineer: newEng }));

    // Recording created job 5555 → replay creates real job
    const recordedJobResp = JSON.stringify({ job: { id: 5555, title: "Test" } });
    const newJob = store.createJob({ title: "Test", siteId: newSite.id, skillRequired: "plumbing" });
    recordCreation("/api/fieldserve/jobs", recordedJobResp, JSON.stringify({ job: newJob }));

    // All mappings should work simultaneously
    expect(resolvePathIds("/api/fieldserve/sites/7777")).toBe(`/api/fieldserve/sites/${newSite.id}`);
    expect(resolvePathIds("/api/fieldserve/engineers/6666")).toBe(`/api/fieldserve/engineers/${newEng.id}`);
    expect(resolvePathIds("/api/fieldserve/jobs/5555")).toBe(`/api/fieldserve/jobs/${newJob.id}`);
  });

  it("should NOT match creation endpoint when path has trailing ID segment", () => {
    const { recordCreation, idMapping } = createResolvers(store);

    // This is a transition endpoint, NOT a creation endpoint
    const recordedResp = JSON.stringify({ job: { id: 1234, status: "scheduled" } });
    recordCreation("/api/fieldserve/jobs/1234/schedule", recordedResp, recordedResp);

    // Should NOT create a mapping because /jobs/1234/schedule is not a creation endpoint
    expect(idMapping["jobs"].get(1234)).toBeUndefined();
  });
});

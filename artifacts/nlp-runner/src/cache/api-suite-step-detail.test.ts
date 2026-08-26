import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.js";
import { DataStore } from "./queries.js";

// ---------------------------------------------------------------------------
// In-memory DataStore for testing run-step detail persistence
// ---------------------------------------------------------------------------
function createStore(): DataStore {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) {
    for (const sql of m.sql) db.exec(sql);
  }
  return new DataStore(db);
}

describe("runApiSuite step detail — requestBody and responseBody persistence", () => {
  let store: DataStore;
  let testId: number;
  let runId: number;

  beforeEach(() => {
    store = createStore();
    const test = store.createTest({ name: "test-api-detail", source: "template" });
    testId = test.id;
    const run = store.createRun({ testId, status: "running" });
    runId = run.id;
  });

  it("POST step detail includes requestBody and responseBody", () => {
    const reqBody = JSON.stringify({ title: "Fix leak", siteId: 42 });
    const respBody = JSON.stringify({ job: { id: 2302, title: "Fix leak" } });

    store.addRunStep(runId, {
      idx: 0,
      status: "passed",
      detail: {
        method: "POST",
        path: "/api/fieldserve/jobs",
        status: 201,
        expected: 201,
        duration: 120,
        requestBody: reqBody,
        responseBody: respBody,
      },
    });

    const steps = store.listRunStepsByRun(runId);
    expect(steps).toHaveLength(1);
    const d = steps[0].detail as Record<string, unknown>;
    expect(d.method).toBe("POST");
    expect(d.requestBody).toBe(reqBody);
    expect(d.responseBody).toBe(respBody);
    expect(d.status).toBe(201);
    expect(d.expected).toBe(201);
    expect(d.duration).toBe(120);
  });

  it("GET step detail includes responseBody", () => {
    const respBody = JSON.stringify({ jobs: [{ id: 1, title: "Fix leak" }] });

    store.addRunStep(runId, {
      idx: 0,
      status: "passed",
      detail: {
        method: "GET",
        path: "/api/fieldserve/jobs",
        status: 200,
        expected: 200,
        duration: 45,
        requestBody: null,
        responseBody: respBody,
      },
    });

    const steps = store.listRunStepsByRun(runId);
    expect(steps).toHaveLength(1);
    const d = steps[0].detail as Record<string, unknown>;
    expect(d.method).toBe("GET");
    expect(d.requestBody).toBeNull();
    expect(d.responseBody).toBe(respBody);
  });

  it("GET step with empty responseBody stores empty string", () => {
    store.addRunStep(runId, {
      idx: 0,
      status: "passed",
      detail: {
        method: "GET",
        path: "/api/fieldserve/jobs",
        status: 200,
        expected: 200,
        duration: 30,
        requestBody: null,
        responseBody: "",
      },
    });

    const steps = store.listRunStepsByRun(runId);
    const d = steps[0].detail as Record<string, unknown>;
    expect(d.responseBody).toBe("");
  });

  it("failed step error detail includes requestBody", () => {
    const reqBody = JSON.stringify({ title: "Fix leak", siteId: 9999 });

    store.addRunStep(runId, {
      idx: 0,
      status: "failed",
      detail: {
        method: "POST",
        path: "/api/fieldserve/jobs",
        requestBody: reqBody,
        error: "fetch failed",
      },
    });

    const steps = store.listRunStepsByRun(runId);
    const d = steps[0].detail as Record<string, unknown>;
    expect(d.method).toBe("POST");
    expect(d.requestBody).toBe(reqBody);
    expect(d.error).toBe("fetch failed");
  });

  it("multiple steps preserve individual detail fields", () => {
    const stepDetails = [
      { method: "POST", path: "/api/fieldserve/sites", status: 201, expected: 201, duration: 80, requestBody: '{"name":"HQ"}', responseBody: '{"site":{"id":1}}' },
      { method: "GET", path: "/api/fieldserve/sites/1", status: 200, expected: 200, duration: 30, requestBody: null, responseBody: '{"id":1,"name":"HQ"}' },
      { method: "POST", path: "/api/fieldserve/jobs", status: 201, expected: 201, duration: 95, requestBody: '{"title":"Fix","siteId":1}', responseBody: '{"job":{"id":10}}' },
    ];

    for (let i = 0; i < stepDetails.length; i++) {
      store.addRunStep(runId, { idx: i, status: "passed", detail: stepDetails[i] });
    }

    const steps = store.listRunStepsByRun(runId);
    expect(steps).toHaveLength(3);

    const d0 = steps[0].detail as Record<string, unknown>;
    expect(d0.requestBody).toBe('{"name":"HQ"}');
    expect(d0.responseBody).toBe('{"site":{"id":1}}');

    const d1 = steps[1].detail as Record<string, unknown>;
    expect(d1.requestBody).toBeNull();
    expect(d1.responseBody).toBe('{"id":1,"name":"HQ"}');

    const d2 = steps[2].detail as Record<string, unknown>;
    expect(d2.requestBody).toBe('{"title":"Fix","siteId":1}');
    expect(d2.responseBody).toBe('{"job":{"id":10}}');
  });

  it("detail without requestBody/responseBody still works (backward compat)", () => {
    store.addRunStep(runId, {
      idx: 0,
      status: "passed",
      detail: { method: "GET", path: "/test", status: 200, expected: 200, duration: 10 },
    });

    const steps = store.listRunStepsByRun(runId);
    const d = steps[0].detail as Record<string, unknown>;
    expect(d.method).toBe("GET");
    expect(d.requestBody).toBeUndefined();
    expect(d.responseBody).toBeUndefined();
  });

  it("detail round-trips through JSON serialization correctly", () => {
    const complexBody = JSON.stringify({ title: "Test", nested: { a: 1, b: [2, 3] }, emoji: "🔧" });
    const complexResp = JSON.stringify({ result: "ok", items: [{ id: 1 }, { id: 2 }] });

    store.addRunStep(runId, {
      idx: 0,
      status: "passed",
      detail: {
        method: "POST",
        path: "/api/fieldserve/jobs",
        status: 201,
        expected: 201,
        duration: 50,
        requestBody: complexBody,
        responseBody: complexResp,
      },
    });

    const steps = store.listRunStepsByRun(runId);
    const d = steps[0].detail as Record<string, unknown>;

    expect(d.requestBody).toBe(complexBody);
    expect(d.responseBody).toBe(complexResp);
    expect(JSON.parse(d.requestBody as string)).toEqual({ title: "Test", nested: { a: 1, b: [2, 3] }, emoji: "🔧" });
    expect(JSON.parse(d.responseBody as string)).toEqual({ result: "ok", items: [{ id: 1 }, { id: 2 }] });
  });
});

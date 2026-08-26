import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.js";
import { DataStore } from "./queries.js";

function createStore(): DataStore {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) {
    for (const sql of m.sql) db.exec(sql);
  }
  return new DataStore(db);
}

describe("Suite editing — add, remove, reorder tests and API sessions", () => {
  let store: DataStore;

  beforeEach(() => {
    store = createStore();
  });

  // ---- UI Suites ----

  it("create UI suite, add tests, then replace with different order", () => {
    const t1 = store.createTest({ name: "Login", source: "template" });
    const t2 = store.createTest({ name: "Signup", source: "template" });
    const t3 = store.createTest({ name: "Dashboard", source: "template" });

    const suite = store.createSuite({ name: "My Suite", mode: "sequential" });

    // Add tests in order: t1, t2, t3
    store.setSuiteTests(suite.id, [
      { testId: t1.id },
      { testId: t2.id },
      { testId: t3.id },
    ]);

    let withTests = store.getSuiteWithTests(suite.id)!;
    expect(withTests.tests).toHaveLength(3);
    expect(withTests.tests.map((st) => st.testId)).toEqual([t1.id, t2.id, t3.id]);
    expect(withTests.tests.map((st) => st.position)).toEqual([0, 1, 2]);

    // Reorder: t3, t1 (remove t2)
    store.setSuiteTests(suite.id, [
      { testId: t3.id },
      { testId: t1.id },
    ]);

    withTests = store.getSuiteWithTests(suite.id)!;
    expect(withTests.tests).toHaveLength(2);
    expect(withTests.tests.map((st) => st.testId)).toEqual([t3.id, t1.id]);
    expect(withTests.tests.map((st) => st.position)).toEqual([0, 1]);
  });

  it("set parallel flag on suite tests", () => {
    const t1 = store.createTest({ name: "A", source: "template" });
    const t2 = store.createTest({ name: "B", source: "template" });
    const t3 = store.createTest({ name: "C", source: "template" });

    const suite = store.createSuite({ name: "Parallel Suite", mode: "mixed" });

    // t1 sequential, t2+t3 parallel
    store.setSuiteTests(suite.id, [
      { testId: t1.id, parallel: false },
      { testId: t2.id, parallel: true },
      { testId: t3.id, parallel: true },
    ]);

    const withTests = store.getSuiteWithTests(suite.id)!;
    expect(withTests.tests[0].parallel).toBe(false);
    expect(withTests.tests[1].parallel).toBe(true);
    expect(withTests.tests[2].parallel).toBe(true);
  });

  it("clear all tests from suite", () => {
    const t1 = store.createTest({ name: "A", source: "template" });
    const suite = store.createSuite({ name: "Empty Suite" });
    store.setSuiteTests(suite.id, [{ testId: t1.id }]);

    expect(store.getSuiteWithTests(suite.id)!.tests).toHaveLength(1);

    store.setSuiteTests(suite.id, []);
    expect(store.getSuiteWithTests(suite.id)!.tests).toHaveLength(0);
  });

  it("replace tests preserves suite updated_at", () => {
    const t1 = store.createTest({ name: "A", source: "template" });
    const t2 = store.createTest({ name: "B", source: "template" });
    const suite = store.createSuite({ name: "Test" });
    store.setSuiteTests(suite.id, [{ testId: t1.id }]);

    const before = store.getSuite(suite.id)!.updatedAt;
    // Small delay to ensure timestamp changes
    store.setSuiteTests(suite.id, [{ testId: t2.id }]);
    const after = store.getSuite(suite.id)!.updatedAt;

    expect(after >= before).toBe(true);
  });

  // ---- API Suites ----

  it("create API suite, add sessions, then replace with different set", () => {
    const suite = store.createSuite({ name: "API Suite", type: "api" });

    // Add sessions 10, 20, 30
    store.setSuiteApiSessions(suite.id, [10, 20, 30]);

    let withSessions = store.getSuiteWithApiSessions(suite.id)!;
    expect(withSessions.apiSessions).toHaveLength(3);
    expect(withSessions.apiSessions.map((s) => s.sessionId)).toEqual([10, 20, 30]);
    expect(withSessions.apiSessions.map((s) => s.position)).toEqual([0, 1, 2]);

    // Replace: remove 20, reorder to 30, 10
    store.setSuiteApiSessions(suite.id, [30, 10]);

    withSessions = store.getSuiteWithApiSessions(suite.id)!;
    expect(withSessions.apiSessions).toHaveLength(2);
    expect(withSessions.apiSessions.map((s) => s.sessionId)).toEqual([30, 10]);
    expect(withSessions.apiSessions.map((s) => s.position)).toEqual([0, 1]);
  });

  it("clear all API sessions from suite", () => {
    const suite = store.createSuite({ name: "API Suite", type: "api" });
    store.setSuiteApiSessions(suite.id, [10, 20]);

    expect(store.getSuiteWithApiSessions(suite.id)!.apiSessions).toHaveLength(2);

    store.setSuiteApiSessions(suite.id, []);
    expect(store.getSuiteWithApiSessions(suite.id)!.apiSessions).toHaveLength(0);
  });

  it("replace API sessions preserves suite updated_at", () => {
    const suite = store.createSuite({ name: "API Suite", type: "api" });
    store.setSuiteApiSessions(suite.id, [10]);

    const before = store.getSuite(suite.id)!.updatedAt;
    store.setSuiteApiSessions(suite.id, [20]);
    const after = store.getSuite(suite.id)!.updatedAt;

    expect(after >= before).toBe(true);
  });

  // ---- Suite metadata ----

  it("update suite name and mode", () => {
    const suite = store.createSuite({ name: "Old Name", mode: "sequential" });

    store.updateSuite(suite.id, { name: "New Name", mode: "parallel" });

    const updated = store.getSuite(suite.id)!;
    expect(updated.name).toBe("New Name");
    expect(updated.mode).toBe("parallel");
  });

  it("update suite description", () => {
    const suite = store.createSuite({ name: "Test", description: "old" });
    store.updateSuite(suite.id, { description: "new description" });
    expect(store.getSuite(suite.id)!.description).toBe("new description");
  });

  it("delete suite cascades to suite_tests", () => {
    const t1 = store.createTest({ name: "A", source: "template" });
    const suite = store.createSuite({ name: "To Delete" });
    store.setSuiteTests(suite.id, [{ testId: t1.id }]);

    store.deleteSuite(suite.id);
    expect(store.getSuite(suite.id)).toBeNull();
    expect(store.getSuiteWithTests(suite.id)).toBeNull();
  });

  it("delete suite cascades to suite_api_sessions", () => {
    const suite = store.createSuite({ name: "To Delete", type: "api" });
    store.setSuiteApiSessions(suite.id, [10, 20]);

    store.deleteSuite(suite.id);
    expect(store.getSuite(suite.id)).toBeNull();
    expect(store.getSuiteWithApiSessions(suite.id)).toBeNull();
  });

  // ---- Full editing workflow ----

  it("full workflow: create → add tests → edit → add sessions → edit → delete", () => {
    const t1 = store.createTest({ name: "Login", source: "template" });
    const t2 = store.createTest({ name: "Dashboard", source: "template" });

    // 1. Create UI suite with tests
    const uiSuite = store.createSuite({ name: "UI Tests", mode: "sequential" });
    store.setSuiteTests(uiSuite.id, [{ testId: t1.id }, { testId: t2.id }]);

    let s = store.getSuiteWithTests(uiSuite.id)!;
    expect(s.tests).toHaveLength(2);

    // 2. Edit: remove t1, reorder
    store.setSuiteTests(uiSuite.id, [{ testId: t2.id }]);
    s = store.getSuiteWithTests(uiSuite.id)!;
    expect(s.tests).toHaveLength(1);
    expect(s.tests[0].testId).toBe(t2.id);

    // 3. Create API suite with sessions
    const apiSuite = store.createSuite({ name: "API Tests", type: "api" });
    store.setSuiteApiSessions(apiSuite.id, [100, 200]);

    let a = store.getSuiteWithApiSessions(apiSuite.id)!;
    expect(a.apiSessions).toHaveLength(2);

    // 4. Edit: reorder sessions
    store.setSuiteApiSessions(apiSuite.id, [200, 100]);
    a = store.getSuiteWithApiSessions(apiSuite.id)!;
    expect(a.apiSessions.map((s) => s.sessionId)).toEqual([200, 100]);

    // 5. Rename both
    store.updateSuite(uiSuite.id, { name: "Renamed UI" });
    store.updateSuite(apiSuite.id, { name: "Renamed API" });
    expect(store.getSuite(uiSuite.id)!.name).toBe("Renamed UI");
    expect(store.getSuite(apiSuite.id)!.name).toBe("Renamed API");

    // 6. Delete both
    store.deleteSuite(uiSuite.id);
    store.deleteSuite(apiSuite.id);
    expect(store.listSuites()).toHaveLength(0);
  });
});

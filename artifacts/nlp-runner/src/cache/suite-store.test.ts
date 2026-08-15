import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { DataStore } from "./queries.js";

const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

function makeStore(): DataStore {
  const dir = mkdtempSync(join(tmpdir(), "qf-suite-"));
  tempDirs.push(dir);
  const db = openDatabase(dir);
  openDbs.push(db);
  return new DataStore(db);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedTests(store: DataStore, names: string[]): number[] {
  return names.map((name) =>
    store.saveTest({
      name,
      source: "recorder",
      entryUrl: "https://example.test",
      stepHash: `hash-${name}`,
      query: name,
      steps: [{ action: "navigate", value: "https://example.test", selector: null }],
      slots: [],
    }).id,
  );
}

describe("suites", () => {
  it("creates a suite with ordered member tests", () => {
    const store = makeStore();
    const [a, b] = seedTests(store, ["Login", "Signup"]);

    const suite = store.createSuite({ name: "Auth suite", mode: "parallel" });
    store.setSuiteTests(suite.id, [{ testId: a, parallel: true }, { testId: b }]);

    const loaded = store.getSuiteWithTests(suite.id)!;
    expect(loaded.name).toBe("Auth suite");
    expect(loaded.mode).toBe("parallel");
    expect(loaded.tests.map((t) => t.testId)).toEqual([a, b]);
    expect(loaded.tests.map((t) => t.position)).toEqual([0, 1]);
    expect(loaded.tests.map((t) => t.parallel)).toEqual([true, false]);
  });

  it("replaces member tests preserving new order", () => {
    const store = makeStore();
    const [a, b] = seedTests(store, ["A", "B"]);
    const suite = store.createSuite({ name: "S" });
    store.setSuiteTests(suite.id, [{ testId: a }, { testId: b }]);
    store.setSuiteTests(suite.id, [{ testId: b, parallel: true }, { testId: a }]);
    expect(store.getSuiteWithTests(suite.id)!.tests.map((t) => t.testId)).toEqual([b, a]);
    expect(store.getSuiteWithTests(suite.id)!.tests.map((t) => t.parallel)).toEqual([true, false]);
  });

  it("deletes a suite and its member links", () => {
    const store = makeStore();
    const [a] = seedTests(store, ["A"]);
    const suite = store.createSuite({ name: "S" });
    store.setSuiteTests(suite.id, [{ testId: a }]);
    store.deleteSuite(suite.id);
    expect(store.getSuite(suite.id)).toBeNull();
    expect(store.listSuiteTestsBySuite(suite.id)).toEqual([]);
  });

  it("deletes a suite that has executed runs (detaches member run rows)", () => {
    const store = makeStore();
    const [a] = seedTests(store, ["A"]);
    const suite = store.createSuite({ name: "S" });
    store.setSuiteTests(suite.id, [{ testId: a }]);
    const suiteRun = store.createSuiteRun({ suiteId: suite.id, status: "passed", mode: "sequential" });
    store.createRun({ testId: a, status: "passed", suiteRunId: suiteRun.id });

    store.deleteSuite(suite.id);

    expect(store.getSuite(suite.id)).toBeNull();
    expect(store.listSuiteRuns(suite.id)).toEqual([]);
    // The member run row survives as an unattached standalone run.
    expect(store.listRuns(a)).toHaveLength(1);
  });
});

describe("trains", () => {
  it("creates a train with ordered suites", () => {
    const store = makeStore();
    const [a] = seedTests(store, ["A"]);
    const s1 = store.createSuite({ name: "S1" });
    const s2 = store.createSuite({ name: "S2" });
    store.setSuiteTests(s1.id, [{ testId: a }]);

    const train = store.createTrain({ name: "Nightly", mode: "sequential" });
    store.setTrainSuites(train.id, [{ suiteId: s1.id }, { suiteId: s2.id }]);

    const loaded = store.getTrainWithSuites(train.id)!;
    expect(loaded.mode).toBe("sequential");
    expect(loaded.suites.map((s) => s.suiteId)).toEqual([s1.id, s2.id]);
    expect(loaded.suites.map((s) => s.parallel)).toEqual([false, false]);
  });
});

describe("suite & train runs", () => {
  it("persists a suite run and links member test runs", () => {
    const store = makeStore();
    const [a] = seedTests(store, ["A"]);
    const suite = store.createSuite({ name: "S", mode: "parallel" });
    store.setSuiteTests(suite.id, [{ testId: a }]);

    const suiteRun = store.createSuiteRun({ suiteId: suite.id, status: "running", mode: "parallel" });
    const run = store.createRun({ testId: a, status: "running", suiteRunId: suiteRun.id });
    store.finishRun(run.id, "passed");
    store.finishSuiteRun(suiteRun.id, "passed");

    const loaded = store.getSuiteRunWithRuns(suiteRun.id)!;
    expect(loaded.status).toBe("passed");
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.runs[0].suiteRunId).toBe(suiteRun.id);
    expect(store.listSuiteRuns(suite.id)).toHaveLength(1);
  });

  it("links a train run to its suite runs", () => {
    const store = makeStore();
    const [a] = seedTests(store, ["A"]);
    const suite = store.createSuite({ name: "S" });
    store.setSuiteTests(suite.id, [{ testId: a }]);

    const train = store.createTrain({ name: "T", mode: "sequential" });
    const trainRun = store.createTrainRun({ trainId: train.id, status: "running", mode: "sequential" });
    const suiteRun = store.createSuiteRun({
      suiteId: suite.id,
      status: "running",
      mode: "sequential",
      trainRunId: trainRun.id,
    });
    store.linkSuiteRunToTrain(suiteRun.id, trainRun.id);
    store.finishSuiteRun(suiteRun.id, "passed");
    store.finishTrainRun(trainRun.id, "passed");

    const loaded = store.getTrainRunWithSuiteRuns(trainRun.id);
    expect(loaded.suiteRuns).toHaveLength(1);
    expect(loaded.suiteRuns[0].trainRunId).toBe(trainRun.id);
  });

  it("deletes a train that has executed runs (detaches its suite runs)", () => {
    const store = makeStore();
    const [a] = seedTests(store, ["A"]);
    const suite = store.createSuite({ name: "S" });
    store.setSuiteTests(suite.id, [{ testId: a }]);
    const train = store.createTrain({ name: "T", mode: "sequential" });
    store.setTrainSuites(train.id, [{ suiteId: suite.id }]);
    const trainRun = store.createTrainRun({ trainId: train.id, status: "passed", mode: "sequential" });
    store.createSuiteRun({ suiteId: suite.id, status: "passed", mode: "sequential", trainRunId: trainRun.id });

    store.deleteTrain(train.id);

    expect(store.getTrain(train.id)).toBeNull();
    expect(store.listTrainRuns(train.id)).toEqual([]);
  });
});

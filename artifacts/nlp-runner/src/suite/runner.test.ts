import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import { resolveMode, SuiteRunner, TrainRunner, type RunTestFn, type SuiteStepEvent } from "./runner.js";

const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

function makeStore(): DataStore {
  const dir = mkdtempSync(join(tmpdir(), "qf-srunner-"));
  tempDirs.push(dir);
  const db = openDatabase(dir);
  openDbs.push(db);
  return new DataStore(db);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedSuite(
  store: DataStore,
  testNames: string[],
  parallel: boolean | boolean[] = false,
): number {
  const ids = testNames.map((name) =>
    store.saveTest({
      name,
      source: "recorder",
      entryUrl: "https://example.test",
      stepHash: `h-${name}`,
      query: name,
      steps: [{ action: "navigate", value: "https://example.test", selector: null }],
      slots: [],
    }).id,
  );
  const suite = store.createSuite({ name: "S" });
  store.setSuiteTests(
    suite.id,
    testNames.map((_, i) => ({
      testId: ids[i],
      parallel: Array.isArray(parallel) ? parallel[i] ?? false : parallel,
    })),
  );
  return suite.id;
}

/** Fake per-test runner that persists real run rows and can be told to fail. */
function fakeRunTest(store: DataStore, order: string[], failOn: Set<string>): RunTestFn {
  return async (test, suiteRunId) => {
    order.push(test.name);
    const run = store.createRun({ testId: test.id, status: "running", suiteRunId });
    if (failOn.has(test.name)) {
      store.finishRun(run.id, "failed", `failed ${test.name}`);
      return {
        runId: run.id,
        testId: test.id,
        success: false,
        steps: [],
        extracted: {},
        llmCalls: 0,
        selfHealed: 0,
        selfHealedSteps: [],
        error: `failed ${test.name}`,
      };
    }
    store.finishRun(run.id, "passed");
    return {
      runId: run.id,
      testId: test.id,
      success: true,
      steps: [],
      extracted: {},
      llmCalls: 0,
      selfHealed: 0,
      selfHealedSteps: [],
    };
  };
}

function makeRunner(store: DataStore, concurrency = 2): SuiteRunner {
  return new SuiteRunner(store, {
    launch: async () => {
      throw new Error("not used in unit tests");
    },
    screenshotBaseDir: join(tmpdir(), "qf-screens"),
    concurrency,
  });
}

describe("SuiteRunner (sequential)", () => {
  it("runs member tests in order and persists a passed suite run", async () => {
    const store = makeStore();
    const suiteId = seedSuite(store, ["A", "B"]);
    const order: string[] = [];
    const runner = makeRunner(store);

    const suiteRun = await runner.runSuite(suiteId, { runTestFn: fakeRunTest(store, order, new Set()) });

    expect(order).toEqual(["A", "B"]);
    expect(suiteRun.status).toBe("passed");
    const loaded = store.getSuiteRunWithRuns(suiteRun.id)!;
    expect(loaded.runs).toHaveLength(2);
    expect(loaded.runs.every((r) => r.status === "passed")).toBe(true);
  });

  it("marks the suite failed when any member test fails, still running the rest", async () => {
    const store = makeStore();
    const suiteId = seedSuite(store, ["A", "B", "C"]);
    const runner = makeRunner(store);

    const suiteRun = await runner.runSuite(suiteId, {
      runTestFn: fakeRunTest(store, [], new Set(["B"])),
    });

    expect(suiteRun.status).toBe("failed");
    const loaded = store.getSuiteRunWithRuns(suiteRun.id)!;
    expect(loaded.runs.map((r) => r.status)).toEqual(["passed", "failed", "passed"]);
  });

  it("emits test-done and suite-done events", async () => {
    const store = makeStore();
    const suiteId = seedSuite(store, ["A"]);
    const runner = makeRunner(store);
    const events: string[] = [];

    await runner.runSuite(suiteId, {
      runTestFn: fakeRunTest(store, [], new Set()),
      onEvent: (e) => events.push(e.type),
    });

    expect(events).toEqual(["test-done", "suite-done"]);
  });

  it("aborts between tests when the signal fires", async () => {
    const store = makeStore();
    const suiteId = seedSuite(store, ["A", "B", "C"]);
    const runner = makeRunner(store);
    const controller = new AbortController();
    const order: string[] = [];
    const fn = fakeRunTest(store, order, new Set());
    const wrapped: RunTestFn = async (test, sr, dir, onEvent) => {
      const result = await fn(test, sr, dir, onEvent);
      if (test.name === "B") controller.abort(new Error("cancelled"));
      return result;
    };

    const suiteRun = await runner.runSuite(suiteId, { runTestFn: wrapped, signal: controller.signal });

    expect(suiteRun.status).toBe("failed");
    expect(order).toEqual(["A", "B"]);
    expect(store.getSuiteRun(suiteRun.id)!.error).toBe("cancelled");
  });
});

describe("SuiteRunner (parallel)", () => {
  it("caps concurrency during parallel runs", async () => {
    const store = makeStore();
    const suiteId = seedSuite(store, ["A", "B", "C", "D"], true);
    let inFlight = 0;
    let peak = 0;
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const fn: RunTestFn = async (test) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(30);
      inFlight--;
      return {
        runId: 0,
        testId: test.id,
        success: true,
        steps: [],
        extracted: {},
        llmCalls: 0,
        selfHealed: 0,
        selfHealedSteps: [],
      };
    };

    const suiteRun = await makeRunner(store).runSuite(suiteId, { runTestFn: fn });

    expect(peak).toBe(2);
    expect(suiteRun.status).toBe("passed");
  });
});

describe("SuiteRunner (mixed parallel + sequential)", () => {
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("serializes sequential members in order while parallel members overlap them", async () => {
    const store = makeStore();
    // A + C parallel, B + D sequential.
    const suiteId = seedSuite(store, ["A", "B", "C", "D"], [true, false, true, false]);
    const order: string[] = [];
    let totalInFlight = 0;
    let totalPeak = 0;
    const fn: RunTestFn = async (test) => {
      order.push(test.name);
      totalInFlight++;
      totalPeak = Math.max(totalPeak, totalInFlight);
      await delay(40);
      totalInFlight--;
      return {
        runId: 0,
        testId: test.id,
        success: true,
        steps: [],
        extracted: {},
        llmCalls: 0,
        selfHealed: 0,
        selfHealedSteps: [],
      };
    };

    await makeRunner(store).runSuite(suiteId, { runTestFn: fn });

    // Sequential members B and D never overlap each other.
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
    // Parallel members overlapped the sequential chain, so peak exceeded 1.
    expect(totalPeak).toBeGreaterThan(1);
  });

  it("never lets sequential members run concurrently with each other", async () => {
    const store = makeStore();
    const suiteId = seedSuite(store, ["A", "B", "C", "D"], [true, false, true, false]);
    let seqInFlight = 0;
    let seqPeak = 0;
    const delay2 = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const suite = store.getSuiteWithTests(suiteId)!;
    const seqIds = new Set(suite.tests.filter((t) => !t.parallel).map((t) => t.testId));
    const fn: RunTestFn = async (test) => {
      if (seqIds.has(test.id)) {
        seqInFlight++;
        seqPeak = Math.max(seqPeak, seqInFlight);
      }
      await delay2(40);
      if (seqIds.has(test.id)) seqInFlight--;
      return {
        runId: 0,
        testId: test.id,
        success: true,
        steps: [],
        extracted: {},
        llmCalls: 0,
        selfHealed: 0,
        selfHealedSteps: [],
      };
    };

    await makeRunner(store).runSuite(suiteId, { runTestFn: fn });

    expect(seqPeak).toBe(1);
  });

  it("stores a resolved 'mixed' mode on the suite run", async () => {
    const store = makeStore();
    const suiteId = seedSuite(store, ["A", "B"], [true, false]);
    const suiteRun = await makeRunner(store).runSuite(suiteId, {
      runTestFn: fakeRunTest(store, [], new Set()),
    });
    expect(suiteRun.mode).toBe("mixed");
  });
});

describe("resolveMode", () => {
  it("resolves pure and mixed modes from member flags", () => {
    expect(resolveMode([{ parallel: true }, { parallel: true }])).toBe("parallel");
    expect(resolveMode([{ parallel: false }, { parallel: false }])).toBe("sequential");
    expect(resolveMode([{ parallel: true }, { parallel: false }])).toBe("mixed");
    expect(resolveMode([])).toBe("sequential");
  });
});

describe("TrainRunner", () => {
  function seedTrain(store: DataStore, suiteParallel: Array<boolean | undefined> = []): number {
    const s1 = seedSuite(store, ["A"]);
    const s2 = seedSuite(store, ["B"]);
    const train = store.createTrain({ name: "T" });
    store.setTrainSuites(
      train.id,
      [s1, s2].map((suiteId, i) => ({ suiteId, parallel: suiteParallel[i] ?? false })),
    );
    return train.id;
  }

  it("runs suites in train order and links suite runs to the train run", async () => {
    const store = makeStore();
    const trainId = seedTrain(store);
    const order: string[] = [];
    const suiteRunner = makeRunner(store);
    const trainRunner = new TrainRunner(store, suiteRunner);

    const trainRun = await trainRunner.runTrain(trainId, {
      runTestFn: fakeRunTest(store, order, new Set()),
    });

    expect(order).toEqual(["A", "B"]);
    expect(trainRun.status).toBe("passed");
    const loaded = store.getTrainRunWithSuiteRuns(trainRun.id);
    expect(loaded.suiteRuns).toHaveLength(2);
    expect(loaded.suiteRuns.every((r) => r.trainRunId === trainRun.id)).toBe(true);
  });

  it("fails the train when a member suite fails", async () => {
    const store = makeStore();
    const trainId = seedTrain(store);
    const suiteRunner = makeRunner(store);
    const trainRunner = new TrainRunner(store, suiteRunner);

    const trainRun = await trainRunner.runTrain(trainId, {
      runTestFn: fakeRunTest(store, [], new Set(["A"])),
    });

    expect(trainRun.status).toBe("failed");
  });

  it("emits suite-start, suite-done, and done events", async () => {
    const store = makeStore();
    const trainId = seedTrain(store);
    const events: string[] = [];
    const trainRunner = new TrainRunner(store, makeRunner(store));

    await trainRunner.runTrain(trainId, {
      runTestFn: fakeRunTest(store, [], new Set()),
      onEvent: (e) => events.push(e.type),
    });

    expect(events).toEqual([
      "suite-start",
      "test-done",
      "suite-done",
      "suite-start",
      "test-done",
      "suite-done",
      "done",
    ]);
  });

  it("runs parallel suites concurrently (capped) and records a 'parallel' mode", async () => {
    const store = makeStore();
    const trainId = seedTrain(store, [true, true]);
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    let inFlight = 0;
    let peak = 0;
    const fn: RunTestFn = async (test) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(30);
      inFlight--;
      return {
        runId: 0,
        testId: test.id,
        success: true,
        steps: [],
        extracted: {},
        llmCalls: 0,
        selfHealed: 0,
        selfHealedSteps: [],
      };
    };

    const trainRun = await new TrainRunner(store, makeRunner(store)).runTrain(trainId, { runTestFn: fn });

    expect(peak).toBe(2);
    expect(trainRun.status).toBe("passed");
    expect(trainRun.mode).toBe("parallel");
  });
});

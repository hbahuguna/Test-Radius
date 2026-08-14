import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./cache/db.js";
import { DataStore } from "./cache/queries.js";
import type { Step } from "./cache/types.js";
import { formatRecordReport, listTests, parseBrowseArgs, parseRunArgs, renderChecklist, resolveRunTarget, showRuns, showTest, stepToEnglish } from "./cli.js";

const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

function makeStore(): DataStore {
  const dir = mkdtempSync(join(tmpdir(), "qf-cli-"));
  tempDirs.push(dir);
  const db = openDatabase(dir);
  openDbs.push(db);
  return new DataStore(db);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 1,
    testId: 1,
    idx: 0,
    action: "click",
    selector: "[data-testid=signup-submit]",
    value: null,
    locators: ['[data-testid="signup-submit"]', 'text="Create account"'],
    elementFingerprint: "fp",
    pageSignatureBefore: "sig1",
    pageSignatureAfter: "sig2",
    waitCondition: null,
    assertion: null,
    ...overrides,
  };
}

describe("stepToEnglish", () => {
  it("prefers the text locator for friendly descriptions", () => {
    expect(stepToEnglish(makeStep())).toBe('Click "Create account"');
  });

  it("renders each action type", () => {
    expect(stepToEnglish(makeStep({ action: "navigate", selector: null, value: "/signup" }))).toBe(
      "Navigate to /signup",
    );
    expect(
      stepToEnglish(makeStep({ action: "fill", value: "bob@x.com" })),
    ).toBe('Fill "Create account" with "bob@x.com"');
    expect(
      stepToEnglish(makeStep({ action: "select", value: "pro", locators: ["#plan"] })),
    ).toBe('Select "pro" in #plan');
    expect(
      stepToEnglish(makeStep({ action: "scroll", locators: ["#details"] })),
    ).toBe("Scroll #details into view");
    expect(
      stepToEnglish(makeStep({ action: "extract", value: "bob@x.com" })),
    ).toBe('Extract value from "Create account"');
  });

  it("renders assertions", () => {
    expect(
      stepToEnglish(
        makeStep({ action: "assert", assertion: { op: "visible", expected: true } }),
      ),
    ).toBe("Assert [data-testid=signup-submit] is visible");
    expect(
      stepToEnglish(
        makeStep({ action: "assert", assertion: { op: "text", expected: "Welcome" } }),
      ),
    ).toBe('Assert [data-testid=signup-submit] contains text "Welcome"');
    expect(
      stepToEnglish(
        makeStep({ action: "assert", selector: null, assertion: { op: "url", expected: "/welcome" } }),
      ),
    ).toBe('Assert URL contains "/welcome"');
  });
});

describe("renderChecklist", () => {
  it("numbers steps starting at 1", () => {
    const steps = [
      makeStep({ id: 1, idx: 0 }),
      makeStep({ id: 2, idx: 1, action: "fill", value: "x" }),
    ];
    const out = renderChecklist(steps);
    expect(out).toContain("1. Click \"Create account\"");
    expect(out).toContain('2. Fill "Create account" with "x"');
  });

  it("handles an empty step list", () => {
    expect(renderChecklist([])).toBe("  (no steps)");
  });
});

describe("listTests", () => {
  it("prints an empty-state message when there are no tests", () => {
    expect(listTests(makeStore())).toBe("No recorded tests yet.");
  });

  it("shows recorded tests with step and run counts", () => {
    const store = makeStore();
    const test = store.saveTest({
      name: "signup flow",
      source: "recorder",
      entryUrl: "http://127.0.0.1:3123/signup",
      stepHash: "abc",
      steps: [makeStep()],
      slots: [],
    });
    const run = store.createRun({
      testId: test.id,
      status: "running",
      startedAt: "2025-01-01T00:00:00.000Z",
      llmCalls: 0,
    });
    store.finishRun(run.id, "passed");
    const out = listTests(store);
    expect(out).toContain("signup flow");
    expect(out).toContain("steps=1");
    expect(out).toContain("runs=1");
    expect(out).toContain("/signup");
  });
});

describe("showTest", () => {
  it("renders a test as a checklist with metadata and slots", () => {
    const store = makeStore();
    const test = store.saveTest({
      name: "signup flow",
      source: "recorder",
      entryUrl: "http://127.0.0.1:3123/signup",
      stepHash: "abc",
      description: "recorded demo",
      steps: [
        makeStep({ action: "navigate", selector: null, value: "/signup", locators: [] }),
        makeStep({ id: 2, idx: 1, action: "fill", value: "bob@x.com" }),
      ],
      slots: [{ name: "email", kind: "email", defaultValue: "bob@x.com" }],
    });
    const out = showTest(store, test.id);
    expect(out).toContain("signup flow (recorder)");
    expect(out).toContain("Entry URL: http://127.0.0.1:3123/signup");
    expect(out).toContain("recorded demo");
    expect(out).toContain("Slots: email (email) = \"bob@x.com\"");
    expect(out).toContain("1. Navigate to /signup");
    expect(out).toContain('2. Fill "Create account" with "bob@x.com"');
  });

  it("reports a missing test", () => {
    expect(showTest(makeStore(), 99)).toBe("No test with id 99.");
  });
});

describe("showRuns", () => {
  it("prints an empty-state message when there are no runs", () => {
    const store = makeStore();
    const test = store.createTest({ name: "signup flow", source: "recorder" });
    expect(showRuns(store, test.id)).toBe(
      `No runs yet for test ${test.id} (signup flow).`,
    );
  });

  it("lists run history with status and duration", () => {
    const store = makeStore();
    const test = store.createTest({ name: "signup flow", source: "recorder" });
    const run = store.createRun({
      testId: test.id,
      status: "running",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      llmCalls: 2,
    });
    store.finishRun(run.id, "failed");
    const out = showRuns(store, test.id);
    expect(out).toContain(`Runs for test ${test.id} (signup flow):`);
    expect(out).toContain(`run#${run.id}`);
    expect(out).toContain("failed");
    expect(out).toMatch(/duration=\d+ms/);
    expect(out).toContain("llm_calls=2");
  });
});

describe("parseRunArgs", () => {
  it("parses id target with variables and screenshot dir", () => {
    const args = parseRunArgs([
      "3",
      "--variables",
      '{"email":"jane@y.com"}',
      "--headful",
      "--screenshot-dir",
      "/tmp/shots",
    ]);
    expect(args.target).toBe("3");
    expect(args.variables).toEqual({ email: "jane@y.com" });
    expect(args.headful).toBe(true);
    expect(args.screenshotDir).toBe("/tmp/shots");
  });

  it("supports --variables=json and --screenshot-dir=path forms", () => {
    const args = parseRunArgs([
      '--variables={"name":"Ada"}',
      "--screenshot-dir=/tmp/shots",
      "runme",
    ]);
    expect(args.target).toBe("runme");
    expect(args.variables).toEqual({ name: "Ada" });
    expect(args.screenshotDir).toBe("/tmp/shots");
  });

  it("defaults to headless with no options", () => {
    const args = parseRunArgs(["1"]);
    expect(args.target).toBe("1");
    expect(args.headful).toBe(false);
    expect(args.variables).toEqual({});
    expect(args.screenshotDir).toBeNull();
  });

  it("rejects missing target", () => {
    expect(() => parseRunArgs([])).toThrow("expected a test id or query");
  });

  it("rejects malformed variables JSON", () => {
    expect(() => parseRunArgs(["1", "--variables", "{nope"])).toThrow("--variables: invalid JSON");
  });

  it("rejects unknown flags", () => {
    expect(() => parseRunArgs(["1", "--bogus"])).toThrow('unknown flag "--bogus"');
  });

  it("parses record quality-gate flags", () => {
    const args = parseRunArgs([
      "register a user",
      "--confirm",
      "--no-dry-run",
      "--no-minimize",
      "--site",
      "https://example.com/",
      "--max-dry-run-attempts",
      "3",
    ]);
    expect(args.target).toBe("register a user");
    expect(args.confirm).toBe(true);
    expect(args.noDryRun).toBe(true);
    expect(args.noMinimize).toBe(true);
    expect(args.site).toBe("https://example.com/");
    expect(args.maxDryRunAttempts).toBe(3);
  });

  it("parses --test and --entry-url flags", () => {
    const args = parseRunArgs([
      "--test",
      "7",
      "--entry-url",
      "https://example.com/s",
      "--variables",
      '{"email":"jane@y.com"}',
    ]);
    expect(args.test).toBe(7);
    expect(args.entryUrl).toBe("https://example.com/s");
    expect(args.variables).toEqual({ email: "jane@y.com" });
  });

  it("requires --test to be a positive integer", () => {
    expect(() => parseRunArgs(["--test", "0"])).toThrow("--test requires a positive integer id");
    expect(() => parseRunArgs(["--test", "abc"])).toThrow("--test requires a positive integer id");
  });
});

describe("formatRecordReport", () => {
  it("renders a cached pass report with metrics and minimization", () => {
    const report = formatRecordReport({
      testName: "Signup via query",
      query: "register a user",
      cached: true,
      milestones: ["open", "fill", "submit"],
      metrics: { turns: 3, steps: 5, llmCalls: 3, backtracks: 0, guardFires: 0, replanHints: [] },
      dryRun: { passed: true, attempts: 1 },
      minimized: { before: 5, after: 4 },
    });
    expect(report).toContain("[CACHED]");
    expect(report).toContain("milestones: 3 (open -> fill -> submit)");
    expect(report).toContain("turns: 3");
    expect(report).toContain("steps: 5");
    expect(report).toContain("llm_calls: 3");
    expect(report).toContain("dry_run: PASS (attempts 1)");
    expect(report).toContain("minimized: 5 -> 4 steps");
  });

  it("renders a failed, non-cached report with the error", () => {
    const report = formatRecordReport({
      testName: "Bad",
      query: "noop",
      cached: false,
      milestones: [],
      metrics: { turns: 0, steps: 0, llmCalls: 0, backtracks: 0, guardFires: 0, replanHints: [] },
      dryRun: { passed: false, attempts: 2, error: "step 1: boom" },
      minimized: { before: 0, after: 0 },
      error: "dry-run failed after 2 attempts: step 1: boom",
    });
    expect(report).toContain("[NOT CACHED]");
    expect(report).toContain("dry_run: FAIL (attempts 2)");
    expect(report).toContain("error: dry-run failed after 2 attempts");
  });
});

describe("resolveRunTarget", () => {
  it("resolves a numeric target to a test by id", async () => {
    const store = makeStore();
    const test = store.createTest({ name: "signup flow", source: "recorder" });
    const resolved = await resolveRunTarget(store, String(test.id));
    expect(resolved?.id).toBe(test.id);
  });

  it("resolves a query target by exact query match", async () => {
    const store = makeStore();
    const test = store.createTest({
      name: "signup flow",
      source: "recorder",
      query: "register a user",
      normalizedQuery: "register a user",
    });
    const resolved = await resolveRunTarget(store, "register a user");
    expect(resolved?.id).toBe(test.id);
  });

  it("returns null when nothing matches", async () => {
    const store = makeStore();
    expect(await resolveRunTarget(store, "no such test")).toBeNull();
    expect(await resolveRunTarget(store, "42")).toBeNull();
  });
});

describe("parseBrowseArgs", () => {
  it("requires a task string", () => {
    expect(() => parseBrowseArgs([])).toThrow("task");
  });

  it("parses a bare task", () => {
    const a = parseBrowseArgs(["go to example.com and sign up"]);
    expect(a.task).toBe("go to example.com and sign up");
    expect(a.headful).toBe(false);
    expect(a.maxSteps).toBe(100);
    expect(a.maxActions).toBe(3);
    expect(a.vision).toBe(false);
    expect(a.screenshotDir).toBeNull();
    expect(a.saveTranscript).toBeNull();
  });

  it("parses --headful and --vision flags", () => {
    const a = parseBrowseArgs(["do thing", "--headful", "--vision"]);
    expect(a.headful).toBe(true);
    expect(a.vision).toBe(true);
  });

  it("parses --max-steps / --max-actions both spaced and = forms", () => {
    expect(parseBrowseArgs(["t", "--max-steps", "50"]).maxSteps).toBe(50);
    expect(parseBrowseArgs(["t", "--max-steps=12"]).maxSteps).toBe(12);
    expect(parseBrowseArgs(["t", "--max-actions", "5"]).maxActions).toBe(5);
    expect(parseBrowseArgs(["t", "--max-actions=2"]).maxActions).toBe(2);
  });

  it("rejects non-positive integers", () => {
    expect(() => parseBrowseArgs(["t", "--max-steps", "0"])).toThrow("positive integer");
    expect(() => parseBrowseArgs(["t", "--max-actions", "x"])).toThrow("positive integer");
  });

  it("parses --screenshot-dir and --save-transcript (= and spaced)", () => {
    expect(parseBrowseArgs(["t", "--screenshot-dir", "out"]).screenshotDir).toBe("out");
    expect(parseBrowseArgs(["t", "--screenshot-dir=out2"]).screenshotDir).toBe("out2");
    expect(parseBrowseArgs(["t", "--save-transcript", "t.json"]).saveTranscript).toBe("t.json");
    expect(parseBrowseArgs(["t", "--save-transcript=t2.json"]).saveTranscript).toBe("t2.json");
  });

  it("throws on missing flag values", () => {
    expect(() => parseBrowseArgs(["t", "--max-steps"])).toThrow("missing value");
    expect(() => parseBrowseArgs(["t", "--screenshot-dir"])).toThrow("missing value");
  });

  it("throws on unknown flags and extra args", () => {
    expect(() => parseBrowseArgs(["t", "--bogus"])).toThrow('unknown flag "--bogus"');
    expect(() => parseBrowseArgs(["a", "b"])).toThrow("unexpected extra argument");
  });
});

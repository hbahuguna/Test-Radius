import type { McpServer } from "@modelcontextprotocol/server";
import { ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { DataStore, Step, RunStep } from "@workspace/nlp-runner";
import { stepToEnglish } from "@workspace/nlp-runner";

function formatStep(s: Step): string {
  const parts = [`#${s.idx + 1}`, s.action];
  if (s.value) parts.push(JSON.stringify(s.value));
  if (s.assertion) {
    const a = s.assertion;
    parts.push(`assert:${a.op}${a.expected != null ? ` expected=${JSON.stringify(a.expected)}` : ""}`);
  }
  return parts.join(" ");
}

function formatRunStep(rs: RunStep): string {
  const status = rs.status === "passed" ? "✓" : rs.status === "failed" ? "✗" : "→";
  let line = `  ${status} #${rs.idx + 1}`;
  if (typeof rs.detail === "object" && rs.detail !== null) {
    const d = rs.detail as Record<string, unknown>;
    if (typeof d.error === "string") line += ` — ${d.error}`;
    else if (typeof d.healed === "string") line += ` — healed → ${d.healed}`;
  }
  return line;
}

export function registerTools(server: McpServer, store: DataStore): void {
  server.registerTool(
    "list_tests",
    {
      description: "List all recorded UI tests with their IDs, names, source, step counts, and entry URLs.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const tests = store.listTests();
      if (tests.length === 0) return { content: [{ type: "text", text: "No tests recorded yet." }] };
      const lines = tests.map((t) => {
        const steps = store.listStepsByTest(t.id);
        return `#${t.id}  ${t.name}  (${t.source}, ${steps.length} steps)  ${t.entryUrl ?? ""}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "get_test_steps",
    {
      description: "Get the full step details for a recorded test. Shows every action, selector, value, and assertion.",
      inputSchema: { testId: z.number().describe("The test ID") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ testId }) => {
      const test = store.getTestWithSteps(testId);
      if (!test) return { content: [{ type: "text", text: `Test #${testId} not found.` }], isError: true };
      const lines = [`Test #${test.id}: ${test.name}`, `Source: ${test.source}`, `URL: ${test.entryUrl ?? "n/a"}`, "", "Steps:"];
      for (const s of test.steps) {
        lines.push(`  ${formatStep(s)}`);
        const english = stepToEnglish(s);
        if (english !== s.action) lines.push(`    → ${english}`);
      }
      if (test.completionHint) lines.push("", `Completion hint: ${test.completionHint}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "get_test_detail",
    {
      description: "Get full metadata for a single test including its steps.",
      inputSchema: { testId: z.number().describe("The test ID") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ testId }) => {
      const test = store.getTestWithSteps(testId);
      if (!test) return { content: [{ type: "text", text: `Test #${testId} not found.` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(test, null, 2) }] };
    }
  );

  server.registerTool(
    "list_runs",
    {
      description: "List recent test runs, optionally filtered by test ID. Shows status, LLM calls, and timestamps.",
      inputSchema: {
        testId: z.number().optional().describe("Optional: filter by test ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ testId }) => {
      const runs = store.listRuns(testId);
      if (runs.length === 0) return { content: [{ type: "text", text: "No runs found." }] };
      const lines = runs.slice(-20).map((r) => {
        const icon = r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : "→";
        return `${icon} Run #${r.id}  test=${r.testId}  status=${r.status}  llm=${r.llmCalls}  ${r.startedAt}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "get_run_result",
    {
      description: "Get detailed results for a specific test run, including per-step pass/fail status and error details.",
      inputSchema: { runId: z.number().describe("The run ID") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => {
      const run = store.getRunWithSteps(runId);
      if (!run) return { content: [{ type: "text", text: `Run #${runId} not found.` }], isError: true };
      const icon = run.status === "passed" ? "✓" : run.status === "failed" ? "✗" : "→";
      const lines = [
        `${icon} Run #${run.id}  test=${run.testId}  status=${run.status}`,
        `Started: ${run.startedAt}  Finished: ${run.finishedAt ?? "in progress"}`,
        `LLM calls: ${run.llmCalls}`,
        "",
        "Steps:",
      ];
      for (const rs of run.steps) {
        lines.push(formatRunStep(rs));
      }
      if (typeof run.error === "string" && run.error) lines.push("", `Error: ${run.error}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "list_suites",
    {
      description: "List all test suites (UI and API) with their IDs, names, modes, and test counts.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const suites = store.listSuites();
      if (suites.length === 0) return { content: [{ type: "text", text: "No suites configured." }] };
      const lines = suites.map((s) => {
        const members = store.listSuiteTestsBySuite(s.id);
        return `#${s.id}  ${s.name}  (${s.type}, ${s.mode}, ${members.length} tests)`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "get_suite_detail",
    {
      description: "Get full details for a test suite, including its member tests and recent run history.",
      inputSchema: { suiteId: z.number().describe("The suite ID") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ suiteId }) => {
      const suite = store.getSuiteWithTests(suiteId);
      if (!suite) return { content: [{ type: "text", text: `Suite #${suiteId} not found.` }], isError: true };
      const lines = [`Suite #${suite.id}: ${suite.name}`, `Type: ${suite.type}  Mode: ${suite.mode}`, "", "Members:"];
      for (const m of suite.tests) {
        const test = store.getTest(m.testId);
        lines.push(`  #${m.testId}  ${test?.name ?? "unknown"}  (pos=${m.position}, parallel=${m.parallel})`);
      }
      const runs = store.listSuiteRuns(suiteId);
      if (runs.length > 0) {
        lines.push("", "Recent runs:");
        for (const r of runs.slice(-5)) {
          const icon = r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : "→";
          lines.push(`  ${icon} Suite run #${r.id}  ${r.status}  ${r.startedAt}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "get_suite_run_result",
    {
      description: "Get detailed results for a suite run, including per-test status and errors.",
      inputSchema: { suiteRunId: z.number().describe("The suite run ID") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ suiteRunId }) => {
      const sr = store.getSuiteRunWithRuns(suiteRunId);
      if (!sr) return { content: [{ type: "text", text: `Suite run #${suiteRunId} not found.` }], isError: true };
      const icon = sr.status === "passed" ? "✓" : sr.status === "failed" ? "✗" : "→";
      const lines = [
        `${icon} Suite run #${sr.id}  suite=${sr.suiteId}  status=${sr.status}`,
        `Mode: ${sr.mode}  Started: ${sr.startedAt}  Finished: ${sr.finishedAt ?? "in progress"}`,
        "",
        "Test runs:",
      ];
      for (const r of sr.runs) {
        const ri = r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : "→";
        lines.push(`  ${ri} Run #${r.id}  test=${r.testId}  ${r.status}  llm=${r.llmCalls}`);
      }
      if (typeof sr.error === "string" && sr.error) lines.push("", `Error: ${sr.error}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "list_trains",
    {
      description: "List all trains (collections of suites) with their IDs, names, and modes.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const trains = store.listTrains();
      if (trains.length === 0) return { content: [{ type: "text", text: "No trains configured." }] };
      const lines = trains.map((t) => {
        const members = store.listTrainSuitesByTrain(t.id);
        return `#${t.id}  ${t.name}  (${t.mode}, ${members.length} suites)`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "delete_test",
    {
      description: "Delete a recorded test and all its steps by ID.",
      inputSchema: { testId: z.number().describe("The test ID to delete") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ testId }) => {
      const test = store.getTest(testId);
      if (!test) return { content: [{ type: "text", text: `Test #${testId} not found.` }], isError: true };
      store.deleteTest(testId);
      return { content: [{ type: "text", text: `Deleted test #${testId}: ${test.name}` }] };
    }
  );

  // ── Resources ──────────────────────────────────────────────────────────

  server.registerResource(
    "tests",
    "queryfirst://tests",
    {
      title: "All recorded tests",
      description: "List of all recorded UI tests with metadata",
      mimeType: "application/json",
    },
    async (uri) => {
      const tests = store.listTests().map((t) => ({
        id: t.id,
        name: t.name,
        source: t.source,
        entryUrl: t.entryUrl,
        stepCount: store.listStepsByTest(t.id).length,
        createdAt: t.createdAt,
      }));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(tests, null, 2) }] };
    }
  );

  server.registerResource(
    "test",
    new ResourceTemplate("queryfirst://tests/{testId}", { list: undefined }),
    {
      title: "Test detail",
      description: "Full test details including all steps",
      mimeType: "application/json",
    },
    async (uri, { testId }) => {
      const test = store.getTestWithSteps(Number(testId));
      if (!test) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "not_found" }) }] };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(test, null, 2) }] };
    }
  );

  server.registerResource(
    "suites",
    "queryfirst://suites",
    {
      title: "All test suites",
      description: "List of all test suites with member counts",
      mimeType: "application/json",
    },
    async (uri) => {
      const suites = store.listSuites().map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        mode: s.mode,
        memberCount: store.listSuiteTestsBySuite(s.id).length,
        createdAt: s.createdAt,
      }));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(suites, null, 2) }] };
    }
  );

  server.registerResource(
    "suite",
    new ResourceTemplate("queryfirst://suites/{suiteId}", { list: undefined }),
    {
      title: "Suite detail",
      description: "Full suite details including member tests and runs",
      mimeType: "application/json",
    },
    async (uri, { suiteId }) => {
      const suite = store.getSuiteWithTests(Number(suiteId));
      if (!suite) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "not_found" }) }] };
      const runs = store.listSuiteRuns(suite.id);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ ...suite, runs }, null, 2) }] };
    }
  );

  server.registerResource(
    "runs",
    "queryfirst://runs",
    {
      title: "All test runs",
      description: "Recent test runs across all tests",
      mimeType: "application/json",
    },
    async (uri) => {
      const runs = store.listRuns().slice(-50);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(runs, null, 2) }] };
    }
  );

  server.registerResource(
    "run",
    new ResourceTemplate("queryfirst://runs/{runId}", { list: undefined }),
    {
      title: "Run detail",
      description: "Full run details including per-step results",
      mimeType: "application/json",
    },
    async (uri, { runId }) => {
      const run = store.getRunWithSteps(Number(runId));
      if (!run) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "not_found" }) }] };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(run, null, 2) }] };
    }
  );

  server.registerResource(
    "suite_runs",
    "queryfirst://suite-runs",
    {
      title: "All suite runs",
      description: "Recent suite runs across all suites",
      mimeType: "application/json",
    },
    async (uri) => {
      const runs = store.listSuiteRunsPage({ limit: 50, offset: 0 });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(runs.runs, null, 2) }] };
    }
  );

  server.registerResource(
    "suite_run",
    new ResourceTemplate("queryfirst://suite-runs/{suiteRunId}", { list: undefined }),
    {
      title: "Suite run detail",
      description: "Full suite run details including per-test results",
      mimeType: "application/json",
    },
    async (uri, { suiteRunId }) => {
      const sr = store.getSuiteRunWithRuns(Number(suiteRunId));
      if (!sr) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "not_found" }) }] };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(sr, null, 2) }] };
    }
  );
}

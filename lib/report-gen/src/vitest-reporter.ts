import { join } from "node:path";
import type { Reporter } from "vitest/reporters";
import type { TestModule, TestCase, TestSuite, TestCollection } from "vitest/node";
import type { TestSuiteReport, TestSuiteGroup, TestResult, TestStatus } from "./types.js";
import { generatePdf } from "./pdf.js";

export interface VitestReportReporterOptions {
  outputDir?: string;
}

interface VitestTestError {
  name?: string;
  message?: string;
  stack?: string;
}

function mapVitestState(state: string): TestStatus {
  switch (state) {
    case "passed": return "passed";
    case "failed": return "failed";
    case "skipped": return "skipped";
    default: return "error";
  }
}

function formatErrors(errors: readonly VitestTestError[] | undefined): string | undefined {
  if (!errors || errors.length === 0) return undefined;
  return errors
    .map((e) => {
      const parts: string[] = [];
      if (e.name) parts.push(e.name);
      if (e.message) parts.push(e.message);
      if (e.stack) parts.push(e.stack);
      return parts.join("\n");
    })
    .join("\n\n");
}

function collectTests(collection: TestCollection): { tests: TestResult[]; groups: TestSuiteGroup[] } {
  const tests: TestResult[] = [];
  const groups: TestSuiteGroup[] = [];

  for (const item of collection.array()) {
    if (item.type === "test") {
      const tc = item as TestCase;
      const result = tc.result();
      const diagnostic = result.state !== "pending" ? tc.diagnostic() : undefined;
      tests.push({
        name: tc.name,
        status: mapVitestState(result.state),
        duration: diagnostic?.duration,
        error: result.state === "failed" ? formatErrors(result.errors as readonly VitestTestError[]) : undefined,
      });
    } else if (item.type === "suite") {
      const ts = item as TestSuite;
      const collected = collectTests(ts.children);
      groups.push({
        name: ts.name,
        tests: collected.tests,
        groups: collected.groups,
      });
    }
  }

  return { tests, groups };
}

function summarizeGroups(groups: TestSuiteGroup[]): { total: number; passed: number; failed: number; skipped: number } {
  let total = 0, passed = 0, failed = 0, skipped = 0;
  for (const g of groups) {
    for (const t of g.tests) {
      total++;
      if (t.status === "passed") passed++;
      else if (t.status === "failed" || t.status === "error") failed++;
      else skipped++;
    }
    if (g.groups) {
      const sub = summarizeGroups(g.groups);
      total += sub.total;
      passed += sub.passed;
      failed += sub.failed;
      skipped += sub.skipped;
    }
  }
  return { total, passed, failed, skipped };
}

export default class VitestReportReporter implements Reporter {
  private readonly outputDir: string;

  constructor(options?: VitestReportReporterOptions) {
    this.outputDir = options?.outputDir ?? join(process.cwd(), "test-reports");
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _unhandledErrors: ReadonlyArray<unknown>,
  ): Promise<void> {
    const allGroups: TestSuiteGroup[] = [];

    for (const mod of testModules) {
      const collected = collectTests(mod.children);
      if (collected.tests.length === 0 && collected.groups.length === 0) continue;
      allGroups.push({
        name: mod.project.name,
        tests: collected.tests,
        groups: collected.groups,
      });
    }

    const summary = summarizeGroups(allGroups);

    const report: TestSuiteReport = {
      title: `Vitest \u2014 ${testModules[0]?.project.name ?? "Tests"}`,
      timestamp: new Date().toISOString(),
      duration: 0,
      summary,
      suites: allGroups,
      metadata: {
        "Framework": "Vitest",
        "Node": process.version,
      },
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputPath = join(this.outputDir, `vitest-${timestamp}.pdf`);

    try {
      await generatePdf(report, outputPath);
      console.log(`\n\u2713 Test report generated: ${outputPath}`);
    } catch (err) {
      console.error(`\n\u2717 Failed to generate test report: ${err}`);
    }
  }
}

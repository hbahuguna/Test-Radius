import { join } from "node:path";
import type { Reporter, FullResult, FullConfig, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import type { TestSuiteReport, TestSuiteGroup, TestResult as ReportTestResult, TestStatus } from "./types.js";
import { generatePdf } from "./pdf.js";

export interface PlaywrightReportReporterOptions {
  outputDir?: string;
}

function mapPlaywrightStatus(status: string): TestStatus {
  switch (status) {
    case "passed": return "passed";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "timedOut": return "error";
    case "interrupted": return "error";
    default: return "error";
  }
}

function collectFromSuite(suite: Suite): TestSuiteGroup {
  const tests: ReportTestResult[] = [];
  const groups: TestSuiteGroup[] = [];

  for (const entry of suite.entries()) {
    if (entry.type === "test") {
      const tc = entry as TestCase;
      const results = tc.results;
      const lastResult = results[results.length - 1] as TestResult | undefined;

      tests.push({
        name: tc.title,
        status: mapPlaywrightStatus(lastResult?.status ?? "skipped"),
        duration: lastResult?.duration,
        error: lastResult?.error?.message,
        retries: results.length > 1 ? results.length - 1 : undefined,
      });
    } else {
      groups.push(collectFromSuite(entry as Suite));
    }
  }

  return { name: suite.title, tests, groups };
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

export default class PlaywrightReportReporter implements Reporter {
  private readonly outputDir: string;
  private suite: Suite | null = null;

  constructor(options?: PlaywrightReportReporterOptions) {
    this.outputDir = options?.outputDir ?? join(process.cwd(), "test-reports");
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }

  async onEnd(result: FullResult): Promise<void> {
    if (!this.suite) return;

    const groups: TestSuiteGroup[] = [];
    for (const entry of this.suite.entries()) {
      if (entry.type !== "test") {
        groups.push(collectFromSuite(entry as Suite));
      }
    }

    const summary = summarizeGroups(groups);
    const duration = result.startTime ? Date.now() - result.startTime.getTime() : 0;

    const report: TestSuiteReport = {
      title: "Playwright \u2014 E2E Tests",
      timestamp: new Date().toISOString(),
      duration,
      summary,
      suites: groups,
      metadata: {
        "Framework": "Playwright",
        "Status": result.status,
        "Node": process.version,
      },
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputPath = join(this.outputDir, `playwright-${timestamp}.pdf`);

    try {
      await generatePdf(report, outputPath);
      console.log(`\n\u2713 Test report generated: ${outputPath}`);
    } catch (err) {
      console.error(`\n\u2717 Failed to generate test report: ${err}`);
    }
  }
}

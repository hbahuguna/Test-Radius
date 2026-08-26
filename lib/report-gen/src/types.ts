export type TestStatus = "passed" | "failed" | "skipped" | "error";

export interface TestResult {
  name: string;
  status: TestStatus;
  duration?: number;
  error?: string;
  retries?: number;
  annotations?: Record<string, string>;
}

export interface TestSuiteGroup {
  name: string;
  tests: TestResult[];
  groups?: TestSuiteGroup[];
}

export interface TestSuiteReport {
  title: string;
  timestamp: string;
  duration: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  suites: TestSuiteGroup[];
  metadata?: Record<string, string>;
}

export interface ReportGeneratorOptions {
  outputDir?: string;
  fileName?: string;
}

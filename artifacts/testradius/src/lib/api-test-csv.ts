import { rawApiFetch } from "./fieldserve-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedApiTest {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  expectedStatus: number;
  assertions: { target: string; operator: string; expected: string }[];
  extractAs: string | null; // e.g. "created_job_id" — extracts JSON path from response
}

export interface ApiTestResult {
  name: string;
  method: string;
  path: string;
  status: "passed" | "failed" | "error";
  actual: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    duration: number;
  };
  assertionResults: { target: string; operator: string; expected: string; passed: boolean; actual: string }[];
  extractedVariable?: { name: string; value: string };
  error?: string;
  timestamp: string;
}

export interface ApiTestRun {
  id: string;
  name: string;
  type: "manual" | "csv" | "ai";
  totalTests: number;
  passed: number;
  failed: number;
  errors: number;
  duration: number;
  results: ApiTestResult[];
  variables: Record<string, string>;
  startedAt: string;
  completedAt: string;
}

export type VariableMap = Map<string, string>;

// ---------------------------------------------------------------------------
// CSV Parser
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

export function parseApiTestCsv(csv: string): ParsedApiTest[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const tests: ParsedApiTest[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] ?? "").trim();
    });

    const assertions: ParsedApiTest["assertions"] = [];
    if (row.expected_status || row.expected_status === "0") {
      assertions.push({
        target: "status",
        operator: "equals",
        expected: row.expected_status,
      });
    }
    if (row.expected_json_path) {
      assertions.push({
        target: row.expected_json_path,
        operator: row.expected_operator || "exists",
        expected: row.expected_value || "",
      });
    }

    // extract_as: e.g. "$.job.id→created_job_id" or just "created_job_id" (defaults to extracting from $.id)
    let extractAs: string | null = null;
    if (row.extract_as) {
      extractAs = row.extract_as.trim();
    }

    tests.push({
      name: row.name || `${row.method} ${row.path}`,
      method: (row.method || "GET").toUpperCase(),
      path: row.path || "/",
      headers: row.headers ? JSON.parse(row.headers) : {},
      body: row.body || "",
      expectedStatus: row.expected_status ? Number(row.expected_status) : 200,
      assertions,
      extractAs,
    });
  }

  return tests;
}

// ---------------------------------------------------------------------------
// Variable Substitution
// ---------------------------------------------------------------------------

/**
 * Replace {{variable}} placeholders in a string with values from the variable map.
 * Also supports {{variable|fallback}} syntax for optional variables.
 */
export function substituteVariables(input: string, variables: VariableMap): string {
  return input.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_match, name: string, fallback: string | undefined) => {
    return variables.get(name) ?? fallback ?? `{{${name}}}`;
  });
}

// ---------------------------------------------------------------------------
// JSON Path Extraction
// ---------------------------------------------------------------------------

function getJsonPathValue(json: unknown, path: string): string {
  if (!path) return "";
  const parts = path.replace(/^\$\./, "").split(".");
  let current: unknown = json;
  for (const part of parts) {
    if (current === null || current === undefined) return "";
    if (Array.isArray(current)) {
      const idx = Number(part);
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  if (current === undefined || current === null) return "";
  if (typeof current === "object") return JSON.stringify(current);
  return String(current);
}

function extractVariable(
  extractAs: string,
  responseBody: string,
): { name: string; value: string } | undefined {
  if (!extractAs) return undefined;

  // Support "json_path→var_name" syntax, e.g. "$.job.id→created_job_id"
  let jsonPath = "$.id";
  let varName = extractAs;

  if (extractAs.includes("→")) {
    const [pathPart, namePart] = extractAs.split("→");
    jsonPath = pathPart || "$.id";
    varName = namePart;
  } else {
    // Default: extract from $.id for simple names like "created_job_id"
    varName = extractAs;
    jsonPath = "$.id";
    // Try to guess a better path based on the response structure
    try {
      const parsed = JSON.parse(responseBody);
      if (typeof parsed === "object" && parsed !== null) {
        // If response has a single top-level key that's an object, drill into it
        const keys = Object.keys(parsed);
        if (keys.length === 1 && typeof parsed[keys[0]] === "object" && parsed[keys[0]] !== null) {
          const innerKeys = Object.keys(parsed[keys[0]]);
          if (innerKeys.includes("id")) {
            jsonPath = `$.${keys[0]}.id`;
          } else if (innerKeys.includes("status")) {
            jsonPath = `$.${keys[0]}.status`;
          }
        }
      }
    } catch {
      // not JSON, use default path
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return undefined;
  }

  const value = getJsonPathValue(parsed, jsonPath);
  if (value === "") return undefined;

  return { name: varName, value };
}

// ---------------------------------------------------------------------------
// Assertion Evaluation
// ---------------------------------------------------------------------------

function evaluateAssertion(
  assertion: { target: string; operator: string; expected: string },
  statusCode: number,
  responseBody: string,
  variables: VariableMap,
): { passed: boolean; actual: string } {
  // Substitute variables in the expected value
  const expected = substituteVariables(assertion.expected, variables);
  const target = substituteVariables(assertion.target, variables);

  if (target === "status") {
    const actual = String(statusCode);
    switch (assertion.operator) {
      case "equals": return { passed: actual === expected, actual };
      case "contains": return { passed: actual.includes(expected), actual };
      default: return { passed: actual === expected, actual };
    }
  }

  // JSON path assertion
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { passed: false, actual: "(invalid JSON)" };
  }

  const actualValue = getJsonPathValue(parsed, target);
  switch (assertion.operator) {
    case "equals": return { passed: actualValue === expected, actual: actualValue };
    case "contains": return { passed: actualValue.includes(expected), actual: actualValue };
    case "exists": return { passed: actualValue !== "", actual: actualValue || "(empty)" };
    case "matches": return { passed: new RegExp(expected).test(actualValue), actual: actualValue };
    default: return { passed: actualValue === expected, actual: actualValue };
  }
}

// ---------------------------------------------------------------------------
// Reset + Seed Helpers
// ---------------------------------------------------------------------------

async function resetAndSeed(): Promise<void> {
  await rawApiFetch("POST", "/reset");
  await rawApiFetch("POST", "/seed");
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

export async function runApiTests(
  tests: ParsedApiTest[],
  onResult?: (result: ApiTestResult, index: number, total: number) => void,
  signal?: AbortSignal,
  options?: { autoReset?: boolean },
): Promise<ApiTestRun> {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const results: ApiTestResult[] = [];
  const variables: VariableMap = new Map();
  let passed = 0;
  let failed = 0;
  let errors = 0;
  const startTime = performance.now();

  // Auto-reset before running tests (clean slate)
  if (options?.autoReset !== false) {
    try {
      await resetAndSeed();
    } catch {
      // If reset fails, continue anyway — tests may still work
    }
  }

  for (let i = 0; i < tests.length; i++) {
    if (signal?.aborted) break;

    const test = tests[i];

    // Substitute variables in path, headers, and body before sending
    const resolvedPath = substituteVariables(test.path, variables);
    const resolvedBody = substituteVariables(test.body, variables);
    const resolvedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(test.headers)) {
      resolvedHeaders[k] = substituteVariables(v, variables);
    }

    try {
      const response = await rawApiFetch(
        test.method,
        resolvedPath,
        Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
        resolvedBody || undefined,
      );

      const assertionResults = test.assertions.map((a) => {
        const result = evaluateAssertion(a, response.status, response.body, variables);
        return { ...a, ...result };
      });

      const allPassed = response.status === test.expectedStatus &&
        assertionResults.every((a) => a.passed);

      // Extract variable from response if extract_as is set
      let extractedVariable: ApiTestResult["extractedVariable"];
      if (test.extractAs) {
        const extracted = extractVariable(test.extractAs, response.body);
        if (extracted) {
          variables.set(extracted.name, extracted.value);
          extractedVariable = extracted;
        }
      }

      const result: ApiTestResult = {
        name: test.name,
        method: test.method,
        path: resolvedPath,
        status: allPassed ? "passed" : "failed",
        actual: {
          statusCode: response.status,
          headers: response.headers,
          body: response.body,
          duration: response.duration,
        },
        assertionResults,
        extractedVariable,
        timestamp: new Date().toISOString(),
      };

      if (allPassed) passed++;
      else failed++;

      results.push(result);
      onResult?.(result, i, tests.length);
    } catch (err) {
      const result: ApiTestResult = {
        name: test.name,
        method: test.method,
        path: resolvedPath,
        status: "error",
        actual: { statusCode: 0, headers: {}, body: "", duration: 0 },
        assertionResults: [],
        error: err instanceof Error ? err.message : "Unknown error",
        timestamp: new Date().toISOString(),
      };
      errors++;
      results.push(result);
      onResult?.(result, i, tests.length);
    }
  }

  return {
    id: runId,
    name: `Run ${new Date().toLocaleTimeString()}`,
    type: "csv",
    totalTests: tests.length,
    passed,
    failed,
    errors,
    duration: Math.round(performance.now() - startTime),
    results,
    variables: Object.fromEntries(variables),
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Export Results
// ---------------------------------------------------------------------------

export function resultsToCsv(run: ApiTestRun): string {
  const lines = ["name,method,path,status,actual_status,expected_status,duration_ms,error,extracted_variable"];
  for (const r of run.results) {
    lines.push([
      `"${r.name.replace(/"/g, '""')}"`,
      r.method,
      r.path,
      r.status,
      r.actual.statusCode,
      r.status === "error" ? "" : r.assertionResults.find((a) => a.target === "status")?.expected ?? "",
      r.actual.duration,
      r.error ? `"${r.error.replace(/"/g, '""')}"` : "",
      r.extractedVariable ? `${r.extractedVariable.name}=${r.extractedVariable.value}` : "",
    ].join(","));
  }
  return lines.join("\n");
}

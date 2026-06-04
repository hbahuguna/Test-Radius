title: Test Impact Analysis (TIA)
description: How TestRadius determines which tests to run for every code change
lastUpdated: 2026-06-04

Test Impact Analysis (TIA) is the core intelligence of TestRadius. It determines exactly which tests are impacted by a code change, so you run only the tests that matter.

---

## How TIA Works

### 1. Symbol Graph

TestRadius builds a graph of your codebase in Neo4j:

- **Symbol nodes** — each function, component, export, and class in your source code
- **TestSymbol nodes** — each test file in your test suite
- **EVIDENCE edges** — connections from test files to the symbols they exercise (discovered via code coverage instrumentation)

### 2. PR Analysis

When a PR arrives, TestRadius:

1. Fetches the list of changed files from GitHub
2. Looks up **Symbol nodes** whose `file_path` matches the changed files
3. Follows **EVIDENCE edges** to find the minimal set of tests covering those symbols
4. Scores symbols by `priority_risk_index` + evidence count
5. Returns only the impacted tests — not the entire suite

### 3. Cypher Query

Under the hood, TIA runs a dual-query against Neo4j:

```cypher
// Query 1: Find risky symbols in changed files
MATCH (p:Project {sql_id: $project_id})-[:CONTAINS]->(f:File)-[:DEFINES]->(s:Symbol)
WHERE f.path IN $file_paths
OPTIONAL MATCH (s)-[r:APPROVED_TEST]->(:TestSymbol)
WITH s, f, COALESCE(s.priority_risk_index, 0) as raw_pri, COUNT(r) as approved_count
OPTIONAL MATCH (ts_tests:TestSymbol)-[r2:EVIDENCE]->(s)
WITH s, f, raw_pri, approved_count, COUNT(r2) as tests_count
RETURN s.name, f.path, raw_pri + approved_count + tests_count as priority

// Query 2: Get existing test mappings for those symbols
MATCH (ts:TestSymbol)-[:EVIDENCE]->(s2:Symbol)
WHERE s2.file_path IN $file_paths
RETURN ts.name, ts.file_path, s2.name as impacted_symbol
```

### 4. Test Deduplication

Tests are deduplicated by file path. If two symbols in the same changed file both map to the same test, that test is only returned once.

---

## Symbol Resolution

TestRadius resolves symbols from TypeScript/JavaScript source using static analysis:

| Symbol Type | Examples |
|---|---|
| Component | `function Home()`, `const Home = () =>` |
| Export | `export const scrollToForm`, `export default Home` |
| Class | `class ApiClient` |
| Function | `function calculateTotal()`, `const handleSubmit = () =>` |

Each symbol has:
- **Name** — extracted from the AST
- **File path** — relative to repo root (`artifacts/testradius/src/pages/Home.tsx`)
- **Start/End line** — exact location in the source
- **Type** — component, export, function, class
- **Priority risk index** — computed risk score based on coupling and complexity

---

## Coverage Edge Discovery

EVIDENCE edges between tests and symbols are created during the instrumentation pipeline:

1. Istanbul coverage middleware instruments the Vite dev server
2. Each Playwright test file runs against the instrumented app
3. LCOV output maps covered source lines
4. TypeScriptSymbolResolver maps line ranges to the enclosing symbol
5. EVIDENCE edges stored in Neo4j: `(TestSymbol)-[:EVIDENCE]->(Symbol)`

---

## API Endpoint

```bash
curl -X POST http://localhost:8000/projects/1/analyze-pr \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "owner/repo",
    "pr_number": 42,
    "commit_sha": "abc123def",
    "file_paths": ["src/pages/Home.tsx"]
  }'
```

Response:

```json
{
  "impacted_symbols": ["Home", "scrollToForm"],
  "tests": [
    {
      "name": "Home page tests",
      "file": "artifacts/e2e-tests/tests/home.spec.ts"
    },
    {
      "name": "Navigation tests",
      "file": "artifacts/e2e-tests/tests/navigation.spec.ts"
    }
  ]
}
```

---

## Implementation

The TIA logic lives in:

| File | Purpose |
|---|---|
| `main.py` (lines 1164-1318) | `analyze_pr` endpoint — dual-query + response |
| `analysis/diff_parser.py` | PR diff parsing |
| `instrumentation/` | Coverage + symbol resolution pipeline |
| `graph/ingestor.py` | Neo4j graph operations |

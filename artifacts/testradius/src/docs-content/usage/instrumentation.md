title: Code Coverage Instrumentation
description: How TestRadius instruments your app to build the symbol-test graph
lastUpdated: 2026-06-04

The instrumentation pipeline is how TestRadius discovers which tests cover which code. It runs Playwright tests with Istanbul coverage enabled, then resolves covered source lines to symbolic code entities.

---

## Pipeline Overview

```
     +-------------------+
     |  Vite Dev Server  |  (COVERAGE=true, Istanbul plugin)
     +--------+----------+
              | Istanbul middleware
              v
     +-------------------+
     |  Playwright       |  (per-file test execution)
     |  Coverage JSON    |
     +--------+----------+
              | LCOV data
              v
     +-------------------+
     |  Symbol           |  (TypeScript AST -> line ranges)
     |  Resolver         |
     +--------+----------+
              | symbol mappings
              v
     +-------------------+
     |  Neo4j Storage    |  (Symbol + TestSymbol + EVIDENCE edges)
     +-------------------+
```

---

## Steps

### 1. Start Instrumented Dev Server

```bash
COVERAGE=true PORT=19143 BASE_PATH=/ pnpm --filter @workspace/testradius run dev
```

The `COVERAGE=true` environment variable activates the `vite-plugin-istanbul` plugin in `vite.config.ts`:

```ts
istanbul({
  include: "src/*",
  exclude: ["node_modules"],
})
```

This injects Istanbul instrumentation into every served JavaScript file.

### 2. Run Playwright Tests Per-File

Each test file is run individually against the instrumented dev server:

```bash
npx playwright test --config artifacts/e2e-tests/playwright.config.ts tests/home.spec.ts --reporter=json
```

The Playwright config's `webServer` directive automatically starts the instrumented dev server:

```ts
webServer: {
  command: `COVERAGE=true PORT=${PORT} BASE_PATH=/ pnpm --filter @workspace/testradius run dev`,
  url: BASE_URL,
  reuseExistingServer: !process.env.CI,
  timeout: 30000,
}
```

### 3. Extract Coverage Data

Istanbul produces window-level `__coverage__` data. The custom coverage reporter reads this after each test and produces per-file LCOV output showing which lines were covered.

### 4. Resolve Symbols

The `TypeScriptSymbolResolver` reads the TypeScript AST for each covered source file and maps covered line ranges to the enclosing symbol:

```python
# For each file with coverage data:
# 1. Parse TypeScript AST
# 2. Find all symbol declarations (function, const, class, export)
# 3. Match covered line ranges to symbol boundaries
# 4. Return symbol + covered line range pairs
```

### 5. Store in Neo4j

```cypher
// Create/update symbol nodes
MERGE (s:Symbol {
  name: $symbol_name,
  file_path: $file_path,
  project_id: $project_id
})

// Create/update test symbol nodes
MERGE (t:TestSymbol {
  name: $test_name,
  file_path: $test_file,
  project_id: $project_id
})

// Create EVIDENCE edge (test → symbol)
MERGE (t)-[:EVIDENCE]->(s)
```

---

## Running the Pipeline

### Via API

```bash
curl -X POST http://localhost:8000/projects/1/instrumentation/run
```

Response:

```json
{
  "symbols_created": 19,
  "tests_mapped": 6,
  "evidence_edges": 81,
  "status": "completed"
}
```

### Via CLI

```bash
docker compose --profile ml exec core-ml python3 -m testsquad_core.instrumentation.pipeline_worker \
  --project-id 1 \
  --repo-path /testradius
```

---

## Configuration

The instrumentation pipeline uses a `PlaywrightTestbedConfig` object:

```python
@dataclass
class PlaywrightTestbedConfig:
    test_dir: str                # e.g. "artifacts/e2e-tests"
    source_dir: str             # e.g. "artifacts/testradius/src"
    dev_server_port: int        # e.g. 19143
    max_workers: int            # parallel test execution
    coverage_threshold: float   # minimum coverage to accept
```

---

## Key Files

| File | Purpose |
|---|---|
| `instrumentation/playwright_pipeline.py` | Per-file Playwright runner + coverage collection |
| `instrumentation/symbol_resolver.py` | TypeScript AST → symbol line ranges |
| `instrumentation/neo4j_store.py` | Symbol + EVIDENCE edge storage |
| `instrumentation/pipeline_worker.py` | Orchestrator for the full pipeline |

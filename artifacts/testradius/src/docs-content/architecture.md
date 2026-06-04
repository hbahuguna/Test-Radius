title: System Architecture
description: How the six TestRadius services work together
lastUpdated: 2026-06-04

TestRadius is composed of six Docker services that form a complete test impact analysis pipeline.

---

## Service Overview

```
                    +-------------------+
                    |    GitHub App     |  (port 3000)
                    +--------+----------+
                             | webhooks
                             v
+-----------+       +-------+--------+       +-----------+
|   neo4j   |<------|    core-ml     |------>| executor  |
|  (7687)   |       |    (8000)      |       |  (8001)   |
+-----------+       +-------+--------+       +-----------+
                            |
                            v
                  +---------+--------+   +-----------+
                  |        db        |   |    ui     |
                  |  PostgreSQL 16   |   |  (5173)   |
                  +------------------+   +-----------+
```

### core-ml (Port 8000)

The central API server and ML engine. Handles:
- **Project management** — create and configure projects
- **Test Impact Analysis** — Neo4j-backed symbol-aware analysis
- **Instrumentation pipeline** — Playwright coverage collection and symbol resolution
- **Test execution orchestration** — delegates to the executor service
- **REST API** — all HTTP endpoints

### neo4j (Port 7687)

Graph database that stores the code analysis model:
- **Symbol nodes** — functions, components, and exports from source
- **TestSymbol nodes** — test files with their file paths
- **EVIDENCE edges** — which tests cover which symbols (from code coverage instrumentation)
- **APPROVED_TEST edges** — manually approved test mappings

### db (Port 5432)

PostgreSQL 16 storing operational data:
- Project configurations
- Feature flags
- Test run history and results
- User accounts (when not in demo mode)

### executor (Port 8001)

Isolated sandbox for test execution:
- Clones the target repo at a specific commit
- Installs dependencies via pnpm
- Runs Playwright (e2e) and Vitest (unit) tests
- Returns structured JSON results

### ui (Port 5173)

React + Vite + Tailwind CSS web dashboard:
- Project overview and status
- TIA analysis results visualisation
- Test execution history
- Blog and marketing pages

### GitHub App (Port 3000, separate process)

Node.js Express server that receives GitHub webhooks:
- `pull_request.opened` and `synchronize` events trigger auto-analysis
- Posts TIA results as PR comments
- Sets commit statuses (pending/success/failure)
- Uses JWT + installation token for GitHub API auth

---

## Data Flow

### PR Analysis Flow

```
1. GitHub push → webhook POST /api/github/webhooks
2. GitHub App validates webhook secret
3. POST /projects/:id/analyze-pr with full_name, pr_number, commit_sha
4. core-ml queries Neo4j:
   - Find symbols in changed files
   - Follow EVIDENCE edges to find impacted tests
   - Score by priority_risk_index + evidence count
5. Return impacted symbols + reusable tests
6. GitHub App posts comment on PR
```

### Test Execution Flow

```
1. POST /projects/:id/execute-tests with tests array + commit SHA
2. core-ml passes to executor
3. executor creates temp sandbox, clones repo at commit
4. Installs dependencies (pnpm install)
5. Installs Playwright Chromium (npx playwright install chromium)
6. Starts Vite dev server (via Playwright webServer config)
7. Runs Playwright tests, collects JSON results
8. Runs Vitest unit tests
9. Returns pass/fail per test
10. core-ml stores results in PostgreSQL
11. GitHub App updates PR with results comment + commit status
```

### Instrumentation Flow

```
1. POST /projects/:id/instrumentation/run
2. Pipeline reads target repo from TESTRADIUS_LOCAL_PATH mount
3. Starts Vite dev server with COVERAGE=true (Istanbul plugin)
4. For each Playwright test file:
   - Runs npx playwright test with JSON reporter + coverage
   - Istanbul produces LCOV coverage data
5. TypeScriptSymbolResolver maps covered lines to symbols
6. Stores Symbol + TestSymbol nodes + EVIDENCE edges in Neo4j
7. Returns summary (X symbols, Y tests, Z EVIDENCE edges created)
```

---

## Key Technology Stack

| Component | Technology |
|---|---|
| API / ML Engine | Python 3.12 (FastAPI + asyncio) |
| Graph Database | Neo4j 5 |
| Relational DB | PostgreSQL 16 |
| Test Runner | Playwright 1.52 + Vitest 4 |
| Frontend | React 18 + Vite + Tailwind CSS v4 |
| Coverage | Istanbul (Vite plugin) |
| Container Runtime | Docker Compose V2 |
| GitHub Integration | Node.js Express + GitHub App |
| Sandbox | Temporary git clone + pnpm install |

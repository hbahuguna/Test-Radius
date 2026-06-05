# TestRadius

Test Impact Analysis (TIA) that runs only the tests impacted by every code change. Powered by AST-based symbol resolution, Istanbul code coverage, and a Neo4j graph database. Deterministic, explainable, open source.

In a real-world validation on a mature Django monolith, TestRadius reduced required test runs from 735 to 42 — a 94% reduction — without missing a single relevant failure.

## Architecture

Six Docker services form a complete TIA pipeline:

| Service | Port | Role |
|---|---|---|
| `core-ml` | 8000 | TIA engine, API, ML pipeline |
| `executor` | 8001 | Isolated test execution sandbox |
| `ui` | 5173 | React + Vite web dashboard |
| `db` | 5432 | PostgreSQL (projects, run history) |
| `neo4j` | 7687 | Symbol graph + EVIDENCE edges |
| GitHub App | 3000 | Webhook handler (separate process) |

## Quickstart

```bash
git clone https://github.com/hbahuguna/Test-Radius.git
cd Test-Radius
docker compose --profile ml up -d
```

All six services start. Verify with `docker compose --profile ml ps`.

## Run TIA on a PR

```bash
# Create a project
curl -X POST http://localhost:8000/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "repo_url": "https://github.com/owner/repo"}'

# Enable instrumentation
curl -X PUT http://localhost:8000/projects/1/features \
  -H "Content-Type: application/json" \
  -d '{"instrumentation": true}'

# Run the instrumentation pipeline (discovers test→symbol edges)
curl -X POST http://localhost:8000/projects/1/instrumentation/run

# Analyze a PR — returns only impacted tests
curl -X POST http://localhost:8000/projects/1/analyze-pr \
  -H "Content-Type: application/json" \
  -d '{"full_name": "owner/repo", "pr_number": 1, "commit_sha": "abc123"}'
```

## How It Works

1. **Instrumentation pipeline** runs Playwright tests with Istanbul coverage, maps covered lines to TypeScript AST symbols, and stores `(TestSymbol)-[:EVIDENCE]->(Symbol)` edges in Neo4j.
2. **PR analysis** fetches changed files, queries Neo4j for impacted symbols and their covering tests, returns only the relevant test set.
3. **Test execution** clones the repo at the exact commit in a sandbox, installs deps, runs Playwright/Vitest, and posts results as a PR comment.

## Documentation

Full documentation at [testradius.dev/docs](https://testradius.dev/docs):
- Getting Started — one-command setup
- Architecture — service overview, data flows
- Usage — TIA, GitHub App, instrumentation, API
- Deploy — Docker, configuration, integrations
- Develop — local setup, testing, API reference
- Troubleshooting — common issues

## GitHub App Automation

The optional GitHub App (Node.js Express, port 3000) auto-triggers TIA on every `pull_request.opened` / `synchronize` event. Posts analysis comments and sets commit status automatically.

## Stack

| Component | Technology |
|---|---|
| API / ML Engine | Python 3.12 (FastAPI + asyncio) |
| Graph Database | Neo4j 5 |
| Relational DB | PostgreSQL 16 |
| Test Runner | Playwright 1.52 + Vitest 4 |
| Frontend | React 18 + Vite + Tailwind CSS v4 |
| Coverage | Istanbul (vite-plugin-istanbul) |
| Container Runtime | Docker Compose V2 |
| GitHub Integration | Node.js Express + GitHub App |
| Symbol Resolution | TypeScript AST (static analysis) |

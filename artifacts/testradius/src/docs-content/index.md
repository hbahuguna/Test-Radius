title: Getting Started
description: Get up and running with TestRadius in minutes
lastUpdated: 2026-06-04

TestRadius is an AI-native Test Impact Analysis (TIA) platform that tells you exactly which tests to run for every code change. Stop running entire test suites. Stop waiting on CI pipelines for feedback that could take seconds.

> **Validated result:** On a mature Django monolith with 735 tests, TestRadius reduced required test runs to 42 — a **94% reduction** — without missing a single relevant failure. Deterministic. Explainable. Open source.

---

## Prerequisites

Before you start, you'll need:

- **Docker** and **Docker Compose** with Compose V2 support
- **Git** for version control
- A GitHub account (for GitHub App integration)
- **Node.js 20+** and **pnpm 9+** (for local development)

---

## Quickstart

Start the entire TestRadius stack in one command:

```bash
docker compose --profile ml up -d
```

This starts six services:

| Service | Port | Purpose |
|---|---|---|
| `core-ml` | `8000` | TIA engine, API server, ML pipeline |
| `executor` | `8001` | Isolated test execution sandbox |
| `ui` | `5173` | Web dashboard |
| `db` | `5432` | PostgreSQL (project data, runs) |
| `neo4j` | `7687` | Neo4j graph DB (symbol graph, EVIDENCE edges) |

After startup, verify all services are healthy:

```bash
docker compose --profile ml ps
```

All six services should show `Up` or `healthy`.

---

## Configure Your First Project

Set up a project to analyze:

```bash
# Create a project
curl -X POST http://localhost:8000/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "repo_url": "https://github.com/owner/repo"}'

# Note the returned project_id, enable instrumentation
curl -X PUT http://localhost:8000/projects/1/features \
  -H "Content-Type: application/json" \
  -d '{"instrumentation": true}'
```

---

## Run TIA on a Pull Request

```bash
curl -X POST http://localhost:8000/projects/1/analyze-pr \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "owner/repo",
    "pr_number": 1,
    "commit_sha": "abc123"
  }'
```

The API returns impacted symbols and the minimal set of tests to run:

```json
{
  "impacted_symbols": ["Home", "scrollToForm"],
  "tests": [
    {"name": "Home page tests", "file": "tests/home.spec.ts"}
  ]
}
```

---

## Run Selected Tests

```bash
curl -X POST http://localhost:8000/projects/1/execute-tests \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Token: ghp_..." \
  -d '{
    "owner": "owner",
    "repo": "repo",
    "pr_number": 1,
    "commit_sha": "abc123",
    "tests": [
      {"name": "Home page tests", "file": "artifacts/e2e-tests/tests/home.spec.ts"}
    ]
  }'
```

---

## Next Steps

- [Architecture](/docs/architecture) — Understand the system components
- [TIA Concept](/docs/usage/tia) — How Test Impact Analysis works
- [GitHub App](/docs/usage/github-app) — Set up automated PR analysis
- [Docker Deployment](/docs/deploy/docker) — Production deployment guide

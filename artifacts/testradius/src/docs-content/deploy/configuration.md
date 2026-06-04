title: Environment Configuration
description: All environment variables and configuration options
lastUpdated: 2026-06-04

---

## Core Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (`postgresql+asyncpg://user:pass@db:5432/testsquad`) |
| `NEO4J_URL` | Yes | — | Neo4j bolt URL (`bolt://neo4j:7687`) |
| `NEO4J_USER` | Yes | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | Yes | — | Neo4j password |
| `DEMO_MODE` | No | `false` | Bypass authentication when `true` |
| `EXECUTOR_URL` | Yes | — | Executor service URL (`http://executor:8001`) |
| `GITHUB_TOKEN` | No | — | GitHub token for PR file fetching |

## UI Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | Yes | — | Dev server port |
| `BASE_PATH` | Yes | — | Base URL path (`/` or `/app`) |
| `COVERAGE` | No | — | Enable Istanbul instrumentation when set to `true` |

## GitHub App Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_APP_ID` | Yes | — | GitHub App ID (e.g. `3922550`) |
| `GITHUB_PRIVATE_KEY` | Yes | — | RSA private key (newlines as `\n`) |
| `GITHUB_WEBHOOK_SECRET` | Yes | — | Webhook secret (match GitHub App settings) |
| `TESTSQUAD_API_URL` | Yes | — | core-ml API URL (`http://core-ml:8000`) |
| `TESTSQUAD_PROJECT_MAPPING` | Yes | — | JSON mapping of `{"owner/repo": project_id}` |
| `PORT` | Yes | `3000` | GitHub App Express server port |

## Instrumentation

| Variable | Required | Default | Description |
|---|---|---|---|
| `TESTRADIUS_LOCAL_PATH` | No | — | Path to locally mounted repo (e.g. `/testradius`) |

---

## .env.example

```bash
# Database
DATABASE_URL=postgresql+asyncpg://testsquad:testsquad_password@db:5432/testsquad

# Neo4j Graph Database
NEO4J_URL=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=testsquad_password

# Demo mode (skip auth)
DEMO_MODE=true

# Executor
EXECUTOR_URL=http://executor:8001

# GitHub (optional, for PR fetching)
GITHUB_TOKEN=
```

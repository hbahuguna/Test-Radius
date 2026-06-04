title: REST API Usage
description: Using the TestRadius API for automated workflows
lastUpdated: 2026-06-04

The TestRadius API is the primary interface for programmatic interaction. All endpoints live on the `core-ml` service at port `8000`.

---

## Authentication

In development mode, set `DEMO_MODE=true` in `.env` to skip authentication.

In production, use the `/auth` endpoints to obtain a bearer token:

```bash
export TOKEN=$(curl -s -X POST http://localhost:8000/auth/token \
  -d "username=user&password=pass" | jq -r '.access_token')

curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/projects
```

---

## Projects

### List Projects

```bash
curl http://localhost:8000/projects
```

### Create Project

```bash
curl -X POST http://localhost:8000/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "repo_url": "https://github.com/owner/repo"}'
```

### Get Features

```bash
curl http://localhost:8000/projects/1/features
```

### Enable Feature Flag

```bash
curl -X PUT http://localhost:8000/projects/1/features \
  -H "Content-Type: application/json" \
  -d '{"instrumentation": true}'
```

---

## Analysis

### Analyze PR

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

### Execute Tests

```bash
curl -X POST http://localhost:8000/projects/1/execute-tests \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Token: ghp_xxxx" \
  -d '{
    "owner": "owner",
    "repo": "repo",
    "pr_number": 42,
    "commit_sha": "abc123def",
    "tests": [
      {"name": "Home tests", "file": "artifacts/e2e-tests/tests/home.spec.ts"}
    ]
  }'
```

The `X-GitHub-Token` header or `github_token` body field is required for cloning the repository.

---

## Instrumentation

### Run Instrumentation Pipeline

```bash
curl -X POST http://localhost:8000/projects/1/instrumentation/run
```

---

## Automation Sync

### Sync Automation Graph

```bash
curl -X POST http://localhost:8000/projects/1/sync-automation \
  -H "Content-Type: application/json" \
  -d '{"repo_url": "https://github.com/owner/repo"}'
```

---

## Health

```bash
curl http://localhost:8000/health
```
```json
{
  "status": "healthy",
  "services": {
    "neo4j": "connected",
    "database": "connected"
  }
}
```

---

## Error Responses

All endpoints return errors in a consistent format:

```json
{
  "detail": "Human-readable error message"
}
```

HTTP status codes:
- `400` — bad request (missing or invalid parameters)
- `404` — resource not found
- `403` — not authorized for this resource
- `500` — internal server error

title: API Reference
description: Complete REST API endpoint reference
lastUpdated: 2026-06-04

---

## Projects

### GET /projects

List all projects.

```bash
curl http://localhost:8000/projects
```

### POST /projects

Create a new project.

```json
{
  "name": "My Project",
  "repo_url": "https://github.com/owner/repo"
}
```

### GET /projects/{project_id}/features

Get feature flags for a project.

### PUT /projects/{project_id}/features

Enable/disable feature flags.

```json
{
  "instrumentation": true
}
```

---

## Analysis

### POST /projects/{project_id}/analyze-pr

Analyze a pull request for test impact.

| Field | Type | Required | Description |
|---|---|---|---|
| `full_name` | string | Yes | GitHub repo `owner/repo` |
| `pr_number` | integer | Yes | Pull request number |
| `commit_sha` | string | No | Commit SHA (default: `main`) |
| `file_paths` | string[] | No | Override PR file paths |

Response:

```json
{
  "impacted_symbols": ["Home", "scrollToForm"],
  "tests": [{"name": "...", "file": "..."}]
}
```

### POST /projects/{project_id}/execute-tests

Execute selected tests for a PR.

| Field | Type | Required | Description |
|---|---|---|---|
| `owner` | string | Yes | GitHub repo owner |
| `repo` | string | Yes | GitHub repo name |
| `pr_number` | integer | Yes | Pull request number |
| `commit_sha` | string | No | Commit SHA |
| `github_token` | string | No* | Token for cloning |
| `tests` | array | Yes | `[{name, file}]` |

*Or pass via `X-GitHub-Token` header.

---

## Instrumentation

### POST /projects/{project_id}/instrumentation/run

Run the full instrumentation pipeline (coverage → symbols → Neo4j).

---

## Automation

### POST /projects/{project_id}/sync-automation

Synchronize the automation graph for a project.

---

## Test Mapping

### GET /projects/{project_id}/test-mapping

Get test-to-symbol mappings.

### PUT /projects/{project_id}/test-mapping

Update test-to-symbol mappings (approve/reject).

### POST /projects/{project_id}/map-tests

Run test mapping algorithm.

### POST /projects/{project_id}/vector-map-tests

Run vector-based test mapping.

### POST /projects/{project_id}/siamese-map

Run Siamese network test mapping.

---

## Intelligence

### GET /projects/{project_id}/mapping-accuracy

Get test mapping accuracy metrics.

### GET /projects/{project_id}/training-data

Export training data.

### GET /projects/{project_id}/communities

Get symbol community clusters.

### GET /projects/{project_id}/communities/graph

Get community graph visualization data.

---

## Health

### GET /health

API health check.

```json
{
  "status": "healthy",
  "services": {
    "neo4j": "connected",
    "database": "connected"
  }
}
```

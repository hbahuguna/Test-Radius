title: Running Tests
description: How to run TestRadius's own test suite
lastUpdated: 2026-06-04

---

## Python Tests

The core-ml Python tests use `pytest`. Run inside the Docker container:

```bash
docker compose --profile ml exec core-ml pytest tests/ -v
```

Or run a specific test file:

```bash
docker compose --profile ml exec core-ml pytest tests/test_runner.py -v
```

For verbose coverage output:

```bash
docker compose --profile ml exec core-ml pytest tests/ -v --tb=short
```

---

## UI Tests

The website uses Vitest for unit tests and Playwright for e2e tests:

```bash
cd artifacts/testradius

# Unit tests
npx vitest run

# With watch mode
npx vitest

# Playwright e2e tests
npx playwright test --config artifacts/e2e-tests/playwright.config.ts
```

The Playwright config auto-starts the Vite dev server before running tests (via the `webServer` directive).

---

## Integration Test: Full E2E Pipeline

Test the complete flow end-to-end:

```bash
# 1. Ensure Docker services are running
docker compose --profile ml ps

# 2. Run instrumentation pipeline
curl -X POST http://localhost:8000/projects/1/instrumentation/run

# 3. Analyze a PR
curl -X POST http://localhost:8000/projects/1/analyze-pr \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "owner/repo",
    "pr_number": 1,
    "commit_sha": "main",
    "file_paths": ["artifacts/testradius/src/pages/Home.tsx"]
  }'

# 4. Execute impacted tests
curl -X POST http://localhost:8000/projects/1/execute-tests \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Token: your-token" \
  -d '{
    "owner": "owner",
    "repo": "repo",
    "pr_number": 1,
    "commit_sha": "main",
    "tests": [
      {"name": "Home tests", "file": "artifacts/e2e-tests/tests/home.spec.ts"}
    ]
  }'
```

---

## Verifying Neo4j State

```bash
# Count symbols
docker compose --profile ml exec neo4j cypher-shell -u neo4j -p testsquad_password "
MATCH (s:Symbol) WHERE s.project_id = 1 RETURN count(s);
"

# Count EVIDENCE edges
docker compose --profile ml exec neo4j cypher-shell -u neo4j -p testsquad_password "
MATCH ()-[r:EVIDENCE]->() RETURN count(r);
"
```

---

## ShellCheck

Shell scripts use ShellCheck:

```bash
shellcheck services/**/*.sh
```

Zero violations required for CI.

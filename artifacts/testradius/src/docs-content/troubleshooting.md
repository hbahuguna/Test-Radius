title: Troubleshooting
description: Common issues and their solutions
lastUpdated: 2026-06-04

---

## Docker Services

### Container exits immediately

Check the logs:

```bash
docker compose --profile ml logs <service-name>
```

Common causes:
- Missing `.env` file with required environment variables
- Port already in use — change the host port mapping
- Volume mount path doesn't exist

### Neo4j fails to start

```bash
docker compose --profile ml logs neo4j
```

Ensure you have enough memory allocated to Docker. Neo4j 5 requires at least 2GB of heap.

If Neo4j has stale data, reset it:

```bash
docker compose --profile ml down -v
docker compose --profile ml up -d
```

### core-ml cannot connect to Neo4j

Verify the Neo4j connection in `.env`:

```
NEO4J_URL=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=testsquad_password
```

Check that neo4j is actually running:

```bash
docker compose --profile ml exec neo4j cypher-shell -u neo4j -p testsquad_password "RETURN 1;"
```

---

## Instrumentation Pipeline

### No symbols found after instrumentation

Run with verbose logging:

```bash
curl -X POST http://localhost:8000/projects/1/instrumentation/run
```

Then check the Neo4j state:

```bash
docker compose --profile ml exec neo4j cypher-shell -u neo4j -p testsquad_password "
MATCH (s:Symbol) WHERE s.project_id = 1 RETURN count(s);
"
```

Common causes:
- `COVERAGE=true` not set when starting the dev server
- Istanbul plugin not configured in `vite.config.ts`
- Test files don't exercise the source code (no EVIDENCE edges created)

### Symbol file paths don't match PR file paths

The instrumentation pipeline strips the mount prefix (`/testradius/`) from symbol file paths. Verify normalized paths are correct:

```bash
docker compose --profile ml exec neo4j cypher-shell -u neo4j -p testsquad_password "
MATCH (s:Symbol {project_id: 1}) RETURN s.name, s.file_path LIMIT 5;
"
```

Paths should be relative to the repo root (e.g., `artifacts/testradius/src/pages/Home.tsx`).

---

## TIA Analysis

### analyze-pr returns empty tests

Check that:
1. The project has `instrumentation` feature flag enabled
2. Instrumentation pipeline has run and produced EVIDENCE edges
3. The changed files match symbol file_paths in Neo4j
4. The PR file paths are correct (repo-root-relative)

Verify feature flag:

```bash
curl http://localhost:8000/projects/1/features
```
```json
{"instrumentation": true}
```

### PR file paths don't match

TestRadius expects file paths relative to the repo root. GitHub API returns paths like `src/pages/Home.tsx` — the symbol file_paths in Neo4j should be stored the same way.

---

## Test Execution

### Playwright tests fail with " browserType.launch: Executable doesn't exist"

The test sandbox needs Playwright browsers installed. This happens automatically when `execute-tests` runs, but you can also install manually:

```bash
npx playwright install --with-deps chromium
```

Check that the test runner has the browser install step (test_runner.py, `run_tests` function).

### Vitest tests fail with "Cannot find module"

The test runner injects missing dependencies into `package.json` and runs `pnpm install`. If a module is still missing:

1. Add it to the test runner's `test_pkgs` dict
2. Or ensure the repo's `package.json` already has it

### Tests pass locally but fail in the sandbox

The sandbox clones a fresh copy of the repo at the specified commit SHA. Any uncommitted changes won't be present. Common issues:
- Missing `.env` files (not in git)
- Missing build artifacts (not in git)
- Different Node.js version in the Docker container

---

## GitHub App

### Webhook returns 401

Check the webhook secret in:

1. GitHub App settings (webhook secret)
2. `services/github-app/.env` (`GITHUB_WEBHOOK_SECRET`)

They must match exactly.

### PR comment not posted

Check the GitHub App logs:

```bash
cd services/github-app && node app.js
```

Common issues:
- JWT generation failure (check private key format)
- Installation token expired (should auto-refresh)
- App not installed on the target repo
- `TESTSQUAD_PROJECT_MAPPING` not set in the app `.env`

### ngrok tunnel issues

```bash
ngrok http 3000
```

The free ngrok plan has:
- Random subdomain on each restart
- 40 connections/minute limit
- 8-hour session timeout

Update the webhook URL in GitHub App settings after each ngrok restart.

---

## General

### "Demo mode" and auth bypass

Set `DEMO_MODE=true` in `.env` to skip authentication. This is useful for local development and testing.

### Port conflicts

If a port is already in use, change the host mapping in `docker-compose.yml`:

```yaml
ports:
  - "8001:8000"  # host:container
```

### Reset everything

```bash
docker compose --profile ml down -v
docker compose --profile ml up -d
```

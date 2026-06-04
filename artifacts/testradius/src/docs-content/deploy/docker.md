title: Docker Compose Deployment
description: Deploy TestRadius with Docker Compose
lastUpdated: 2026-06-04

TestRadius uses Docker Compose for both development and production deployments.

---

## Services

```yaml
services:
  core-ml:       # TIA engine + API server (Python 3.12)
  executor:      # Test execution sandbox (Python 3.12)
  ui:            # Web dashboard (Vite dev server)
  db:            # PostgreSQL 16
  neo4j:         # Neo4j 5 graph database
```

## Startup

```bash
# Start all services including ML pipeline
docker compose --profile ml up -d

# Start without ML services (API-only)
docker compose up -d
```

The `--profile ml` flag activates `core-ml`, `executor`, and `neo4j` services. Without it, only `ui` and `db` start.

---

## Volumes

```yaml
volumes:
  - ./services/core/testsquad_core:/app/testsquad_core
  - ./packages/shared:/app/packages/shared
  - ./method2test:/app/method2test
  - /tmp/testsquad-workspaces:/tmp/testsquad-workspaces
  - /Users/skaparwan/Git/Test-Radius:/testradius
```

The local repo mount (`/testradius`) allows the instrumentation pipeline to access your source code directly without cloning.

---

## Networks

All services are connected via a `testsquad-net` bridge network. Services communicate by container name:

- `core-ml` → `neo4j:7687`
- `core-ml` → `db:5432`
- `core-ml` → `executor:8001`

---

## Health Checks

The `db` and `neo4j` services include health checks:

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U testsquad"]
  interval: 5s
  timeout: 5s
  retries: 5
```

Wait for all services to be healthy:

```bash
docker compose --profile ml ps
```

All services should show `Up` or `healthy`.

---

## Building for Production

For production, build the Docker images first:

```bash
docker compose --profile ml build
```

Then push to a container registry:

```bash
docker tag testradius-core-ml registry.example.com/testradius/core-ml:latest
docker push registry.example.com/testradius/core-ml:latest
```

---

## Key Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Service definitions, volumes, networks |
| `services/core/Dockerfile` | core-ml + executor image |
| `.env` | Environment variables (gitignored) |
| `.env.example` | Template with documented variables |

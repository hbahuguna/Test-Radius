title: Local Development Setup
description: Set up your local environment for TestRadius development
lastUpdated: 2026-06-04

---

## Prerequisites

- **Python 3.12+** (for core-ml and executor)
- **Node.js 20+** (for UI and GitHub App)
- **pnpm 9+** (JavaScript package manager)
- **Docker** and **Docker Compose** V2
- **Neo4j 5** (optional — runs in Docker)

---

## Clone the Repository

```bash
git clone https://github.com/owner/testradius.git
cd testradius
```

---

## Set Up Environment

```bash
cp .env.example .env
# Edit .env with your configuration
```

Key variables for development:

```
DATABASE_URL=postgresql+asyncpg://testsquad:testsquad_password@db:5432/testsquad
NEO4J_URL=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=testsquad_password
DEMO_MODE=true
EXECUTOR_URL=http://executor:8001
```

---

## Start Services

```bash
# Start all services
docker compose --profile ml up -d

# Verify
docker compose --profile ml ps

# Check logs
docker compose --profile ml logs -f core-ml
```

---

## Developing the UI

The website lives at `/Users/skaparwan/Git/Test-Radius/artifacts/testradius/`:

```bash
cd artifacts/testradius
cp .env.example .env
# Edit PORT and BASE_PATH
pnpm install
pnpm run dev
```

---

## Developing the API

The core-ml service auto-reloads because the source is volume-mounted:

```yaml
volumes:
  - ./services/core/testsquad_core:/app/testsquad_core
```

Changes to Python files are reflected instantly. For dependency changes, rebuild:

```bash
docker compose --profile ml build core-ml
docker compose --profile ml up -d core-ml
```

---

## Developing the GitHub App

```bash
cd services/github-app
node app.js
```

For hot-reloading during development, use `nodemon`:

```bash
npm install -g nodemon
nodemon app.js
```

---

## File Layout

```
testradius/
├── docker-compose.yml           # Service orchestration
├── services/
│   ├── core/
│   │   ├── Dockerfile
│   │   └── testsquad_core/      # Python API + ML pipeline
│   │       ├── main.py          # FastAPI server
│   │       ├── test_runner.py   # Test execution sandbox
│   │       ├── tia/             # Test Impact Analysis
│   │       ├── analysis/        # Symbol analysis
│   │       ├── instrumentation/ # Coverage pipeline
│   │       └── graph/           # Neo4j client
│   ├── executor/                # Test sandbox
│   └── github-app/              # GitHub webhook handler
├── packages/
│   └── shared/                  # Shared Python code
├── method2test/                 # Testing methodology
└── ui/                          # Product dashboard
```

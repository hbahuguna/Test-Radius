title: Test Execution
description: How TestRadius runs tests in an isolated sandbox
lastUpdated: 2026-06-04

Once TIA identifies the impacted tests, TestRadius executes them in a sandboxed environment and reports pass/fail results.

---

## Execution Flow

```
+----------+     +-----------+     +----------------------+
|  GitHub  |---->|  core-ml  |---->|      executor        |
|  App     |     |  (API)    |     |   (test sandbox)     |
+----------+     +-----------+     +----------------------+
                                            |
                                    +-------+--------+
                                    |  temp dir      |
                                    |  git init      |
                                    |  git fetch     |
                                    |  git checkout  |
                                    |  pnpm install  |
                                    |  npx playwright|
                                    |  install chromium|
                                    +-------+--------+
                                            |
                                    +-------+--------+
                                    |  npx playwright |
                                    |  test           |
                                    |  (auto-starts   |
                                    |   dev server)   |
                                    +-------+--------+
                                            |
                                    +-------+--------+
                                    |  JSON results  |
                                    |  -> API response|
                                    +----------------+
```

---

## Sandbox Setup

The `run_tests()` function in `test_runner.py` creates an isolated environment for each execution:

### 1. Clone at Exact Commit

```python
clone_dir = tempfile.mkdtemp(prefix="testradius-run-")
git init <clone_dir>
git remote add origin <repo_url>
git fetch --depth 1 origin <commit_sha>
git checkout <commit_sha>
```

Using `--depth 1` keeps the clone fast — only the target commit is needed.

### 2. Install Dependencies

```bash
pnpm install
```

The test runner ensures required packages are present by injecting missing dependencies into `package.json`:

- `vitest` — unit test framework
- `jsdom` — DOM environment for React component tests
- `@testing-library/react` + `@testing-library/jest-dom` — React testing utilities
- `@playwright/test` — e2e test framework

### 3. Install Playwright Browser

```bash
npx playwright install --with-deps chromium
```

The `--with-deps` flag also installs system-level library dependencies via apt-get.

### 4. Run Tests

**Playwright e2e tests:**

```bash
npx playwright test --config artifacts/e2e-tests/playwright.config.ts \
  --reporter=json \
  artifacts/e2e-tests/tests/home.spec.ts
```

The Playwright config's `webServer` directive auto-starts the Vite dev server and waits for it to be ready before executing tests.

**Vitest unit tests:**

```bash
./node_modules/.bin/vitest run --reporter=json <test_files>
```

Vitest unit tests run in jsdom (no browser needed).

---

## Test Classification

Tests are split into two groups:

| Group | Detected by | Runner | Framework |
|---|---|---|---|
| e2e | `"e2e-tests" in file path` | Playwright | `@playwright/test` |
| unit | everything else | Vitest + jsdom | `@testing-library/react` |

---

## Results

The executor returns structured results:

```json
{
  "status": "completed_with_failures",
  "total": 6,
  "passed": 3,
  "failed": 3,
  "results": [
    {
      "name": "home.spec.ts > hero section renders with tagline",
      "file": "artifacts/e2e-tests/tests/home.spec.ts",
      "status": "passed",
      "duration": "2.1s",
      "error": ""
    },
    {
      "name": "home.spec.ts > stat counters display",
      "file": "artifacts/e2e-tests/tests/home.spec.ts",
      "status": "failed",
      "duration": "3.4s",
      "error": "Timed out waiting for element..."
    }
  ]
}
```

The GitHub App posts these results as a PR comment and sets the commit status (green checkmark / red X).

---

## Key Files

| File | Purpose |
|---|---|
| `test_runner.py` | `run_tests()` — sandbox lifecycle |
| `main.py` (`/execute-tests` endpoint) | API entry point |
| `clients/executor.py` | HTTP client to the executor service |

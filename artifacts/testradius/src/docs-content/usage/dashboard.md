title: Dashboard UI
description: Web-based dashboard for managing projects and viewing TIA results
lastUpdated: 2026-06-04

The TestRadius web dashboard provides a visual interface for managing your projects, viewing TIA analysis results, and monitoring test executions.

---

## Accessing the Dashboard

The UI service runs on port `5173`:

```
http://localhost:5173
```

In production, this would be served behind a reverse proxy at `https://testradius.app`.

---

## Pages

### Home

The marketing landing page introduces TestRadius, highlights key features (TIA, instrumentation, automated test execution), and includes the early access signup form.

### Project Selection

Select a project from the repository selector to view its analysis results and configuration.

### TIA Results

Displays:
- Impacted symbols for the selected PR
- Recommended test selection with file paths
- Priority score for each symbol
- Test mapping evidence

### Test Execution History

After tests run, results are displayed with:
- Pass/fail status per test
- Test duration
- Error messages for failures
- Overall pass rate

---

## Configuration

The dashboard runs on the `testradius.dev` Vite + React codebase at:

```
artifacts/testradius/
```

Key environment variables:
- `PORT` — port for the dev server
- `BASE_PATH` — base URL path (e.g., `/` or `/app`)

---

## Key Files

| File | Purpose |
|---|---|
| `src/App.tsx` | Wouter router with all routes |
| `src/pages/Home.tsx` | Marketing landing page |
| `src/components/Header.tsx` | Navigation bar |
| `src/components/Footer.tsx` | Site footer |
| `vite.config.ts` | Build and dev server configuration |

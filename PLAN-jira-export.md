# TestRadius Phase 4 — Jira Project Export

## Project: TRP4 — TestSprite Parity Platform

**Board**: TRP4 Kanban  
**Project Lead**: [PM Name]  
**Start Date**: [TBD]  
**Target Completion**: 4 weeks  
**Labels used**: `phase-4`, `browser-agent`, `python`, `frontend`, `api-server`, `db`, `ci`

---

## Epic TRP4-1: DB Persistence & Run History (DB)

| Field | Value |
|-------|-------|
| **Summary** | Persist browser-agent runs to PostgreSQL with enhanced schema for groups, schedules, and failure bundles |
| **Priority** | Highest |
| **Story Points** | 8 |
| **Dependencies** | None — foundation for all other epics |

### Story TRP4-2: Extend `agenticRunsTable` schema

**Description**: Add columns to support Phase 4 features: groupId, scheduleId, stepCount, duration, failureBundle (jsonb), videoUrl, metadata (jsonb).

**Acceptance Criteria**:
- Migration adds all 7 new columns
- Existing rows get null defaults
- Drizzle schema types are updated and export cleanly

#### Tasks
| Key | Task | Assignee | Estimate (h) |
|-----|------|----------|--------------|
| TRP4-3 | Write PostgreSQL migration for `agentic_runs` table | | 2 |
| TRP4-4 | Update Drizzle `agenticRunsTable` definition in `lib/db/src/schema/users.ts` | | 1 |
| TRP4-5 | Update `InsertAgenticRun` / `AgenticRun` TypeScript types | | 0.5 |
| TRP4-6 | Verify `pnpm run typecheck` passes across all workspaces | | 0.5 |

#### Test Plan

**Unit Tests**:
- Verify Drizzle schema compiles with all 7 new columns
- Verify `InsertAgenticRun` type accepts optional `failureBundle`, `metadata`, `videoUrl`, `groupId`, `scheduleId`, `stepCount`, `duration`
- Verify existing code relying on old type still compiles (backward compat)

**Integration Tests**:
- Run migration against empty PostgreSQL, verify `agentic_runs` has all 7 new columns with correct types (jsonb, uuid, integer, text)
- Run migration against table with 3 existing rows, verify existing rows have `NULL` in new columns
- `ROLLBACK` migration, verify columns are removed

**Edge Cases**:
- `failureBundle` jsonb with deeply nested objects (5+ levels)
- `metadata` with 50+ key-value pairs (large payload)
- `videoUrl` with special characters in filename
- `duration` = 0 (run completed instantly)
- `stepCount` = 0 (run failed before any steps)
- Null values for all optional fields on existing rows

**Test Data**:
- 3 existing rows with varied `status` values (completed, failed, stopped)
- 1 row with `completedAt` set, 1 with null `completedAt`

---

### Story TRP4-7: Create `test_groups` table

**Description**: New table to organize runs into named groups. Join table `test_group_runs` for many-to-many.

**Acceptance Criteria**:
- `testGroupsTable` with id, userId, name, description, createdAt
- `testGroupRunsTable` with id, groupId (cascade delete), runId (cascade delete), order
- Both exported from DB package

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-8 | Write migration for `test_groups` table | 1.5 |
| TRP4-9 | Write migration for `test_group_runs` join table | 1 |
| TRP4-10 | Define Drizzle schemas in new file `lib/db/src/schema/groups.ts` | 1 |
| TRP4-11 | Export from `lib/db/src/index.ts` | 0.5 |

#### Test Plan

**Unit Tests**:
- Verify `testGroupsTable` schema compiles with all columns
- Verify `testGroupRunsTable` has correct foreign key references (onDelete cascade)
- Verify `order` column defaults to 0
- Verify both tables exported from DB package index

**Integration Tests**:
- Run migration, query `information_schema.columns` for both tables — verify all columns present
- Insert a group → insert 3 runs → insert 3 join rows → query with JOIN — verify data round-trips
- Delete a group → verify `test_group_runs` rows cascade-deleted
- Delete a run → verify `test_group_runs` rows cascade-deleted
- Add 2 runs to same group with order=0,1 — verify ordering

**Edge Cases**:
- Group with 0 runs (empty group — allowed)
- Group name > 255 characters (truncate or reject)
- Same run_id added to same group twice (should allow or upsert?)
- `order` column with gaps (order=0, order=5 — should still work)
- userId references a user that doesn't exist (FK constraint violation — expected)

**Test Data**:
- 2 test groups: "Smoke Tests", "Regression Suite"
- 3 agentic runs with known IDs
- Join rows with order 0, 1, 2 for "Smoke Tests"

---

### Story TRP4-12: Create `test_schedules` table

**Description**: Table for scheduled/routine test runs. Stores cron expressions, URL, goal, model config. Scheduler service reads from this.

**Acceptance Criteria**:
- `testSchedulesTable` with all fields: id, userId, name, url, goal, cronExpression, timezone, modelId, enabled, lastRunAt, nextRunAt, createdAt
- Drizzle schema and types exported

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-13 | Write migration for `test_schedules` table | 1.5 |
| TRP4-14 | Define Drizzle schema in `lib/db/src/schema/schedules.ts` | 1 |
| TRP4-15 | Export from DB package index | 0.5 |

#### Test Plan

**Unit Tests**:
- Verify `testSchedulesTable` compiles with all 11 columns
- Verify `enabled` defaults to `true`
- Verify `lastRunAt` and `nextRunAt` are nullable timestamps
- Verify `cronExpression` is required (not null)

**Integration Tests**:
- Run migration, verify table structure via `information_schema`
- Insert schedule with valid cron `"0 8 * * 1-5"` (weekdays at 8am)
- Insert schedule with enabled=false — query should return it but scheduler should skip
- Insert schedule with null `modelId` — verify nullable
- Update `nextRunAt` — verify change persists

**Edge Cases**:
- Cron expression `"* * * * *"` (every minute — valid for testing)
- Very long cron expression (e.g., with comma-separated hours/minutes)
- Timezone `"UTC"` vs `"America/New_York"` — verify stored as text
- `url` with query parameters and fragments
- `goal` with 2000+ characters
- `nextRunAt` set in the past (should be picked up by next scheduler tick)
- Disabled schedule: `enabled=false`, should never trigger

**Test Data**:
| Name | Cron | Timezone | Enabled |
|------|------|----------|---------|
| Daily Smoke Test | `"0 8 * * 1-5"` | UTC | true |
| Weekly Regression | `"0 6 * * 6"` | US/Eastern | true |
| Disabled Old | `"0 */2 * * *"` | UTC | false |

---

### Story TRP4-16: Wire browser-agent route to DB persistence

**Description**: Currently `POST /api/browser-agent/run` doesn't write to `agenticRunsTable`. Modify to INSERT on start and UPDATE on completion.

**Acceptance Criteria**:
- Run INSERT happens before streaming begins (status=`running`)
- After SSE stream ends, UPDATE with status, stepCount, duration, failureBundle
- The missing `GET /api/browser-agent/runs` endpoint is implemented (queries DB for auth'd user)
- Frontend run history loads from DB instead of falling back to empty array

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-17 | Add `INSERT` before `startBrowserAgentRun()` in `routes/browser-agent.ts` | 2 |
| TRP4-18 | Capture final event data after stream ends and `UPDATE` row | 3 |
| TRP4-19 | Implement `GET /api/browser-agent/runs` endpoint | 1.5 |
| TRP4-20 | Fix frontend to pass `run_id` back from start response (currently not tracked) | 2 |
| TRP4-21 | Remove in-memory `userRuns` Map, rely on DB | 1 |

#### Test Plan

**Unit Tests (API Server)**:
- Mock `db.insert()` and `db.update()` — verify INSERT called before Python streaming
- Mock streaming completes with `done` event — verify UPDATE called with correct status, stepCount
- Mock streaming completes with `error` event — verify UPDATE with status="failed"
- Verify `GET /api/browser-agent/runs` returns runs sorted by `createdAt DESC`, limited to auth'd user

**Integration Tests**:
- Start a browser-agent run via API → verify row appears in `agentic_runs` with status="running"
- Wait for run to complete → verify row updated with status="completed" or "failed", stepCount > 0
- Query `GET /api/browser-agent/runs` → verify response contains the completed run
- Start 2 runs for user A, 1 run for user B → verify user A sees only their 2 runs

**E2E Tests**:
- Open `/browser-agent`, configure URL + goal, click "Start Agent"
- After completion, navigate away and back → verify Run History shows the persisted run
- Refresh page → verify run still appears in history
- Start a run, stop it mid-way → verify row has status="stopped"

**Edge Cases**:
- User starts run but closes browser tab before stream completes → row stays as "running" (stale row handling)
- Two concurrent runs for same user → both get separate rows with different run_ids
- INSERT succeeds but stream fails → verify row has status="failed" eventually
- `stepCount` = 0 for run that errors before first step
- `failureBundle` = null for successful run

**Test Data**:
- 3 completed runs, 1 failed run, 1 running run (stale)
- Runs for 2 different users to test auth isolation

---

## Epic TRP4-22: Python Backend Upgrades (Python)

| Field | Value |
|-------|-------|
| **Summary** | Enhance `server.py` with multi-agent parallel runs, failure bundle generation, video recording, and self-healing retry logic |
| **Priority** | High |
| **Story Points** | 21 |
| **Dependencies** | TRP4-1 (failure bundle schema) |

### Story TRP4-23: Multi-agent parallel run endpoint

**Description**: New `POST /run/parallel` endpoint that spawns N agents concurrently with configurable `parallel_limit` semaphore. Returns `batch_id` + list of `run_ids`. New `GET /run/batch/{batch_id}/status` for aggregated status.

**Acceptance Criteria**:
- Endpoint accepts array of agent configs
- Uses `asyncio.Semaphore` to limit concurrency
- Returns batch_id immediately; agents run in background
- Aggregated status endpoint returns per-run and summary status
- SSE streaming per individual run still works

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-24 | Define `BatchRunRequest` Pydantic model | 1 |
| TRP4-25 | Add `state.batches` dict to `AgentStateManager` | 1 |
| TRP4-26 | Implement `/run/parallel` endpoint | 3 |
| TRP4-27 | Implement batch status aggregation logic | 2 |
| TRP4-28 | Add `/run/batch/{batch_id}/status` endpoint | 1 |
| TRP4-29 | Test with 3 concurrent agents on simple pages | 2 |

#### Test Plan

**Unit Tests**:
- Create `BatchRunRequest` with 0 agents → validation should reject (min 1)
- Create with 6 agents + parallel_limit=3 → should accept and semaphore should limit to 3 concurrent
- Verify `state.batches[batch_id]` structured correctly: `{ batch_id, run_ids[], status, created_at }`
- Verify batch status aggregation: 2 completed + 1 running → status="running", completed=2, total=3

**Integration Tests**:
- POST 3 agents pointing to https://example.com, https://google.com, https://github.com →
  - Response returns batch_id + 3 run_ids within 2 seconds
  - All 3 runs eventually reach "completed" status
  - `GET /run/batch/{batch_id}/status` returns correct per-run and aggregate status
- POST 3 agents with parallel_limit=1 → agents run sequentially, verify via timestamps
- Verify SSE streaming still works on individual runs via `/run/{run_id}/stream`
- Stop batch via individual `/run/{run_id}/stop` for one agent → verify other 2 continue

**Edge Cases**:
- 1 agent in batch (degenerate case — should work like single run)
- 10+ agents in batch with parallel_limit=5 — verify only 5 run concurrently
- All agents fail → batch status="failed" with per-run error details
- One agent fails, others succeed → batch status="partial_failure"
- Cancel batch mid-flight → verify all running tasks cancelled
- Network timeout on one URL → that agent fails, others continue

**Test Data**:
- 3 known-good URLs: example.com, httpbin.org/get, github.com
- 1 known-bad URL: https://this-domain-does-not-exist-12345.com
- 1 slow URL: https://httpbin.org/delay/10

---

### Story TRP4-30: Failure bundle generation

**Description**: Capture DOM snapshots on error steps. Bundle screenshot + DOM + action history + root cause + fix suggestion into a `failure_bundle` field on the final `done`/`error` SSE event.

**Acceptance Criteria**:
- DOM snapshot (`page.content()`) captured when a step action errors
- Action history accumulated in `state.step_events`
- Root cause extracted (element not found, timeout, assertion fail)
- Fix suggestion generated based on error type
- Bundle included in final SSE event as `failure_bundle` field

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-31 | Add DOM snapshot capture in `step_callback` on error | 2 |
| TRP4-32 | Implement `extract_root_cause()` helper | 2 |
| TRP4-33 | Implement `generate_fix_suggestion()` helper | 2 |
| TRP4-34 | Attach failure_bundle to final SSE events | 1 |
| TRP4-35 | Add `/run/{id}/failure-bundle` GET endpoint | 1 |

#### Test Plan

**Unit Tests**:
- Call `extract_root_cause()` with `ElementNotFoundError` → returns `"element_not_found"`
- Call `extract_root_cause()` with `TimeoutError` → returns `"timeout"`
- Call `extract_root_cause()` with generic `Exception("assertion failed: expected 5, got 3")` → extracts meaningful string
- Call `generate_fix_suggestion("element_not_found")` → returns suggestion containing "wait" or "scroll"
- Call `generate_fix_suggestion("timeout")` → returns suggestion containing "increase timeout" or "check network"
- Verify failure_bundle JSON structure: `{ dom_snapshot, screenshot, action_history[], root_cause, fix_suggestion }`

**Integration Tests**:
- Point agent at a page with a deliberately broken interaction (e.g., form with submit button that's hidden)
- Verify `GET /run/{id}/failure-bundle` returns non-null bundle
- Verify `dom_snapshot` is valid HTML (starts with `<!DOCTYPE html>` or `<html`)
- Verify `screenshot` is valid base64 (decodes to JPEG)
- Verify `action_history` is a non-empty array of step events
- Verify `root_cause` is a non-empty string
- Verify `fix_suggestion` is a non-empty string
- Run a successful task → verify `GET /run/{id}/failure-bundle` returns `null`

**Edge Cases**:
- Agent fails before first step (no page loaded) → `dom_snapshot` should be null
- DOM snapshot > 1MB (large page) → should still be captured, consider truncation
- Screenshot capture fails → `screenshot` should be null, other fields still populated
- Error with no model_output → `action_history` may be empty array
- Multiple errors in same run → failure_bundle captures last error state

**Test Data**:
- Page: https://the-internet.herokuapp.com/dynamic_loading (known dynamic loading)
- Page: local test page with intentionally broken JavaScript
- Page: https://httpstat.us/500 (server error)

---

### Story TRP4-36: Video recording

**Description**: Pass `record_video_dir` to `Browser` config. Emit video file path in the `done` event.

**Acceptance Criteria**:
- Browser configured with `record_video_dir` based on run_id
- Video file path emitted in `done` event
- `GET /run/{id}/video` serves the mp4 file
- Directory cleaned up after configurable TTL

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-37 | Add video recording to Browser config in `run_agent_task()` | 1.5 |
| TRP4-38 | Add video path to `done` event emission | 0.5 |
| TRP4-39 | Implement `/run/{id}/video` endpoint serving static video | 1 |
| TRP4-40 | Add cleanup task for old video files | 1 |

#### Test Plan

**Unit Tests**:
- Verify `record_video_dir` path is unique per run_id (e.g., `/tmp/browser-agent-videos/{run_id}`)
- Verify `done` event includes `video_path` field when recording enabled
- Verify `done` event sets `video_path` to `null` when recording disabled or fails

**Integration Tests**:
- Start a run with default config → verify video file created in `/tmp/browser-agent-videos/{run_id}/`
- `GET /run/{id}/video` → verify response is `video/mp4` content type
- `GET /run/{id}/video` → verify file size > 0 bytes
- Download video → verify it plays back in VLC/browser (can use `ffprobe` to check valid mp4 header)
- Run that completes in < 3 seconds → video should still be available (even if short)
- Run `cleanup` task → verify old video files deleted

**Edge Cases**:
- `record_video_dir` directory doesn't exist → should be auto-created
- Disk full → agent should still run, video_path = null
- Very long run (10+ minutes) → verify video file isn't corrupted (check moov atom)
- Concurrent runs → both videos saved to separate directories
- Cleanup TTL = 1 hour → files older than 1h deleted, newer files preserved
- Video encoding takes time after agent finishes → handle race in `done` event

**Test Data**:
- Run https://example.com with goal "Describe the page content" (quick, 2-3 steps)
- Run https://books.toscrape.com with goal "Navigate to Science category and list book titles" (5-10 steps)

---

### Story TRP4-41: Self-healing retry logic

**Description**: Wrap `agent.run()` with up to 2 retries on element-not-found / stale-selector errors. Track retry count. Emit `retry` event so frontend can display.

**Acceptance Criteria**:
- Agent retries up to 2 times on element-not-found errors
- `retry` SSE event emitted with attempt number
- Run still fails after exhausting retries
- Retry count stored in state

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-42 | Wrap `agent.run()` with try/except/retry loop | 2 |
| TRP4-43 | Emit `retry` SSE event between attempts | 1 |
| TRP4-44 | Track retries in `state.runs[run_id]` | 0.5 |
| TRP4-45 | Test against page with deliberately stale selectors | 2 |

#### Test Plan

**Unit Tests**:
- Mock `agent.run()` to throw `ElementNotFoundError` on first call, succeed on second → verify 1 retry
- Mock `agent.run()` to throw `ElementNotFoundError` 3 times → verify retry count = 2 then final failure
- Verify `retry` event structure: `{ event: "retry", attempt: 1, max_retries: 2, error: "..." }`
- Verify `state.runs[run_id]["retries"]` increments correctly
- Mock non-retryable error (e.g., `ValueError`) → verify no retry, original error propagated

**Integration Tests**:
- Create test HTML page with element that appears after 5 seconds delay (simulate dynamic load)
- Point agent at page with goal to "Click the button that appears after delay"
- Verify agent retries up to 2 times before succeeding (or verify retry events emitted)
- Use httpbin.org/delay/5 for a slow-loading page
- Point agent at a page where element never appears → verify 2 retries then final failure
- Run without errors → verify no `retry` events, `retries` = 0

**Edge Cases**:
- Error on step 1 with retry → agent should restart from step 1 (not resume mid-way)
- Error on step 5 with retry → agent should restart from beginning with new browser session
- Mix of retryable and non-retryable errors → only retry on known retryable errors
- `max_failures` (agent-level) vs retry loop → ensure they don't conflict
- Very short task that completes in 1 step → retry path should never execute

**Test Data**:
- Static HTML page served via local HTTP server with `setTimeout` to add a button after 5s
- https://the-internet.herokuapp.com/dynamic_loading/2 (element rendered after loading)

---

### Story TRP4-46: Aggregate runs stats endpoint

**Description**: `GET /runs/stats` returns pass/fail counts, average duration, and trend data for dashboard consumption.

**Acceptance Criteria**:
- Endpoint returns `{ total, passed, failed, avgDuration, runsByDay[] }`
- Data computed from `state.runs` (in-memory, since Python layer is ephemeral)
- Compatible with null/incomplete runs

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-47 | Implement `/runs/stats` aggregation logic | 2 |
| TRP4-48 | Add endpoint to `server.py` | 0.5 |

#### Test Plan

**Unit Tests**:
- State with 10 runs (7 passed, 3 failed) → `total=10, passed=7, failed=3, passRate=70.0`
- State with 0 runs → `total=0, passed=0, failed=0, passRate=0.0, avgDuration=0`
- State with mixed statuses: 5 passed, 2 failed, 1 running, 1 stopped → `passed=5, failed=2, running=1, stopped=1`
- Verify `runsByDay` returns last 30 days with correct counts per day
- Verify `avgDuration` computed correctly as mean of all non-null durations

**Integration Tests**:
- `GET /runs/stats` → verify JSON response matches expected shape
- Run 3 successful agents → stats update to reflect
- Run 1 failing agent → stats update to reflect
- Verify response time < 100ms even with 100 runs in state

**Edge Cases**:
- Run with `duration=None` → excluded from avgDuration calculation
- Run with `success=None` (still running) → excluded from pass/fail counts
- No runs in last 30 days → `runsByDay` returns empty array or zero-filled days
- Single run with duration=0 → avgDuration=0 (division by zero guard)
- Run with `status="pending"` → counted in total but not in pass/fail

**Test Data**:
- Populate state with 20 runs across 5 days: varying durations (2s to 120s), mixed pass/fail

---

## Epic TRP4-49: API Server New Routes (API)

| Field | Value |
|-------|-------|
| **Summary** | New Express route modules: scheduler CRUD, test groups CRUD, dashboard stats, CI endpoints |
| **Priority** | High |
| **Story Points** | 21 |
| **Dependencies** | TRP4-1 (DB tables must exist) |

### Story TRP4-50: Scheduler CRUD routes

**Description**: Full REST API for test schedules: create, list, update, delete, run-now. Routes registered at `/api/test-scheduler/`.

**Acceptance Criteria**:
- `POST /schedules` — create schedule, compute nextRunAt from cron expression
- `GET /schedules` — list auth'd user's schedules
- `PUT /schedules/:id` — update, recompute nextRunAt
- `DELETE /schedules/:id` — set `enabled=false` (soft delete)
- `POST /schedules/:id/run-now` — immediately execute via browser-agent
- Input validation with Zod on all endpoints

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-51 | Create `routes/test-scheduler.ts` with route scaffold | 1 |
| TRP4-52 | Implement POST and GET schedules | 3 |
| TRP4-53 | Implement PUT and DELETE schedules | 2 |
| TRP4-54 | Implement run-now — proxy to browser-agent start | 2 |
| TRP4-55 | Register router in `routes/index.ts` | 0.5 |
| TRP4-56 | Build cron-expression parser / nextRunAt utility in `lib/cron.ts` | 2 |

#### Test Plan

**Unit Tests (Zod Validation)**:
- `POST /schedules` with missing `url` → 400 `{ error: "validation_error" }`
- `POST /schedules` with invalid cron `"not-a-cron"` → 400
- `POST /schedules` with valid data → 201, response includes `nextRunAt` in future
- `PUT /schedules/:id` with wrong userId → 404 (scoped to auth'd user)
- `DELETE /schedules/:id` → updates `enabled=false`, does NOT delete row

**Integration Tests**:
- Create schedule → GET schedules → verify in list with correct `nextRunAt`
- Create schedule with cron `"0 8 * * 1-5"` → verify `nextRunAt` is next weekday at 8:00 UTC
- Update schedule's cron → verify `nextRunAt` recalculated
- Soft-delete schedule → verify `GET /schedules` still returns it with `enabled=false`
- Run-now → verify a new `agentic_runs` row created with `scheduleId` linked
- Create 2 schedules for user A, 1 for user B → verify isolation

**Edge Cases**:
- Cron with `*/5 * * * *` every 5 minutes → nextRunAt within next 5 min
- Cron for last day of month `0 0 28-31 * *` → handle months with < 31 days
- Timezone offset: set schedule with `timezone="Pacific/Auckland"` (UTC+12/+13) → verify nextRunAt computed in that zone
- Update schedule while a run-now is in progress → should not affect running agent
- Run-now on disabled schedule → should still execute (user-initiated override)
- Run-now when API server is down → error returned gracefully

**Test Data**:
| Name | Cron | Expected nextRunAt behavior |
|------|------|----------------------------|
| Daily at 9am | `"0 9 * * *"` | Today at 9am if before 9, else tomorrow |
| Weekdays 8am | `"0 8 * * 1-5"` | Skip weekends |
| Every 30 min | `"*/30 * * * *"` | Next :00 or :30 |
| Monthly 1st | `"0 0 1 * *"` | 1st of next month |

---

### Story TRP4-57: Test groups CRUD routes

**Description**: REST API for organizing runs into groups. Routes at `/api/test-groups`.

**Acceptance Criteria**:
- Full CRUD for groups (POST/GET/PUT/DELETE)
- `POST /api/test-groups/:id/runs` — add runs to group
- `GET /api/test-groups/:id/runs` — list runs in group with status
- `POST /api/test-groups/:id/run-all` — execute all runs in parallel

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-58 | Create `routes/test-groups.ts` scaffold | 1 |
| TRP4-59 | Implement CRUD for groups | 2 |
| TRP4-60 | Implement run management endpoints | 2 |
| TRP4-61 | Implement run-all with multi-agent batch call | 3 |
| TRP4-62 | Register router in `routes/index.ts` | 0.5 |

#### Test Plan

**Unit Tests**:
- `POST /api/test-groups` with empty `name` → 400
- `POST /api/test-groups` with valid data → 201, returns group with `id`
- `PUT /api/test-groups/:id` with non-existent id → 404
- `DELETE /api/test-groups/:id` → hard delete of group and cascade to join table
- `POST /api/test-groups/:id/runs` with non-existent run_id → 404
- `POST /api/test-groups/:id/run-all` with empty group → 400 (no runs to execute)

**Integration Tests**:
- Create group → GET list → verify group in response
- Add 3 runs to group → GET runs → verify all 3 returned with status
- Remove a run from group → verify join row deleted
- Run-all → verify batch created via multi-agent endpoint, batch_id returned
- Run-all with 5 runs → verify all 5 complete
- Delete group → verify group and join rows deleted (run rows preserved)

**Edge Cases**:
- Add same run to group twice → should be idempotent (upsert or ignore)
- Group with 20 runs run-all → verify parallel_limit respected
- Group where all runs have invalid URLs → each fails individually, group-all reports partial failure
- Delete group while run-all in progress → runs should complete (orphaned runs are fine)
- User A cannot see user B's groups
- Update group name to same as existing group → allowed (no unique constraint on name)

**Test Data**:
- Group: "Login Flow Tests" with runs for: login page, forgot password, signup, logout
- Group: "Checkout Flow" with runs for: add to cart, payment, confirmation

---

### Story TRP4-63: Dashboard stats route

**Description**: `GET /api/dashboard/stats` aggregates run data for the frontend dashboard widgets.

**Acceptance Criteria**:
- Returns totalRuns, passRate (%), avgDuration (s)
- Returns `runsByDay[]` for chart (last 30 days)
- Returns `topFailedUrls[]` (top 5 URLs by failure count)
- Returns `recentRuns[]` (last 20 runs with status + duration)
- All scoped to auth'd user

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-64 | Create `routes/dashboard.ts` | 1 |
| TRP4-65 | Implement stats aggregation queries against `agenticRunsTable` | 3 |
| TRP4-66 | Register router | 0.5 |

#### Test Plan

**Unit Tests**:
- Mock DB with 50 runs (35 passed, 15 failed) → `totalRuns=50, passRate=70.0, failedCount=15`
- Mock DB with 0 runs → `totalRuns=0, passRate=0, avgDuration=0, runsByDay=[]`
- Mock DB with runs across 30 days → `runsByDay` has 30 entries with correct daily counts
- Mock DB with failures across URLs → `topFailedUrls` returns top 5 sorted by fail count desc
- Mock DB with 25 runs → `recentRuns` returns 20 (limited)

**Integration Tests**:
- `GET /api/dashboard/stats` → verify JSON shape matches expected
- User A has 10 runs, user B has 5 → verify isolation
- Create 3 failed runs with same URL → verify URL appears in `topFailedUrls`
- Verify response time < 200ms with 1000 runs in DB
- Average duration computed correctly: runs with 2s, 4s, 6s → avg = 4s

**Edge Cases**:
- Run with `duration=null` → excluded from avgDuration
- Run with `status="running"` → excluded from pass/fail, included in totalRuns
- Run with `success=true` but `status="failed"` → handle inconsistency (treat success as source of truth)
- Zero runs for a given day → `runsByDay` entry for that day should have `{ date, passed: 0, failed: 0, total: 0 }`
- More than 5 URLs with failures → only top 5 returned
- User with no runs → all values zero/empty, no error

**Test Data**:
| Scenario | Runs | Expected |
|----------|------|----------|
| All pass | 10 passed | passRate=100% |
| All fail | 10 failed | passRate=0% |
| Mixed | 70% pass, 30% fail | passRate=70% |
| No data | 0 | passRate=0, no error |
| Single URL failing | /login fails 5 times | /login is top failure |

---

### Story TRP4-67: CI integration API

**Description**: Token-authenticated endpoints for external CI systems. No session cookie required — uses API key header.

**Acceptance Criteria**:
- `POST /api/ci/run` — accepts url, goal, model; returns run_id
- `GET /api/ci/run/:id/status` — returns status + success boolean
- `GET /api/ci/run/:id/report` — structured JSON report with failure details
- `POST /api/ci/run/:id/cancel` — cancels run
- Auth via `X-API-Key` header, validated against `userApiKeysTable`
- Rate limiting applied

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-68 | Create CI API key auth middleware in `middlewares/ci-auth.ts` | 2 |
| TRP4-69 | Create `routes/ci.ts` with endpoint scaffold | 1.5 |
| TRP4-70 | Implement run, status, report, cancel endpoints | 3 |
| TRP4-71 | Add rate limiting middleware | 1 |
| TRP4-72 | Register router | 0.5 |

#### Test Plan

**Unit Tests**:
- Middleware: valid API key in `X-API-Key` header → `req.user` populated, next() called
- Middleware: missing header → 401 `{ error: "missing_api_key" }`
- Middleware: invalid key → 401 `{ error: "invalid_api_key" }`
- Middleware: expired/revoked key → 401
- Rate limiter: 10 requests in 1 second from same IP → 11th returns 429
- `POST /api/ci/run` without `url` → 400
- `POST /api/ci/run` with valid data → 201, `{ run_id, status: "queued" }`
- `GET /api/ci/run/:id/report` with completed run → contains `status, success, steps, duration, summary, replay_url`

**Integration Tests**:
- Create API key via POST /api/keys → use key to call POST /api/ci/run → verify run created
- POST /api/ci/run → poll GET /api/ci/run/:id/status every 2s until status != "running" → verify eventual completion
- POST /api/ci/run → GET /api/ci/run/:id/report → verify structured JSON
- POST /api/ci/run → POST /api/ci/run/:id/cancel → verify status becomes "cancelled"
- 2 concurrent POST /api/ci/run → both return valid run_ids
- Rate limit: send 15 requests rapid-fire → 11th+ get 429

**Edge Cases**:
- API key with spaces in header → strip whitespace
- CI run that takes 30+ minutes → report endpoint should still work after completion
- Cancel a run that's already completed → returns 409 "run already completed"
- Report for a run that doesn't exist → 404
- CI endpoint called without rate limit header → still subject to rate limiting
- API key deleted between POST and GET → POST should succeed (key validated at request time)
- Very long goal text (> 5000 chars) → truncate or reject

**Test Data**:
- CI API key: `tr_ci_abc123def456` (test key in seed data)
- Test URLs: `https://example.com`, `https://httpstat.us/200`

---

### Story TRP4-73: In-process cron scheduler service

**Description**: Lightweight scheduler daemon using `node-cron` that checks every minute for due schedules and triggers runs.

**Acceptance Criteria**:
- Scheduler starts with API server
- Every 60s, queries `test_schedules` where `nextRunAt <= now AND enabled=true`
- Triggers browser-agent run for each due schedule
- Updates `lastRunAt` and `nextRunAt` after completion
- Graceful shutdown on server stop

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-74 | Create `lib/scheduler.ts` with `startScheduler()` | 3 |
| TRP4-75 | Implement schedule tick logic and run triggering | 3 |
| TRP4-76 | Wire `startScheduler()` into `index.ts` startup | 0.5 |
| TRP4-77 | Add graceful shutdown to cancel pending tasks | 1 |

#### Test Plan

**Unit Tests**:
- Create `startScheduler()` → returns `{ stop: () => void }`
- Call `stop()` → interval cleared, no more ticks
- Mock DB query returning 2 due schedules → verify `startBrowserAgentRun` called twice with correct params
- Mock DB query returning 0 due schedules → verify no calls to `startBrowserAgentRun`
- Mock `startBrowserAgentRun` throwing → verify error logged, tick continues

**Integration Tests**:
- Create schedule with `nextRunAt` set to 1 minute ago → wait up to 70s → verify run created and linked to schedule
- Create schedule with `enabled=false` and `nextRunAt` in past → wait 70s → verify no run created
- Verify `lastRunAt` updated after run completes (may need to wait for full run)
- Verify `nextRunAt` advanced to next valid time after run
- Stop API server → verify scheduler stops gracefully (no pending promises)

**Edge Cases**:
- Schedule due while previous run for same schedule still in progress → skip tick (prevent overlap)
- Server starts, immediately checks for due schedules → should not miss schedules due during startup
- 20 schedules due at same time → should not overwhelm system (consider batching or queue)
- Clock drift: server clock changes → next tick picks up any missed schedules
- Database connection fails during tick → error logged, retry on next tick
- Schedule deleted after being picked up by tick → INSERT for run should still work (scheduleId becomes orphan)

**Test Data**:
- Schedule due every 2 minutes: cron `"*/2 * * * *"`, nextRunAt = now - 1min
- Schedule due in 1 hour: nextRunAt = now + 1h
- Disabled schedule that was due: enabled=false, nextRunAt = now - 5min

---

### Story TRP4-78: Replay endpoint

**Description**: `GET /api/browser-agent/runs/:id/steps` returns all step events for a completed run, enabling frontend replay.

**Acceptance Criteria**:
- Loads step events from DB (stored as part of metadata or separate table)
- Returns ordered array of step events with screenshots, actions, reasoning
- Handles missing data gracefully

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-79 | Design step event persistence strategy (jsonb on agenticRunsTable or separate table) | 1 |
| TRP4-80 | Implement step saving during run (in browser-agent.ts stream handler) | 2 |
| TRP4-81 | Create replay endpoint | 1 |

#### Test Plan

**Unit Tests**:
- Verify step events schema: `{ step_number, screenshot, model_output, url, title, timestamp }`
- Empty steps array for run with no steps → returns `{ steps: [] }`
- Run with 10 steps → endpoint returns array of 10 step objects
- `screenshot` field: verify base64 string or null
- `model_output` field: verify `{ thinking, evaluation_previous_goal, memory, next_goal, actions }` shape

**Integration Tests**:
- Complete a run with 5+ steps → GET replay endpoint → verify 5+ step events returned
- Complete a run → replay endpoint returns steps in chronological order (step_number ascending)
- Verify screenshot data URLs are valid base64 images (check header: `data:image/jpeg;base64,...`)
- Verify `model_output.actions` array contains action objects with `name` and `raw` fields
- Run that failed on step 1 → verify 1 step event returned
- Non-existent run_id → 404

**Edge Cases**:
- Run with 50 steps → verify all 50 returned, response time < 500ms
- Screenshots > 500KB each in base64 → verify response not truncated (or consider pagination)
- Run from older version that didn't capture step events → `steps` is empty array
- Step where `model_output` is null → field set to null, not missing
- Concurrent requests for same run → both return identical data
- Run that's still running → return steps available so far (partial data)

**Test Data**:
- Single run with: 7 steps, mix of click and input actions, screenshots for steps 1-7

---

## Epic TRP4-82: Scheduling UI (Frontend)

| Field | Value |
|-------|-------|
| **Summary** | New frontend pages and components for creating, viewing, and managing scheduled test runs |
| **Priority** | Medium |
| **Story Points** | 13 |
| **Dependencies** | TRP4-49 (scheduler API routes) |

### Story TRP4-83: Schedules list page

**Description**: New `/schedules` route. Shows all user's schedules as cards with status, next run time, last run result.

**Acceptance Criteria**:
- Route added to `App.tsx` wrapped in `<ProtectedRoute>`
- Cards display: name, URL (truncated), goal (truncated), cron schedule description, next run, last run result (pass/fail icon)
- "Run Now" button on each card
- Empty state with CTA to create first schedule
- Responsive: stacks on mobile

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-84 | Create `pages/TestScheduler.tsx` page component | 3 |
| TRP4-85 | Create `components/test-scheduler/ScheduleCard.tsx` | 2 |
| TRP4-86 | Create `components/test-scheduler/ScheduleList.tsx` | 1.5 |
| TRP4-87 | Add `/schedules` route in `App.tsx` | 0.5 |
| TRP4-88 | Create `lib/test-scheduler-api.ts` API client | 2 |
| TRP4-89 | Add nav link to Layout component | 0.5 |

#### Test Plan

**Manual QA Steps**:
- Navigate to `/schedules` with no schedules → see empty state with "Create your first schedule" CTA button
- Navigate to `/schedules` with 3 schedules → see 3 cards in a responsive grid
- Each card shows: schedule name, truncated URL, truncated goal, human-readable cron ("Weekdays at 8:00 AM"), next run time in relative format ("in 3 hours"), last run result (green checkmark / red X)
- "Run Now" button click → button shows loading spinner, run starts, toast confirms
- Mobile viewport (375px): cards stack vertically, text truncation works
- Click nav link from other pages → `/schedules` loads correctly
- Page reloads → schedules persist (loaded from API)

**Edge Cases**:
- Schedule name > 30 chars → truncated with ellipsis
- URL > 50 chars → truncated with ellipsis
- Goal > 100 chars → truncated with ellipsis
- Last run result unknown (never run) → show "Never run" badge instead of pass/fail
- Next run time far in future (2027-01-01) → show absolute date instead of relative
- API returns 500 → show error toast with retry button
- 20+ schedules → list scrolls, no performance degradation
- Schedule with very long name (100+ chars) → cards maintain layout integrity

**Automated Tests (E2E)**:
```typescript
test("shows empty state when no schedules exist", async ({ page }) => {
  await page.goto("/schedules");
  await expect(page.getByText("Create your first schedule")).toBeVisible();
});

test("displays schedule cards", async ({ page }) => {
  // seed 2 schedules via API
  await page.goto("/schedules");
  await expect(page.getByTestId("schedule-card")).toHaveCount(2);
});

test("run-now button triggers agent", async ({ page }) => {
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Run Now" }).first().click();
  await expect(page.getByText("Run started")).toBeVisible();
});
```

---

### Story TRP4-90: Schedule create/edit form

**Description**: Form dialog/page to create or edit a schedule. Includes friendly cron builder.

**Acceptance Criteria**:
- Form fields: name, URL, goal, model selector, schedule preset picker, custom cron
- Cron presets: "Every hour", "Daily 8am M-F", "Weekly Monday 6am", "Custom"
- Custom cron shows raw input with validation and human-readable preview
- "Next run time" preview displayed
- Saves via POST/PUT to schedule API

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-91 | Create `components/test-scheduler/ScheduleForm.tsx` | 3 |
| TRP4-92 | Create `components/test-scheduler/CronInput.tsx` with presets | 3 |
| TRP4-93 | Create cron human-readability utility function | 1.5 |
| TRP4-94 | Add create button and edit trigger to schedule list | 1 |

#### Test Plan

**Manual QA Steps**:
- Click "Create Schedule" → dialog opens with empty form
- Fill name, URL, goal → select cron preset "Daily 8am M-F" → preview shows "Next run: Mon, Aug 3 at 8:00 AM"
- Switch to "Custom" → raw cron input appears, type `"0 9 * * *"` → preview shows "Next run: tomorrow at 9:00 AM"
- Type invalid cron `"not valid"` → red validation error "Invalid cron expression"
- Select model → saved with schedule
- Click Save → dialog closes, schedule appears in list
- Click Edit on existing schedule → dialog opens pre-filled with current values
- Change name → Save → list shows updated name
- Cancel edit → dialog closes, no changes persisted

**Edge Cases**:
- Submit empty name → inline validation "Name is required"
- Submit empty URL → inline validation "URL is required"
- URL without protocol → auto-prepend `https://`
- Very long name (500 chars) → character counter, max length enforced
- Goal with 5000 chars → textarea shows character count, max length enforced
- Cron preset "Every hour" → preview shows "Next run: at the next :00 minute"
- Timezone picker (if implemented) → verify selection persisted
- Edit form with previously saved custom cron → raw cron input shows saved expression
- Save while offline → error toast "Network error", form data preserved

**Automated Tests**:
```typescript
test("creates a new schedule", async ({ page }) => {
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Create Schedule" }).click();
  await page.fill("[name=name]", "Daily Test");
  await page.fill("[name=url]", "https://example.com");
  await page.fill("[name=goal]", "Check homepage loads");
  await page.getByText("Daily 8am M-F").click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Daily Test")).toBeVisible();
});

test("validates invalid cron", async ({ page }) => {
  await page.getByText("Custom").click();
  await page.fill("[name=cron]", "broken");
  await expect(page.getByText("Invalid cron expression")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});
```

---

### Story TRP4-95: Schedule run history per schedule

**Description**: Each schedule card expands to show its recent run history (last 10 runs).

**Acceptance Criteria**:
- Expandable section per schedule showing recent runs
- Each run shows: timestamp, status (passed/failed), duration
- Click run navigates to replay

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-96 | Create `components/test-scheduler/ScheduleRunHistory.tsx` | 2 |
| TRP4-97 | Wire to `GET /api/test-scheduler/schedules/:id/runs` (new endpoint) | 1.5 |

#### Test Plan

**Manual QA Steps**:
- Click expand arrow on schedule card → slide-down animation reveals run history
- History shows last 10 runs with: timestamp ("2 hours ago"), status icon (green/red), duration ("12s")
- Click a passed run → navigates to `/replay/:runId`
- Click a failed run → navigates to `/replay/:runId`
- Schedule with no runs → expanded section shows "No runs yet"
- Collapse section → run history hidden
- New run completes while section is expanded → auto-refresh or manual refresh button

**Edge Cases**:
- Schedule with exactly 10 runs → all 10 shown, no "Load more" needed
- Schedule with 15 runs → only 10 shown, "View older" link at bottom
- Run with null duration → shows "--" instead of duration
- Run that's still running → shows spinner + "Running..." instead of status icon
- Rapid expand/collapse → no visual glitches, animation completes
- Multiple schedules expanded simultaneously → all load independently

**Automated Tests**:
```typescript
test("expands to show run history", async ({ page }) => {
  // seed a schedule with 3 completed runs
  await page.goto("/schedules");
  await page.getByTestId("expand-btn").first().click();
  await expect(page.getByTestId("run-history-row")).toHaveCount(3);
});

test("navigates to replay on click", async ({ page }) => {
  await page.getByTestId("expand-btn").first().click();
  await page.getByTestId("run-history-row").first().click();
  await expect(page).toHaveURL(/\/replay\//);
});
```

---

## Epic TRP4-98: Groups & Dashboard (Frontend)

| Field | Value |
|-------|-------|
| **Summary** | Test groups management UI + analytics dashboard with charts |
| **Priority** | Medium |
| **Story Points** | 13 |
| **Dependencies** | TRP4-49 (groups + dashboard API routes) |

### Story TRP4-99: Test groups page

**Description**: New `/test-groups` route. List groups, create/edit/delete, add runs to groups.

**Acceptance Criteria**:
- Groups listed as cards with name, description, run count, overall pass rate
- "Create Group" button opens form dialog
- Group detail page shows all runs in group with status
- "Run All" button executes all runs in the group
- Add-to-group dialog from run history page

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-100 | Create `pages/TestGroups.tsx` | 3 |
| TRP4-101 | Create `components/test-groups/GroupCard.tsx` | 1.5 |
| TRP4-102 | Create `components/test-groups/GroupDetail.tsx` | 2 |
| TRP4-103 | Create `components/test-groups/AddToGroupDialog.tsx` | 1.5 |
| TRP4-104 | Create `components/test-groups/CreateGroupDialog.tsx` | 1.5 |
| TRP4-105 | Create `lib/test-groups-api.ts` API client | 2 |
| TRP4-106 | Add route and nav link | 0.5 |

#### Test Plan

**Manual QA Steps**:
- Navigate to `/test-groups` → see group cards with name, description, run count, pass rate badge
- Create group → fill name + description → Save → appears in list
- Click group card → navigate to `/test-groups/:id` → detail page shows all runs with status
- "Run All" button → batch mode starts, progress shown per-run
- Back to run history page → click "Add to Group" on a run → dialog with group selector → run appears in group
- Delete group → confirm dialog → group removed from list, runs preserved
- Edit group → update name/description → changes reflected

**Edge Cases**:
- Group with 0 runs → shows "0 runs", pass rate = "N/A"
- Group with 1 run and it passed → pass rate = "100%"
- Group with 1 run and it failed → pass rate = "0%"
- 20+ groups → pagination or virtual scroll
- Group name empty → validation error "Name is required"
- Run-all with 10 runs → UI shows progress for each, updates in real time
- Add run that's already in group → UI shows error toast "Run already in group"
- Delete group while run-all in progress → confirm dialog warns about in-progress runs

**Automated Tests**:
```typescript
test("creates and displays a group", async ({ page }) => {
  await page.goto("/test-groups");
  await page.getByRole("button", { name: "Create Group" }).click();
  await page.fill("[name=name]", "Smoke Tests");
  await page.fill("[name=description]", "Critical user paths");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Smoke Tests")).toBeVisible();
});

test("run-all executes all runs", async ({ page }) => {
  await page.goto("/test-groups/1");
  await page.getByRole("button", { name: "Run All" }).click();
  await expect(page.getByText("Running")).toBeVisible();
  // wait for completion
  await expect(page.getByText("All passed")).toBeVisible({ timeout: 120000 });
});
```

---

### Story TRP4-107: Dashboard page with charts

**Description**: New `/dashboard` route showing analytics: pass/fail rate, top failures, duration trends, recent runs.

**Acceptance Criteria**:
- Pass/fail rate over time as area chart (recharts)
- Top 5 failing URLs as horizontal bar chart
- Average duration trend as line chart
- Summary stat cards: Total Runs, Pass Rate %, Avg Duration
- Recent runs table (last 20)
- Date range picker filter (last 7d / 30d / 90d)
- Responsive layout

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-108 | Create `pages/Dashboard.tsx` | 3 |
| TRP4-109 | Create `components/dashboard/StatsCards.tsx` | 1.5 |
| TRP4-110 | Create `components/dashboard/PassFailChart.tsx` (area chart) | 2 |
| TRP4-111 | Create `components/dashboard/TopFailuresChart.tsx` (bar chart) | 2 |
| TRP4-112 | Create `components/dashboard/DurationChart.tsx` (line chart) | 1.5 |
| TRP4-113 | Create `components/dashboard/RecentRunsTable.tsx` | 1.5 |
| TRP4-114 | Create `lib/dashboard-api.ts` API client | 1.5 |
| TRP4-115 | Add route and nav link | 0.5 |

#### Test Plan

**Manual QA Steps**:
- Navigate to `/dashboard` → see 3 stat cards at top: Total Runs (42), Pass Rate (85%), Avg Duration (8.3s)
- Area chart shows pass (green) and fail (red) shaded areas over time
- Hover over chart → tooltip shows exact values for that date
- Bar chart shows top 5 failing URLs, longest bar = most failures
- Duration chart shows line going up/down over time
- Recent runs table shows last 20 runs with timestamp, URL, status, duration columns
- Click date range "7d" → charts update to show last 7 days only
- Click "30d" → update to 30 days
- Resize browser to 768px → charts stack vertically, responsive
- User with no runs → all charts show empty state: "No data yet. Start a run to see analytics."

**Edge Cases**:
- Exactly 1 run → charts show single data point
- All runs passed → area chart shows only green, pass rate = 100%
- All runs failed → area chart shows only red, pass rate = 0%
- One URL failing consistently → bar chart shows it as #1 with 100% failure rate
- Duration spike (one run took 300s) → line chart shows spike, Y-axis adjusts
- 1000 runs in 30 days → chart aggregates well, no performance lag
- Date range with no data → chart shows "No data for this period" overlay
- API returns 500 → error state with retry button
- Page refresh → date range filter persists (localStorage or URL param)

**Automated Tests**:
```typescript
test("displays stat cards", async ({ page }) => {
  // seed 10 runs via API
  await page.goto("/dashboard");
  await expect(page.getByTestId("stat-total-runs")).toHaveText("10");
  await expect(page.getByTestId("stat-pass-rate")).toBeVisible();
  await expect(page.getByTestId("stat-avg-duration")).toBeVisible();
});

test("charts render with data", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByTestId("chart-pass-fail")).toBeVisible();
  await expect(page.getByTestId("chart-top-failures")).toBeVisible();
  await expect(page.getByTestId("chart-duration")).toBeVisible();
});

test("date range filter changes data", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "7d" }).click();
  // verify API called with ?range=7d
});

test("empty state for new users", async ({ page }) => {
  // ensure user has 0 runs
  await page.goto("/dashboard");
  await expect(page.getByText("No data yet")).toBeVisible();
});
```

---

## Epic TRP4-116: Failure Bundles & Replay (Frontend)

| Field | Value |
|-------|-------|
| **Summary** | Enhanced failure display with root cause + fix suggestions, step-through replay mode, and upgraded run history |
| **Priority** | Medium |
| **Story Points** | 13 |
| **Dependencies** | TRP4-30 (Python failure bundles), TRP4-78 (replay endpoint) |

### Story TRP4-117: Failure bundle UI in step messages

**Description**: When a step action errors, show expanded failure details: root cause, fix suggestion, DOM snapshot viewer, full screenshot.

**Acceptance Criteria**:
- Error step shows expandable failure section
- Root cause displayed with icon + text
- Fix suggestion displayed as code block
- "View DOM Snapshot" button shows syntax-highlighted HTML in modal
- "View Full Screenshot" opens screenshot in lightbox
- All presentational only — no functional changes

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-118 | Create `components/browser-agent/FailureBundle.tsx` | 2 |
| TRP4-119 | Create `components/browser-agent/DOMSnapshotViewer.tsx` | 2 |
| TRP4-120 | Create `components/browser-agent/FixSuggestion.tsx` | 1 |
| TRP4-121 | Integrate into `StepMessage.tsx` when step has error actions | 1.5 |

#### Test Plan

**Manual QA Steps**:
- Run an agent against a page with a known broken interaction
- When a step fails, the step card shows a red "❌ Action failed" badge
- Click "Show Failure Details" → section expands showing:
  - Root cause: "Element #submit-btn was not found in the DOM"
  - Fix suggestion: "Try using keyboard navigation (Tab + Enter) instead of direct click, or add a wait for the element to appear."
  - "View DOM Snapshot" button → click → modal shows HTML syntax-highlighted in monospace font
  - "View Full Screenshot" button → click → screenshot opens in full-screen lightbox overlay
- Click outside lightbox or press Escape → lightbox closes
- Successful steps show no failure UI
- Step with `failure_bundle = null` → no failure details shown

**Edge Cases**:
- DOM snapshot > 10,000 lines → virtualized scroll in viewer
- DOM snapshot with malformed HTML → viewer still renders what it can
- Screenshot very large (4K) → lightbox scales to fit viewport
- Fix suggestion with code block → rendered with proper syntax highlighting (Prism or similar)
- Root cause in non-English characters → displayed correctly (Unicode)
- Multiple error steps in same run → each has its own expandable failure section
- Rapid expand/collapse of failure section → smooth animation, no state issues

**Automated Tests**:
```typescript
test("shows failure details on error step", async ({ page }) => {
  // run against a broken page
  await page.goto("/browser-agent");
  // ... setup and start run ...
  await expect(page.getByText("Show Failure Details")).toBeVisible();
  await page.getByText("Show Failure Details").click();
  await expect(page.getByText("Root Cause")).toBeVisible();
  await expect(page.getByText("Fix Suggestion")).toBeVisible();
});

test("opens DOM snapshot viewer", async ({ page }) => {
  await page.getByText("Show Failure Details").click();
  await page.getByText("View DOM Snapshot").click();
  await expect(page.getByTestId("dom-snapshot-modal")).toBeVisible();
  await expect(page.locator("code")).toBeVisible();
});
```

---

### Story TRP4-122: Run replay mode

**Description**: New component/page to replay a completed run step-by-step: navigate through screenshot + actions + reasoning at each step.

**Acceptance Criteria**:
- Replay route: `/replay/:runId`
- Step-through controls: Previous / Play (auto-advance) / Next
- Timeline slider to jump to any step
- Shows screenshot + actions + model reasoning per step
- If video available, renders with `<video>` tag; otherwise animates through screenshots
- Back button returns to previous page

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-123 | Create `pages/RunReplay.tsx` | 3 |
| TRP4-124 | Create `components/browser-agent/ReplayControls.tsx` | 2 |
| TRP4-125 | Create `components/browser-agent/ReplayTimeline.tsx` | 1.5 |
| TRP4-126 | Add `/replay/:runId` route to `App.tsx` | 0.5 |
| TRP4-127 | Wire to `GET /api/browser-agent/runs/:id/steps` | 1 |

#### Test Plan

**Manual QA Steps**:
- Complete a run with 5+ steps → navigate to `/replay/:runId` (or click "Replay" in history)
- Page shows: large screenshot area on the left, step details (actions + reasoning) on the right
- Timeline slider at bottom shows 5 dots (one per step), current step highlighted
- Click "Next" → advances to step 2, screenshot updates, details update
- Click "Previous" → returns to step 1
- Click "Play" → auto-advances every 2 seconds through all steps
- Click "Pause" (same button, toggles) → stops auto-advance
- Drag timeline slider → jumps to corresponding step
- Step details show: action taken ("click", "input"), URL at that step, model reasoning (thinking, evaluation, memory, next_goal)
- If video available, a video player is shown instead of animated screenshots
- "Back" button (top-left) → returns to previous page (history.pushState works)
- Reload page → replay resumes from step 1 (or from URL param `?step=3`)

**Edge Cases**:
- Run with 0 steps (failed immediately) → empty state "No steps to replay"
- Run with 1 step → Previous disabled, Next moves to end
- Run with 50 steps → timeline has 50 dots, slider scrolls horizontally
- Very large screenshots → lazy loaded, placeholder during load
- Video file not found → fallback to screenshot animation, no error
- Store path via `?step=3` → page loads at step 3 directly
- Mobile viewport → layout stacks vertically: screenshot on top, details below
- Keyboard navigation: Left/Right arrow keys step through
- RunId that doesn't exist → "Run not found" error page with back button

**Automated Tests**:
```typescript
test("replays steps sequentially", async ({ page }) => {
  // seed a run with 3 steps via API
  await page.goto("/replay/test-run-id");
  await expect(page.getByTestId("replay-step")).toHaveText("Step 1 of 3");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("replay-step")).toHaveText("Step 2 of 3");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("replay-step")).toHaveText("Step 3 of 3");
});

test("timeline slider jumps to step", async ({ page }) => {
  await page.goto("/replay/test-run-id");
  // drag slider to position for step 2
  await page.getByTestId("timeline-slider").fill("1");
  await expect(page.getByTestId("replay-step")).toHaveText("Step 2 of 3");
});

test("auto-play advances through steps", async ({ page }) => {
  await page.goto("/replay/test-run-id");
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("replay-step")).toHaveText("Step 2");
});
```

---

### Story TRP4-128: Upgraded run history component

**Description**: Enhance existing `RunHistory.tsx` with filtering, sorting, and replay links.

**Acceptance Criteria**:
- Filter by status (All / Passed / Failed / Stopped)
- Date range filter
- Click row to expand failure details inline
- "Replay" button per run
- Sort by date (newest/oldest)
- Export as CSV button

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-129 | Refactor `RunHistory.tsx` to support filter state | 2 |
| TRP4-130 | Add status filter and date range picker | 1.5 |
| TRP4-131 | Add expandable failure details row | 1.5 |
| TRP4-132 | Add replay and export buttons | 1 |
| TRP4-133 | Update `pages/BrowserAgent.tsx` to pass new props | 1 |

#### Test Plan

**Manual QA Steps**:
- Navigate to `/browser-agent` with run history → see Run History table below the configuration
- Filter dropdown default: "All" → shows all runs
- Select "Passed" → table filters to only passed runs
- Select "Failed" → table filters to only failed runs
- Date range picker → select last 7 days → only recent runs shown
- Click a row (failed run) → expands inline showing failure details (root cause, fix suggestion)
- Click "Replay" button on a row → navigates to `/replay/:runId`
- Click "Export CSV" → downloads `runs.csv` with columns: ID, URL, Status, Duration, Date
- Sort toggle (newest/oldest) → table reorders
- Clear all filters → table shows all runs again

**Edge Cases**:
- 0 runs → "No runs yet" message with link to start first run
- Filter combination: "Failed" + "Last 7 days" → only failed runs from last 7 days
- 100+ runs → table should be virtualized or paginated (20 per page)
- Export CSV with 0 runs → downloads file with headers only
- CSV with 100 runs → downloads quickly, no browser freeze
- Expand row while another is expanded → previous collapses (accordion behavior)
- Date picker with invalid range (end before start) → validation error
- Rapid filter switching → debounced queries, no double API calls

**Automated Tests**:
```typescript
test("filters by status", async ({ page }) => {
  await page.goto("/browser-agent");
  await page.getByTestId("filter-status").selectOption("passed");
  await expect(page.getByTestId("run-row")).toHaveCount(/* only passed */);
});

test("expands failure details", async ({ page }) => {
  await page.getByTestId("run-row").first().click();
  await expect(page.getByTestId("failure-details")).toBeVisible();
});

test("exports CSV", async ({ page }) => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("runs.csv");
});
```

---

## Epic TRP4-134: Multi-Agent & CI (Frontend + Docs)

| Field | Value |
|-------|-------|
| **Summary** | Batch mode UI for running multiple agents in parallel + CI integration setup page |
| **Priority** | Low |
| **Story Points** | 13 |
| **Dependencies** | TRP4-22 (Python multi-agent), TRP4-67 (CI API) |

### Story TRP4-135: Batch run configuration UI

**Description**: Add "Batch Mode" toggle to the browser-agent configuration panel. When enabled, users can configure multiple URL+goal pairs and run them in parallel.

**Acceptance Criteria**:
- Toggle: Single Run / Batch Run
- Batch mode shows a list of agent config rows (URL + Goal + [Remove])
- "Add Agent" button appends empty row
- Parallel limit selector (1-5 dropdown)
- Start button triggers `POST /run/parallel`
- Each agent's status shown per-row during execution
- Results shown as aggregate summary

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-136 | Create `components/browser-agent/BatchConfig.tsx` | 3 |
| TRP4-137 | Create `components/browser-agent/BatchProgressGrid.tsx` | 2.5 |
| TRP4-138 | Create `lib/browser-agent-batch-api.ts` for parallel endpoints | 1 |
| TRP4-139 | Integrate batch toggle into `BrowserAgent.tsx` configuration | 2 |
| TRP4-140 | Handle batch results display (aggregate pass/fail per agent) | 1.5 |

#### Test Plan

**Manual QA Steps**:
- Go to `/browser-agent` → toggle from "Single" to "Batch"
- Configuration area changes: 2 rows appear, each with URL + Goal inputs
- Fill row 1: `https://example.com` / "Check homepage"
- Fill row 2: `https://httpstat.us/200` / "Verify 200 response"
- Click "Add Agent" → row 3 appears
- Click "Remove" on row 3 → row 3 disappears
- Set parallel limit to 2
- Click "Start Batch" → batch starts, progress grid shows 2 agents running
- Each agent row shows: agent number, URL, spinning indicator, screenshot thumbnail (updating)
- Agent 1 completes (green checkmark) → agent 2 still shows running
- Agent 2 completes (red X) → batch summary shows "1 passed, 1 failed"
- Toggle back to "Single" → batch rows hidden, single URL/goal shown

**Edge Cases**:
- Start batch with 0 agents → "Add at least one agent" validation
- Start batch with 1 agent → runs as single (no parallelism overhead)
- Parallel limit > number of agents → limit is ignored, all run concurrently
- 10 agents with parallel limit 3 → only 3 run at a time, remaining queue
- All agents fail → summary shows "0 passed, N failed", no errors thrown
- Stop batch mid-flight → all running agents stop, completed ones preserved
- Remove agent row while batch running → not allowed (disabled)
- Add duplicate URL+goal → allowed (no dedup)
- Mobile viewport → batch rows stack vertically, scrollable

**Automated Tests**:
```typescript
test("batch mode runs multiple agents", async ({ page }) => {
  await page.goto("/browser-agent");
  await page.getByText("Batch").click();
  await page.fill("[data-agent=0] [name=url]", "https://example.com");
  await page.fill("[data-agent=0] [name=goal]", "Check page");
  await page.fill("[data-agent=1] [name=url]", "https://httpstat.us/200");
  await page.fill("[data-agent=1] [name=goal]", "Verify 200");
  await page.getByRole("button", { name: "Start Batch" }).click();
  await expect(page.getByText("Agent 1")).toBeVisible();
  await expect(page.getByText("Agent 2")).toBeVisible();
  // wait for completion
  await expect(page.getByTestId("batch-summary")).toBeVisible({ timeout: 120000 });
});

test("validates minimum one agent", async ({ page }) => {
  await page.getByText("Batch").click();
  // remove all rows
  while (await page.getByTestId("remove-agent-btn").count() > 0) {
    await page.getByTestId("remove-agent-btn").first().click();
  }
  await expect(page.getByRole("button", { name: "Start Batch" })).toBeDisabled();
});
```

---

### Story TRP4-141: CI integration setup page

**Description**: Settings section for CI API token generation + code snippet copying.

**Acceptance Criteria**:
- "CI Integration" section in `/settings` page
- Generate/revoke API token button
- Copiable code snippets for: GitHub Actions, GitLab CI, CircleCI, generic curl
- Example YAML/curl shown with user's token pre-filled
- Token stored in `userApiKeysTable` with provider=`ci`

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-142 | Create `components/settings/CIIntegration.tsx` section | 2 |
| TRP4-143 | Implement token generation (POST /api/keys) | 1 |
| TRP4-144 | Create code snippet display with copy-to-clipboard | 1.5 |
| TRP4-145 | Add CI section to existing Settings page | 1 |

#### Test Plan

**Manual QA Steps**:
- Navigate to `/settings` → scroll to "CI Integration" section
- No existing token → "Generate Token" button visible, no token shown
- Click "Generate Token" → token appears in a masked field (`tr_ci_*****f3a2`)
- "Copy" button next to token → click → "Copied!" tooltip appears
- GitHub Actions tab selected by default → YAML snippet shown with token pre-filled as `${{ secrets.TESTRADIUS_API_KEY }}`
- Click "GitLab CI" tab → YAML changes to GitLab format with `$TESTRADIUS_API_KEY`
- Click "curl" tab → curl command with `-H "X-API-Key: $TOKEN"`
- Click "Revoke Token" → confirm dialog → token revoked, "Generate Token" button reappears
- Reload page → token still shown (persisted)

**Edge Cases**:
- Generate token when one already exists → "Replace existing token?" confirmation
- Revoke token while CI run in progress → in-flight runs complete, new ones rejected
- Token copied → clipboard API works in modern browsers, falls back to execCommand
- Very long token (64+ chars) → masked properly, copy copies full token
- 502 from API on generate → error toast "Failed to generate token. Try again."
- No CI section visible in mobile viewport → scrollable

**Automated Tests**:
```typescript
test("generates and displays CI token", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Generate Token" }).click();
  await expect(page.getByTestId("ci-token")).toBeVisible();
  await expect(page.getByTestId("ci-token")).not.toHaveText("");
});

test("copies token to clipboard", async ({ page }) => {
  await page.getByRole("button", { name: "Generate Token" }).click();
  await page.getByRole("button", { name: "Copy" }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("tr_ci_");
});

test("revokes token", async ({ page }) => {
  await page.getByRole("button", { name: "Revoke Token" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("button", { name: "Generate Token" })).toBeVisible();
});

test("switches CI provider tabs", async ({ page }) => {
  await page.getByText("GitLab CI").click();
  await expect(page.getByText("gitlab-ci.yml")).toBeVisible();
  await page.getByText("curl").click();
  await expect(page.getByText("X-API-Key")).toBeVisible();
});
```

---

### Story TRP4-146: CI usage documentation

**Description**: Quick-start guide embedded in the CI settings page explaining how to use TestRadius in CI pipelines.

**Acceptance Criteria**:
- Step-by-step instructions: get token → add to CI secrets → add step to pipeline
- Example: "Fail build if verification fails" with exit code handling
- Link to full docs

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-147 | Write CI integration guide as static markdown or inline help | 2 |
| TRP4-148 | Add contextual help tooltips to CI settings | 1 |

#### Test Plan

**Manual QA Steps**:
- Scroll to CI section → see 3-step guide below the token area
- Step 1: "Generate an API token above" → click "Generate Token" button (works)
- Step 2: "Add to CI secrets" → shows example for GitHub: `Settings → Secrets → Actions → Add `TESTRADIUS_API_KEY``
- Step 3: "Add to your pipeline" → links to tabs above
- "Fail build on verification failure" example shows: `curl ... && if [ "$(curl ...)" != "passed" ]; then exit 1; fi`
- "Full documentation" link → opens `https://testradius.dev/docs/ci` in new tab
- Help tooltip (?) next to "Parallel Limit" label → tooltip: "How many agents to run concurrently. Max: 5."
- Tooltip on "Run All" button → tooltip: "Executes all runs in this group in parallel"

**Edge Cases**:
- Documentation links open in new tab (no navigation away from settings)
- Tooltips dismiss on click outside
- Tooltips on mobile → tap to show, tap again to hide
- Very long docs text → scrollable container, not overflowing layout
- No token generated yet → Step 1 highlighted as incomplete, steps 2-3 dimmed

**Automated Tests**:
```typescript
test("displays step-by-step guide", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Step 1: Generate an API token")).toBeVisible();
  await expect(page.getByText("Step 2: Add to CI secrets")).toBeVisible();
  await expect(page.getByText("Step 3: Add to your pipeline")).toBeVisible();
});

test("help tooltips appear on hover", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("help-tooltip-parallel").hover();
  await expect(page.getByText("How many agents to run concurrently")).toBeVisible();
});
```

---

## Epic TRP4-149: E2E Tests (QA)

| Field | Value |
|-------|-------|
| **Summary** | Playwright E2E tests for all Phase 4 features, following existing patterns |
| **Priority** | Medium |
| **Story Points** | 13 |
| **Dependencies** | All other epics (blocked until features are implemented) |

### Story TRP4-150: Scheduling E2E tests

**Description**: Test schedule creation, editing, run-now, and list display.

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-151 | Write test: create schedule via UI and verify it appears in list | 2 |
| TRP4-152 | Write test: edit schedule and verify changes persist | 1.5 |
| TRP4-153 | Write test: run-now triggers agent and run history shows completion | 2 |
| TRP4-154 | Write test: disabled schedule does not trigger | 1 |

#### Test Plan

**E2E Test Scenarios**:

**TRP4-151**: Create schedule
```
Given: User is logged in, on /schedules page
When: They click "Create Schedule", fill the form with name="E2E Test Schedule",
  url="https://example.com", goal="Verify page loads", select preset "Every hour",
  and click Save
Then: The schedule appears in the list with name "E2E Test Schedule"
  and the cron description shows "Every hour"
```

**TRP4-152**: Edit schedule
```
Given: A schedule "E2E Test Schedule" exists
When: User clicks Edit, changes name to "E2E Edited Schedule", changes preset to
  "Daily 8am M-F", and clicks Save
Then: The list shows "E2E Edited Schedule" with cron "Weekdays at 8:00 AM"
```

**TRP4-153**: Run-now triggers agent
```
Given: A schedule exists
When: User clicks "Run Now" on the schedule card
Then: A toast "Run started" appears
  And within 60 seconds, the schedule's last run shows a result (passed/failed)
  And the run appears in the schedule's expanded run history
```

**TRP4-154**: Disabled schedule does not trigger
```
Given: A schedule exists with enabled=false
When: The scheduler ticks (every 60s)
Then: No new run is created for this schedule
  And the schedule's run history shows no new entries
```

**Data Setup**:
- Seed 2 schedules via API before tests
- Use `test.serial` for run-now test (can't run in parallel with other scheduling tests)

---

### Story TRP4-155: Groups and dashboard E2E tests

**Description**: Test groups CRUD, run-all, and dashboard chart rendering.

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-156 | Write test: create group, add runs, verify group detail page | 2 |
| TRP4-157 | Write test: run-all executes all runs and shows aggregate results | 2 |
| TRP4-158 | Write test: dashboard renders after several runs exist | 1.5 |

#### Test Plan

**E2E Test Scenarios**:

**TRP4-156**: Create and populate group
```
Given: User is on /test-groups page
When: They create group "E2E Group" with description "Auto-tested"
Then: Group appears in list
When: They click the group, navigate to detail page
Then: Group detail shows "0 runs"
When: They go to run history, click "Add to Group" on a completed run,
  select "E2E Group"
Then: Group detail now shows "1 run" with correct status
```

**TRP4-157**: Run-all executes group
```
Given: A group exists with 2 completed runs (both previously successful)
When: User clicks "Run All"
Then: Both runs execute
  And after completion, summary shows "2 passed" (or appropriate count)
  And each run's status is updated
```

**TRP4-158**: Dashboard renders
```
Given: User has 10+ runs with mix of pass/fail across several URLs
When: They navigate to /dashboard
Then: Stat cards show correct numbers
  And area chart has visible data points
  And bar chart shows top failing URLs
  And recent runs table has 10 rows
  And no "No data" empty states are visible
```

**Data Setup**:
- Seed 10 runs via API: 7 passed, 3 failed across 3 different URLs
- Seed 1 group with 2 associated runs

---

### Story TRP4-159: Failure bundle and replay E2E tests

**Description**: Test failure bundle display and replay navigation.

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-160 | Write test: navigate to broken page, verify failure bundle renders | 2 |
| TRP4-161 | Write test: replay page steps through all events | 1.5 |
| TRP4-162 | Write test: video replay renders if available | 1.5 |

#### Test Plan

**E2E Test Scenarios**:

**TRP4-160**: Failure bundle renders
```
Given: An agent run completed against a broken page (e.g., https://httpstat.us/500)
When: User views the run in history and clicks to expand
Then: Failure bundle section is visible
  And "Root Cause" text is displayed
  And "Fix Suggestion" text is displayed
  And "View DOM Snapshot" button is present
  And "View Full Screenshot" button is present
```

**TRP4-161**: Replay steps through events
```
Given: A completed run with 3+ steps exists
When: User navigates to /replay/:runId
Then: Step 1 is shown with screenshot and actions
When: User clicks "Next" 3 times
Then: They reach the end ("Summary" step)
When: User clicks "Previous" twice
Then: They are back at Step 2
```

**TRP4-162**: Video replay
```
Given: A completed run with video recording exists
When: User navigates to /replay/:runId
Then: A <video> element is visible in the replay area
  And the video has a valid src URL
  And the video player controls (play/pause/volume) work
```

**Data Setup**:
- Seed a failed run with failure_bundle data via DB seed
- Seed a run with video_path set
- Seed a run with 5 step events for replay test

---

### Story TRP4-163: CI API and multi-agent E2E tests

**Description**: Test CI API key auth batch agent runs.

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| TRP4-164 | Write test: POST /api/ci/run with valid key returns run_id | 1.5 |
| TRP4-165 | Write test: POST /api/ci/run with invalid key returns 401 | 1 |
| TRP4-166 | Write test: batch mode runs 2 agents and both complete | 2 |

#### Test Plan

**E2E Test Scenarios**:

**TRP4-164**: CI API with valid key
```
Given: A valid CI API key exists (seeded in DB)
When: A POST /api/ci/run is sent with X-API-Key header
  And body: { url: "https://example.com", goal: "Describe the page" }
Then: Response status is 201
  And response body contains run_id (uuid format)
  And response body contains status: "queued"
```

**TRP4-165**: CI API with invalid key
```
Given: An invalid API key "invalid_key_123"
When: A POST /api/ci/run is sent with X-API-Key: "invalid_key_123"
Then: Response status is 401
  And response body contains error: "invalid_api_key"
```

**TRP4-166**: Batch mode runs agents
```
Given: User is on /browser-agent page
When: They select "Batch" mode
  And configure 2 agents:
    Agent 1: url="https://example.com", goal="Check homepage"
    Agent 2: url="https://httpstat.us/200", goal="Verify 200"
  And set parallel_limit=2
  And click "Start Batch"
Then: The batch progress grid shows 2 agents running
  And within 120 seconds, both agents complete
  And the summary shows "2 passed" (or appropriate)
```

**Data Setup**:
- Seed a CI API key in `userApiKeysTable` with provider="ci"
- No additional setup needed for batch test (uses the live agent)

---

## Appendix: Story Point Estimation Guide

| Size | Points | Typical Scope |
|------|--------|---------------|
| XS | 1 | Single file change, no new logic |
| S | 2 | One new component or endpoint, straightforward |
| M | 3 | New page or route with multiple sub-tasks |
| L | 5 | Multi-file feature with API + UI |
| XL | 8 | Full epic spanning backend + frontend |

## Appendix: Label Convention

- `db-migration` — database schema changes
- `python-service` — `server.py` changes
- `api-route` — Express route changes
- `frontend-page` — new page component
- `frontend-component` — new reusable component
- `e2e-test` — Playwright spec
- `infra` — config, CI, dependencies

## Appendix: Test Data Seed Scripts

Each E2E test story includes inline test data. For broader reuse, seed scripts should live at:

| Path | Purpose |
|------|---------|
| `artifacts/e2e-tests/fixtures/seed.ts` | All seed data for Phase 4 tests |
| `artifacts/e2e-tests/fixtures/ci-api.ts` | CI API key generation helper |

---

*Generated from Phase 4 implementation plan. Update status as work progresses.*

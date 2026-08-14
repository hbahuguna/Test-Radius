# QueryFirst — AI-Native No-Code Regression Tester (Jira Plan)

## Project: QF — QueryFirst (TestRadius NLP Tester)

**Board**: QF Kanban
**Project Lead**: [PM Name]
**Start Date**: [TBD]
**Target Completion**: 6–8 weeks
**Labels**: `queryfirst`, `nlp-runner`, `cdp-driver`, `cache`, `llm`, `replay`, `self-heal`, `perf`, `frontend`, `cli`, `fixture`

---

## Product Summary

The query is the test. A user types a natural-language query ("register a user with bob@x.com"), an LLM drives the browser **once** via our own raw Chrome DevTools Protocol client (no Playwright/Puppeteer/Selenium), and the resulting action sequence — the **macro** — is cached with concrete locators, element fingerprints, page signatures, wait conditions, and extracted variables. Every later run of the same **or semantically similar** query replays the macro deterministically with **zero LLM calls**. If a cached step breaks because the page changed, the LLM self-heals the macro once and updates the cache. Creation is **hybrid**: an LLM-free Recorder + template gallery ship alongside the NL query path.

## Key Decisions (locked)

- Zero-LLM replay; LLM only on record, self-heal, and slot-fill fallback
- TypeScript-only; new pnpm workspace package `artifacts/nlp-runner` (Node 24)
- Own raw CDP client over `ws` — no Playwright / Puppeteer / Selenium
- CLI + TypeScript lib first; web UI in `testradius` later
- Hybrid creation: Recorder + templates (LLM-free) + NL query (LLM headliner)
- Record gates: confirm-per-milestone default, mandatory dry-run replay before caching, macro minimizer on

## Build Order & Dependency Graph (chronological)

```
Epic QF-1 Scaffold & Fixture ──────────────────────────────┐
        │                                                  │
        ▼                                                  │
Epic QF-2 Raw CDP Driver ◄────────────┐                   │
        │                             │                   │
        ▼                             │                   │
Epic QF-3 Cache & Semantic Match ─────┤                   │
        │                             │                   │
        ▼                             │                   │
Epic QF-4 Recorder + Zero-LLM Replay ◄┘                   │
        │                                                  │
        ▼                                                  │
Epic QF-5 LLM Record Path ◄──────────────┐                │
        │                                │                │
        ▼                                │                │
Epic QF-6 Self-Healing ◄─────────────────┘                │
        │                                                  │
        ▼                                                  │
Epic QF-7 Performance Architecture                        │
        │                                                  │
        ▼                                                  │
Epic QF-8 Product/UX ◄────────────────────────────────────┘
        │
        ▼
Epic QF-9 Hardening
```

Each epic depends only on the epics above it. Stories within an epic are ordered by their keys. **No task may start until its dependency keys are done and their manual tests pass.**

---

# Epic QF-1: Project Scaffold & Test Fixture

| Field | Value |
|-------|-------|
| **Summary** | Create `artifacts/nlp-runner` workspace package, tooling, and a versionable local test site used as the manual-testing target for every later task |
| **Priority** | Highest |
| **Story Points** | 8 |
| **Dependencies** | None — foundation for all epics |

### Story QF-2: Scaffold `artifacts/nlp-runner` package

**Description**: New pnpm workspace member with Node 24 + strict TypeScript reusing `tsconfig.base.json`, vitest, and a config/env loader. Nothing browser-related yet.

**Acceptance Criteria**:
- `artifacts/nlp-runner` registered in the pnpm workspace
- `tsc --build` and vitest run inside the package
- Config loads from env with sane defaults (LLM provider/base/key/model, chrome path, data dir)
- `pnpm typecheck` green across the whole repo

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-3 | Create `package.json`, register in `pnpm-workspace.yaml`, wire `tsconfig.json` to base | 1 |
| QF-4 | Set up vitest + one smoke test | 0.5 |
| QF-5 | Config/env loader (`src/config.ts`) | 1 |
| QF-6 | Verify repo-wide `pnpm typecheck` + package `pnpm test` | 0.5 |

#### Manual Test Plans

##### Task QF-3
- Run `pnpm install` at repo root — `nlp-runner` appears in the workspace install output without errors.
- Run `pnpm --filter @workspace/nlp-runner run typecheck` — succeeds with no TS errors.
- Verify `node_modules/@workspace/nlp-runner` symlink resolves to `artifacts/nlp-runner`.

##### Task QF-4
- Add a trivial test (`expect(1+1).toBe(2)`), run `pnpm --filter @workspace/nlp-runner test` — passes.
- Run `pnpm vitest --coverage`-style smoke (or plain run) — reporter shows 1 passing test.

##### Task QF-5
- Run with no env set — defaults load (confirm printed defaults).
- Set `QF_LLM_MODEL=custom-model` — config reflects it.
- Set `QF_CHROME_PATH=/bad/path` — `validate()` reports a clear error naming the variable.
- Set `QF_DATA_DIR` to a writable temp dir — resolves and creates the directory.

##### Task QF-6
- From repo root run `pnpm typecheck` — entire monorepo (libs, scripts, artifacts) passes.
- Run `pnpm --filter @workspace/nlp-runner test` — all tests green.

---

### Story QF-7: Build local test fixture site

**Description**: A small static/dynamic site served locally with known pages and elements (login, signup, pricing waitlist, dynamic-loading element) plus a **redesign toggle** that changes selectors/IDs/layout to simulate a UI redesign for self-heal testing.

**Acceptance Criteria**:
- Fixture runs via one npm script, prints URL (e.g., `http://localhost:3123`)
- Pages: `/login`, `/signup`, `/pricing-waitlist`, `/dynamic`
- Elements carry stable `data-testid`s in "normal" mode and different ones in "redesigned" mode
- Redesign toggled by a URL param (`?redesign=1`) and a session store

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-8 | Build fixture app pages (login, signup, pricing-waitlist, dynamic) | 3 |
| QF-9 | Add redesign mode (param-driven layout/selector changes) | 2 |
| QF-10 | Host script + npm script (`pnpm fixture`) + README of URLs/elements | 1 |

#### Manual Test Plans

##### Task QF-8
- Run the fixture, open `/login` — a form with email + password + "Sign in" button renders.
- `/signup` renders name/email/password + "Create account"; `/pricing-waitlist` has an email input + "Join waitlist"; `/dynamic` shows a button that appears 2s after load.
- Submitting `/signup` with data shows a "Welcome, {name}" message (satisfies future assertion tests).

##### Task QF-9
- Open `/signup?redesign=1` — the page renders with different `data-testid`s (e.g., `#signup-btn` becomes `#btn-create-account`) and altered layout; content still functionally equivalent.
- Toggling between `?redesign=0` and `?redesign=1` changes the DOM each reload (verifies the mutation hook works for heal testing).

##### Task QF-10
- Run `pnpm fixture` — starts and prints the URL; all four routes return 200.
- README documents each page's stable elements and the redesign flag.

---

# Epic QF-11: Raw CDP Browser Driver (from scratch)

| Field | Value |
|-------|-------|
| **Summary** | Our own Chrome DevTools Protocol client over `ws` — launch, session, navigate, evaluate, screenshot, DOM interaction by coordinates, a11y perception, state helpers. No Playwright/Puppeteer/Selenium |
| **Priority** | Highest |
| **Story Points** | 21 |
| **Dependencies** | QF-1 |

### Story QF-12: Browser launch & session management

**Description**: Spawn Chrome via `child_process` with `--remote-debugging-port=0`, parse the DevTools WebSocket URL from stderr, connect, correlate request/response IDs, subscribe to events, and manage page targets.

**Acceptance Criteria**:
- `launch()` starts headless or headed Chrome and returns a `{ wsUrl, pid }`
- CDP `connect()` performs the WebSocket handshake; `send(method, params)` resolves the matching response by `id`
- Event subscription (`Page.loadEventFired`, etc.) dispatches to registered handlers
- `newPage()`/`attachPage()` creates and attaches a target; `close()` tears down cleanly
- Survives Chrome exit (rejects with actionable error)

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-13 | Launch Chrome via `child_process` with `--remote-debugging-port=0`, parse ws URL | 2 |
| QF-14 | CDP client: connect, id-correlated requests, event subscription | 3 |
| QF-15 | Target/page lifecycle: create, attach, navigate, load-event handling | 2 |

#### Manual Test Plans

##### Task QF-13
- Run a small script calling `launch()` — Chrome starts; `wsUrl` printed is reachable (`ws://127.0.0.1:PORT/devtools/browser/...`).
- Verify `--headless=new` vs `--headful` flag produces the expected window behavior.
- Passing an invalid `QF_CHROME_PATH` yields a clear "failed to launch" error and process cleanup.

##### Task QF-14
- `connect(wsUrl)` returns without error; `send('Browser.getVersion')` returns the version JSON.
- Send a method with an invalid method name — the client rejects with an error containing the CDP error message (proves id correlation).
- Subscribe to `Page.loadEventFired` — navigating a page fires the handler exactly once per load.

##### Task QF-15
- `newPage()` returns a pageId; `navigate('http://localhost:3123/login')` triggers a `loadEventFired`; `getUrl()` returns the URL.
- `close()` kills the Chrome process (verify PID no longer exists); no dangling sockets.
- Navigate to a bogus host — error is surfaced (or a clear timeout), and the session can still be reused.

---

### Story QF-16: Page primitives

**Description**: High-level helpers over CDP: JS evaluation, screenshots, element location by locator candidates, click and fill by bounding-box coordinates.

**Acceptance Criteria**:
- `evaluate(fn|expression)` with serializable return + proper error handling
- `screenshot()` returns PNG (base64 → file when requested)
- `queryElement(selector)` resolves the element's center coordinates via `getBoundingClientRect`
- `click(selector)` dispatches real `Input.dispatchMouseEvent` at the element center
- `fill(selector, text)` focuses and types via `Input.insertText` (preferring real input events)

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-17 | `Runtime.evaluate` helper (returnByValue, error mapping) | 1.5 |
| QF-18 | Screenshot capture (PNG, base64, write-to-file) | 1 |
| QF-19 | Element location by locator candidates in page context | 2 |
| QF-20 | Click via `Input.dispatchMouseEvent` at center coords | 1.5 |
| QF-21 | Fill via focus + `Input.insertText` | 1.5 |

#### Manual Test Plans

##### Task QF-17
- `evaluate(() => document.title)` returns the title string.
- `evaluate(() => JSON.stringify(window.innerWidth))` returns a serializable value.
- Evaluate an expression that throws — the client rejects with the JS exception message (not a protocol error).

##### Task QF-18
- `screenshot()` returns a base64 string that decodes to a valid PNG (`data:image/png` header / file opens in Preview).
- `screenshot({ file: '/tmp/shot.png' })` writes a non-zero-byte PNG to disk.
- Screenshot on a page with no content — still returns a valid (blank) PNG, no crash.

##### Task QF-19
- On `/login`, `queryElement('#email')` returns coordinates inside the email input's visible box.
- With a multi-match selector, behavior is defined (first match) and documented.
- Element off-screen (`scrollIntoView`-needed) — coordinates returned; scrolling behavior verified in a later task or documented as a limitation.

##### Task QF-20
- `click('#login-btn')` on fixture `/login` triggers the same behavior as a human click (form posts / button state changes).
- Click a button whose handler uses `event.target` — coordinates land on the button (verifies real events).
- Verify the click works on the `?redesign=1` page using the redesigned testid (proves selector parametrization).

##### Task QF-21
- `fill('#email','a@b.com')` — the input's value becomes `a@b.com` and a `change`/`input` event fires (React-compatible).
- Filling an empty field after a prior value replaces (not appends) the value.
- Verify value is set on the `?redesign=1` variant using its testid.

---

### Story QF-22: Perception & state helpers

**Description**: The AI-observable model of a page and the state hashes used for change detection: a11y snapshot → pruned interactive elements, page signature, element fingerprint, and wait-until-condition polling.

**Acceptance Criteria**:
- `getAccessibilitySnapshot()` returns a pruned list of interactive/visible nodes: `{ ref, role, name, bounds }`
- `pageSignature()` returns a hash of URL + title + landmark/interactive-element structure
- `fingerprint(selector)` returns an attribute/structural hash computed in-page
- `waitFor(condition, timeout)` polls a predicate until true or timeout

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-23 | A11y snapshot via `Accessibility.getFullAXTree` → pruned interactive model | 2.5 |
| QF-24 | Page signature (URL/title/landmarks/interactives hash) | 1.5 |
| QF-25 | Element fingerprint (attribute hash) via injected JS | 1.5 |
| QF-26 | Wait-until-condition polling helper | 1 |

#### Manual Test Plans

##### Task QF-23
- On `/signup`, snapshot contains the email/password inputs and "Create account" button with correct `role`/`name`, and does NOT list hidden or non-interactive text nodes.
- `bounds` are valid rectangles (x/y/w/h) that overlap the real element locations on screen.
- On `?redesign=1`, snapshot reflects the redesigned roles/names.

##### Task QF-24
- Same page, two loads — identical signatures.
- Changing the visible heading or adding an interactive element changes the signature.
- `?redesign=1` vs normal mode produce different signatures.

##### Task QF-25
- `fingerprint('#email')` returns a stable hash across reloads.
- Adding an `id`/`class`/`aria-label` to the element changes the hash.
- Two different elements return different hashes.

##### Task QF-26
- On `/dynamic`, `waitFor('button#appears-late', {timeout: 5000})` resolves after the button appears (~2s).
- `waitFor('button#never', {timeout: 1000})` rejects with a timeout error.
- A condition true immediately resolves without delay.

---

# Epic QF-27: Cache & Semantic Matching

| Field | Value |
|-------|-------|
| **Summary** | SQLite storage (WAL) for tests/steps/slots/runs/versions/site-memory, local embeddings via `@huggingface/transformers`, and the cosine query→test matcher |
| **Priority** | High |
| **Story Points** | 13 |
| **Dependencies** | QF-1 |

### Story QF-28: SQLite storage layer

**Description**: `better-sqlite3` database with a migration mechanism and tables: `tests`, `steps`, `slots`, `runs`, `run_steps`, `test_versions`, `site_memory`.

**Acceptance Criteria**:
- DB opens in WAL mode at `QF_DATA_DIR`; migrations run idempotently
- All 7 tables exist with the schema from the master plan (embeddings stored as BLOB)
- Typed data-access functions for each table
- Reopening the DB preserves data

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-29 | DB init + WAL + migration runner | 2 |
| QF-30 | Schema: tests, steps, slots, runs, run_steps, test_versions, site_memory | 2 |
| QF-31 | Typed data-access layer (CRUD per table) | 3 |

#### Manual Test Plans

##### Task QF-29
- Open a fresh DB — `main`/`journal_mode` reports `wal`.
- Run migrations twice — second run is a no-op, no errors.
- Corrupt/delete the DB file — init recreates it cleanly.

##### Task QF-30
- Using `sqlite3` CLI (or `PRAGMA table_info`), verify all 7 tables and key columns exist (e.g., `tests.query_embedding` is `BLOB`).
- `steps.page_signature_before` / `wait_condition_json` / `element_fingerprint` columns present.
- Foreign keys (steps→tests cascade) behave on delete.

##### Task QF-31
- Insert a test + 3 steps + 2 slots; read back — values round-trip exactly.
- `getTest(id)` returns nested steps in `idx` order.
- Update a step's `locators_json`; delete a test → its steps cascade-delete.
- Insert a run with `llm_calls: 0` and read it back in `runs` listing.

---

### Story QF-32: Embeddings & query matcher

**Description**: Load `all-MiniLM-L6-v2` once via `@huggingface/transformers`, normalize and slot-normalize queries (emails/names/numbers → placeholders), embed, and cosine-match against stored tests with threshold + top-k + ambiguity signal. Memoize embeddings by query hash.

**Acceptance Criteria**:
- `embed(text)` returns a vector; model loads once and is reused
- `normalizeQuery()` strips case/punctuation; `slotNormalize()` replaces emails/names/numbers with `{slot}` placeholders
- `match(query)` returns `{ test, score, ambiguous }` or `null`; respects threshold (≈0.85)
- Repeated queries hit the memo, not the model

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-33 | Load transformers model once; `embed()` | 1.5 |
| QF-34 | `normalizeQuery()` + `slotNormalize()` | 1.5 |
| QF-35 | Cosine matcher: threshold, top-k, ambiguity signal | 2 |
| QF-36 | Memoize query→embedding by hash (LRU) | 1 |

#### Manual Test Plans

##### Task QF-33
- First `embed("hello")` returns a Float32Array of expected dim (384 for MiniLM); second call is faster (model cached).
- Two similar sentences produce vectors with cosine > 0.8.

##### Task QF-34
- `"Register a user bob@x.com!"` → normalized `"register a user {email}"` (email → placeholder).
- `"add 3 items"` → number becomes `{number}`; `"John Smith"` inside a sentence becomes `{name}`.
- Punctuation/case stripped as documented.

##### Task QF-35
- Seed two tests: "register a user {email}" and "check the pricing page". `match("register a user with jane@y.com")` returns the register test with score ≥ 0.85 (measured 0.984).
- `match("what is the meaning of life")` returns `null` (measured 0.01–0.06, below threshold).
- Seed two similar tests ("delete my account" + "remove my account") — `match("delete account")` returns the best (0.931) with `ambiguous: true` (runner-up 0.895, margin 0.036 < 0.05).

##### Task QF-36
- Call `match("register bob@x.com")` twice — second call skips model inference (instrument: count `embed()` invocations).
- A miss (below threshold) is also memoized (no repeated embedding for the same text).

---

# Epic QF-37: Recorder + Zero-LLM Replay

| Field | Value |
|-------|-------|
| **Summary** | The LLM-free creation path (Recorder) and the deterministic replay engine with assertions, run history, and CLI commands. Replays at `llm_calls: 0` |
| **Priority** | High |
| **Story Points** | 21 |
| **Dependencies** | QF-11 (driver), QF-27 (cache) |

### Story QF-38: Recorder (LLM-free creation)

**Description**: A scripting/record API that captures steps as the user (or a script) drives the browser, storing locator candidates, fingerprints, page signatures, and wait conditions per step, then saves the test to the cache.

**Acceptance Criteria**:
- Actions: navigate, click, fill, select, scroll, assert, extract
- Each recorded step captures ordered locator candidates + fingerprint + signatures + wait condition
- `saveTest()` persists test + steps + slots atomically
- Recorded test replays without any LLM (source = `recorder`)

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-39 | Record action API → step capture (locators, fingerprint, signatures, wait condition) | 3 |
| QF-40 | `saveTest()` persistence (test + steps + slots) | 2 |
| QF-41 | `list`, `show <id>`, `runs <id>` CLI commands | 2 |

#### Manual Test Plans

##### Task QF-39
- Record a script: navigate `/signup` → fill email → fill password → click "Create account".
- Inspect the in-memory steps: each has ordered `locators` (stable testid first), `element_fingerprint`, `page_signature_before/after`, and a `wait_condition`.
- A click step's wait condition records the post-action expectation (URL or element).

##### Task QF-40
- `saveTest()` returns an id; `show <id>` renders the steps as a plain-English checklist.
- Verify `slots` persisted for filled values that look like variables.
- Re-saving the same logical test updates instead of duplicating (dedupe by entry URL + step hash) — documented behavior.

##### Task QF-41
- `list` shows recorded tests with run counts; `show <id>` shows full steps.
- `runs <id>` shows run history with status + duration; with no runs, prints empty-state message.

---

### Story QF-42: Zero-LLM replay engine

**Description**: The deterministic executor: locate by candidates (stable attr → structural → text), fused fingerprint check, act via CDP, honor wait conditions, run assertion steps, record run history with `llm_calls: 0`, and expose CLI flags.

**Acceptance Criteria**:
- Replay loop resolves locator candidates in order with fingerprint validation
- Assertion steps: text present, URL contains, element visible, extract value
- `runs` row written with `llm_calls: 0`, per-step trace, result, exit code
- `run <id>` and `run "<query>"` (direct match) work with `--variables`, `--headful`, screenshot dir

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-43 | Replay loop — locate candidates, fingerprint check, act, wait | 4 |
| QF-44 | Assertion steps (text present, URL contains, element visible, extract) | 2 |
| QF-45 | Run history recording + exit codes | 1.5 |
| QF-46 | `run <id|query>` CLI with `--variables`, `--headful`, `--screenshot-dir` | 2 |

#### Manual Test Plans

##### Task QF-43
- Record a signup test, delete/redo the page, then `run <id>` — it navigates, fills, clicks, and ends with the "Welcome" message visible.
- Temporarily remove the primary `data-testid` from the fixture; replay still finds the element via the structural/text fallback locator.
- A step whose element is gone from the page fails cleanly with the step number + intent (self-heal comes in QF-6).
- `--headful` opens a visible window; headless default works.

##### Task QF-44
- Assert "text present": "Welcome" — passes when shown, fails when page shows different text.
- Assert "URL contains `/welcome`" — passes/fails correctly.
- Assert "element visible" for the success banner.
- Extract step pulls a value into the run output (e.g., extracted heading text printed).

##### Task QF-45
- After a pass and a fail, `runs <id>` shows both with correct `result` and `duration_ms`.
- Exit code is 0 on pass, 1 on fail (verified via shell `echo $?`).
- `llm_calls` shows `0` for every replay run.

##### Task QF-46
- `run <id> --variables '{"email":"jane@y.com"}'` substitutes the value into the fill step (verify input value).
- `run "register a user"` with an exact cached match replays the test.
- `--screenshot-dir /tmp/shots` writes one PNG per step to the directory.

---

# Epic QF-47: LLM Record Path (NL Query → Macro)

| Field | Value |
|-------|-------|
| **Summary** | The headliner: an LLM planner drives the browser from a natural-language query, with quality gates (confirm, dry-run replay, macro minimizer), slot extraction, site memory, and the auto record-or-replay entry point |
| **Priority** | High |
| **Story Points** | 26 |
| **Dependencies** | QF-37 (replay engine for the dry-run gate) |

### Story QF-48: A11y LLM planner

**Description**: Structured planner that decomposes the query into milestones, emits validated JSON actions (multi-action batches per snapshot), guards against loops, and extracts slots.

**Acceptance Criteria**:
- Action JSON validated against a schema; malformed output retried (≤2) then fails the record
- Plan-first milestone decomposition used to steer actions
- Multi-action batches: one snapshot can yield several actions (fill email + fill password + click)
- Loop guard (repeated page signature without progress → replan/hint) + step budget
- Slots extracted from the query at record start

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-49 | Action JSON schema + validation/retry | 2 |
| QF-50 | Plan-first milestone decomposition prompt/flow | 2.5 |
| QF-51 | Multi-action batching per snapshot | 2 |
| QF-52 | Loop guard + step budget | 2 |
| QF-53 | Slot extraction at record | 1.5 |

#### Manual Test Plans

##### Task QF-49
- Mock the LLM returning invalid JSON — record retries up to 2 then fails with a clear message.
- Mock valid `{type:"click", ref:3}` — validated and executed.
- Unknown action type is rejected, not executed silently.

##### Task QF-50
- Prompt record with "register a user on the signup page" — planner first emits a milestone list (e.g., navigate → fill form → submit → verify) before actions.
- A query that implies a different flow ("check the pricing page shows 3 plans") produces different milestones.
- When reality diverges (e.g., a step fails), the planner re-plans rather than blindly continuing.

##### Task QF-51
- On `/signup`, one snapshot yields `[fill email, fill password, click create]` in a single planner response — executed in order.
- Batching is not applied across page-load boundaries (actions requiring a new state are separate steps).

##### Task QF-52
- Against a page that never reaches the goal, the record stops at the step budget and fails with "goal not reached".
- Simulate a loop (agent clicking the same element repeatedly) — guard fires, replan hint is logged.
- Normal successful record never hits the guard.

##### Task QF-53
- Query "register bob@x.com" → slots `{email: bob@x.com}`; canonical query stored as "register {email}".
- Query with no variables → zero slots.
- Printed slot summary in record report matches the query.

---

### Story QF-54: Record quality gates

**Description**: Human confirmation per milestone (default), mandatory dry-run replay before caching (re-plan from the failure point if it fails), macro minimizer, record report, and site-memory seeding/transfer.

**Acceptance Criteria**:
- Confirm mode pauses per milestone and asks y/n (auto mode skips for known domains)
- Dry-run replay runs before cache; failure triggers re-record from the failing step (max 2 attempts)
- Minimizer drops steps that still pass the dry-run
- Record report: step count, backtracks, guard fires, LLM calls, dry-run result, minimized steps
- Site memory seeds new records on the same domain; similar cached tests act as skeletons

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-55 | Confirm mode per milestone (CLI prompt) | 1.5 |
| QF-56 | Dry-run replay gate + re-plan-from-failure | 2.5 |
| QF-57 | Macro minimizer | 2.5 |
| QF-58 | Record report (metrics) | 1.5 |
| QF-59 | Site memory seeding + transfer from similar test | 2.5 |

#### Manual Test Plans

##### Task QF-55
- `run "register a user" --confirm` pauses before each milestone; `n` stops the record, `y` continues.
- A `no` at a milestone aborts cleanly without caching a partial test.
- Auto mode (no `--confirm`, known domain) proceeds without prompting.

##### Task QF-56
- After recording succeeds, the tool automatically resets the page and replays the macro before caching — verify this happens (see `mode: dry-run` in logs).
- Force a failure (e.g., record while planner captured a wrong locator via mock) — record restarts from the failing step; still failing after 2 attempts → no test cached, error explains why.

##### Task QF-57
- Record a test with a deliberate redundant step (click a benign element before submit). After minimizing, the redundant step is gone and the macro still passes the dry-run.
- Verify minimized step count is reported in the record report.

##### Task QF-58
- Record report prints: step count, backtracks, loop-guard fires, LLM calls, dry-run result (PASS/FAIL), minimized-steps count.
- Values match what was actually observed during record.

##### Task QF-59
- Record on fixture `/login`; then record on `/signup` — the second record is seeded with login-site memory (landmarks like "top-right sign in" reused or skipped appropriately).
- Record "register a user" then record "sign up a new account" — the second starts from the first as a skeleton (fewer fresh steps); verify reduced LLM steps.
- Clearing site memory (CLI) disables seeding.

---

### Story QF-60: NL query entry point

**Description**: The `run "<query>"` auto-decision: embed → match → replay OR record; slot re-fill on replay; ambiguity prompt.

**Acceptance Criteria**:
- Auto: high-confidence match → replay; no match → record; ambiguous → prompt
- Slot re-fill: new query values replace slots (heuristic first, LLM fallback)
- Query with variables runs the cached test with new values (`llm_calls: 0` on the pure-replay path)

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-61 | Auto record-or-replay decision in `run "<query>"` | 2 |
| QF-62 | Slot re-fill on replay (heuristic + LLM fallback) | 2 |
| QF-63 | Ambiguity prompt | 1 |

#### Manual Test Plans

##### Task QF-61
- First run of "register jane@y.com on signup" — records (no match), caches after dry-run.
- Second run of the same query — replays (log shows `mode: replay`, `llm_calls: 0`).
- Totally new query "what is 2+2" → below threshold → attempts record; if no URL context, asks for a starting URL.

##### Task QF-62
- Run "register jane@y.com on signup" after caching bob@x.com — the fill step receives `jane@y.com` (verify input value on screen).
- Query with a different name pattern not covered by heuristics — LLM fallback fills it; result logged.
- Replay with new slot values still reports `llm_calls: 0` (fallback not needed for plain email swap).

##### Task QF-63
- Seed two very similar tests; run a query matching both — CLI prompts "Did you mean: (1) ... (2) ..."; choosing runs the selected test.
- `--test <id>` bypasses the prompt.

---

# Epic QF-64: Self-Healing

| Field | Value |
|-------|-------|
| **Summary** | When a cached step can't locate its element (page changed), retry once, then let the LLM rediscover it once, validate, update the cache (versioned), and continue — with full transparency |
| **Priority** | High |
| **Story Points** | 13 |
| **Dependencies** | QF-47 (LLM path) |

### Story QF-65: Self-heal engine

**Description**: Heal triggers (locator miss / signature change / one retry guard), LLM rediscovery, cache update with version bump + rollback, transparency reporting, and the redesign-mutation integration test.

**Acceptance Criteria**:
- Locator miss → one silent retry after network-idle wait → then LLM heal
- Heal passes `(step.intent, fresh a11y snapshot)` to the LLM and validates the returned ref
- Healed locators update the cache; `test_versions` records the change; rollback restores
- Replay reports `self_healed` count; `heal <id>` and `versions <id>` CLI commands exist
- Integration: fixture redesign (`?redesign=1`) → replay heals → passes → version history shows the change

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-66 | Heal trigger: locator miss / signature change + one retry guard | 2 |
| QF-67 | LLM rediscover step (intent + snapshot → ref), validate | 2.5 |
| QF-68 | Cache update + version bump + rollback | 2 |
| QF-69 | Heal transparency: report flag, `heal <id>`, `versions <id>` | 1.5 |
| QF-70 | Integration test: redesign mutation → replay heals | 2.5 |

#### Manual Test Plans

##### Task QF-66
- Break the fixture primary testid only: replay → first attempt fails, one silent retry also fails (element truly missing) → heal path triggers (see log).
- Transient miss (element appears after 300ms) → retry succeeds without LLM, `self_healed: 0`.
- Page-signature change with all locators still working → no heal (signature change alone does not trigger).

##### Task QF-67
- With `?redesign=1` (testids changed), replay heals the "Create account" step: the LLM returns the redesigned ref; the step passes afterward.
- Heal with the LLM returning an invalid ref (non-interactive node) → validation rejects it; another heal attempt or clean failure.
- Healed step's intent is used correctly in the prompt (verify the log shows the stored intent).

##### Task QF-68
- After a heal, `versions <id>` lists v1 (original) and v2 (healed) with timestamps + reason.
- `heal <id> --rollback` restores v1 locators; replay then fails on the redesigned page (proves rollback applied).

##### Task QF-69
- A healed run's report shows `self_healed: 1` and identifies the step + new locator.
- `heal <id>` shows the heal history; `versions <id>` shows version list.
- Non-healed runs show `self_healed: 0`.

##### Task QF-70
- Record the signup test in normal mode. Switch the fixture to `?redesign=1`. Replay → heals → PASS.
- Re-run again on redesigned page → PASS without LLM (cached healed locators).
- Document the test in `tests/` (vitest, LLM mocked to return the redesigned ref).

---

# Epic QF-71: Performance Architecture

| Field | Value |
|-------|-------|
| **Summary** | Warm daemon + browser pool, predictive waits, network fast-mode, fused evaluate, persistent profile, and parallel suite execution so replay = page-load + ~100–300ms and suites run parallel-bounded |
| **Priority** | Medium |
| **Story Points** | 18 |
| **Dependencies** | QF-37 (replay), QF-64 (self-heal) |

### Story QF-72: Warm daemon & browser pool

**Description**: `nlp-run daemon` keeps Chrome warm, embeddings cached, SQLite open; CLI talks to it via local IPC. Preloads the entry page before replay.

**Acceptance Criteria**:
- Daemon starts a warm browser pool; subsequent CLI commands reuse it
- Entry URL preloaded in a hidden tab before replay begins
- Daemon survives CLI restarts; `daemon stop` tears down

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-73 | Daemon: warm Chrome, cached embeddings, open SQLite, local IPC | 4 |
| QF-74 | Preload entry page before replay | 1.5 |

#### Manual Test Plans

##### Task QF-73
- Start daemon, run a replay twice — the second run shows no Chrome-launch time (measure `run()` duration; second is clearly faster).
- Restart the CLI process — the daemon's browser pool is reused (no relaunch in logs).
- `daemon stop` exits cleanly; Chrome processes terminate.

##### Task QF-74
- Run a test whose first step is navigate → with daemon on, the entry page is already loaded when replay starts (first-step latency near zero).
- Preload only happens for known entry URLs (no spurious loads for a new-record flow).

---

### Story QF-75: Faster page & step execution

**Description**: Predictive wait conditions replace sleeps, network blocking fast-mode, fused single-evaluate locator+fingerprint, no screenshots on the happy path, persistent Chrome profile for cache/cookies.

**Acceptance Criteria**:
- Replay honors recorded wait conditions (no fixed sleeps / load-event waits)
- Fast-mode blocks non-essential third-party requests via `Network.setBlockedURLs` (opt-in)
- Locator resolution + fingerprint check run in one `Runtime.evaluate`
- Happy-path replay takes no screenshots unless `--screenshot-dir` is set
- Persistent `--user-data-dir` profile reuses disk cache and cookies across runs

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-76 | Predictive wait conditions honored by replay engine | 2 |
| QF-77 | `Network.setBlockedURLs` fast-mode (opt-in per test) | 2 |
| QF-78 | Fused single-evaluate locator+fingerprint; screenshots opt-in | 2 |
| QF-79 | Persistent Chrome profile (disk cache + cookies) | 1.5 |

#### Manual Test Plans

##### Task QF-76
- Record a test; inspect recorded wait conditions. Replay with network throttling — it completes as fast as conditions allow (no fixed 3s sleeps).
- A wait condition that never becomes true times out and fails the step (not hangs forever).

##### Task QF-77
- Run with fast-mode on the fixture (which loads a dummy third-party script) — the script is blocked (verify via Network events / console).
- Fast-mode off loads it normally. Fast-mode is per-test and documented in the test's meta.

##### Task QF-78
- Instrument: replay a 6-step test with `--screenshot-dir` unset — 0 screenshot CDP calls; with the flag set, 6.
- Verify locator+fingerprint happen in a single evaluate call per step (log shows one `Runtime.evaluate` per step).

##### Task QF-79
- Run a test twice on the same site with a persistent profile — second run's asset requests hit the disk cache (Network log shows `FromDiskCache`).
- Set a cookie in one run; a later run on the same profile still has it.

---

### Story QF-80: Parallel suite execution

**Description**: Run many cached tests in parallel, each in its own CDP target/context within one Chrome. Vector index (sqlite-vec / in-memory HNSW) + memoized matching keep matching ~1ms at scale.

**Acceptance Criteria**:
- `run --all` / `run <query-list>` executes tests in parallel contexts with per-test results
- Parallelism bounded by configurable `--concurrency`
- Matching uses a vector index; results identical to brute-force cosine
- Total suite time ≈ slowest test, not the sum

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-81 | Parallel contexts per test within one Chrome | 3 |
| QF-82 | sqlite-vec / in-memory HNSW index + memoized matching | 2.5 |

#### Manual Test Plans

##### Task QF-81
- Record 5 tests; `run --all --concurrency 5` — all complete; suite wall-time is ≈ slowest test (compare to sequential sum).
- One test fails while others pass — report shows per-test results and the aggregate exit code (fail if any failed).
- `--concurrency 1` behaves identically to sequential.

##### Task QF-82
- Seed 500 synthetic tests; `match()` still returns correct top results within ~5ms.
- Index and brute-force results agree on a 20-test seeded sample.

---

# Epic QF-83: Product/UX

| Field | Value |
|-------|-------|
| **Summary** | CLI polish + LLM-free template gallery, then the `testradius` web page: query bar + teach view, library (plain-English checklist, point-to-edit), runs dashboard with `AI` vs `⚡ cached` badge, and failure triage with one-click heal |
| **Priority** | Medium |
| **Story Points** | 21 |
| **Dependencies** | QF-37, QF-47, QF-71 |

### Story QF-84: CLI polish & template gallery

**Description**: LLM-free creation from templates (login, form-submit, cart-checkout, scrape) and documentation-grade CLI help.

**Acceptance Criteria**:
- `nlp-run from-template <name>` scaffolds a test from a template (user fills a few fields)
- Templates produce replayable macros without any LLM call
- `--help` documents every command; README has a quickstart

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-85 | Template gallery: login, form-submit, cart-checkout, scrape | 3 |
| QF-86 | README, quickstart, `--help` polish | 2 |

#### Manual Test Plans

##### Task QF-85
- `from-template login` against the fixture `/login` prompts for credentials, records, caches, replays with `llm_calls: 0`.
- `from-template scrape` against `/pricing-waitlist` extracts the listed plans into the run output.
- `from-template cart-checkout` against a fixture cart page adds an item and checks out.

##### Task QF-86
- `nlp-run --help` and each subcommand `--help` show accurate usage and examples.
- README quickstart works end-to-end on a fresh clone (fixture + one template test).

---

### Story QF-87: Web UI (`testradius` page)

**Description**: `/nlp-tests` page in the existing React app reusing BrowserAgent components: query bar + teach view, library as plain-English checklist with point-to-edit, runs dashboard, and failure triage.

**Acceptance Criteria**:
- Query bar starts record-or-replay; teach view shows live browser + step cards (reuse BrowserAgent)
- Library lists tests as editable plain-English checklists; "Change element" opens a live page for point-to-edit
- Runs dashboard shows pass/fail + `AI` vs `⚡ cached` badge
- Failure triage shows screenshot + expected-vs-found + one-click heal + version rollback

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-88 | Query bar + teach view (reuse BrowserAgent components) | 3 |
| QF-89 | Library view: plain-English checklist + point-to-edit | 3 |
| QF-90 | Runs dashboard: pass/fail + `AI` vs `⚡ cached` badge | 2 |
| QF-91 | Failure triage: screenshot, expected vs found, one-click heal, rollback | 3 |

#### Manual Test Plans

##### Task QF-88
- Open `/nlp-tests`, type "register a user on the signup page" — record starts, live browser view + step cards appear (reusing BrowserAgent layout).
- Confirming per milestone works from the UI; on completion the test appears in the library.
- Re-running the same query replays with the `⚡ cached` badge visible.

##### Task QF-89
- Library shows the test as a checklist; clicking a step's "Change element" opens a live page; clicking the correct element updates the locator and saves.
- Editing does not break the macro (replay passes afterward).
- Variables render as editable chips; changing a value re-runs with new data.

##### Task QF-90
- Runs dashboard lists runs with pass/fail + duration; `AI` badge on record runs, `⚡ cached` on replays.
- Aggregates (pass rate, total) match CLI data.
- Failed runs are visually distinct and link to triage.

##### Task QF-91
- Fail a run against `?redesign=1` — triage shows the failing step, a screenshot, and "expected vs found" detail.
- Click "Heal" — the LLM re-finds the element, cache updates, run passes on re-run.
- Version history shows the heal; "Rollback" restores the previous version and a re-run behaves as before.

---

# Epic QF-92: Hardening

| Field | Value |
|-------|-------|
| **Summary** | Real-world sessions (attach to a logged-in Chrome profile), audit/rollback polish, documentation, and CI |
| **Priority** | Low |
| **Story Points** | 13 |
| **Dependencies** | All above |

### Story QF-93: Sessions & real-world flows

**Description**: Attach to an existing logged-in Chrome profile (`--user-data-dir` / remote debugging) so tests can run behind login walls without storing credentials.

**Acceptance Criteria**:
- `run <id> --profile <path>` launches/attaches Chrome with that profile and reuses its cookies/session
- A test recorded behind a login wall replays with the attached session
- Clear error when the profile can't be attached

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-94 | Attach to existing profile (`--user-data-dir` / remote debugging) | 3 |

#### Manual Test Plans

##### Task QF-94
- Manually log into a test site in a Chrome profile; run a recorded test on that site with `--profile` — it passes without re-login.
- Running the same test without the profile fails at the login wall (documents the feature's value).
- Attaching to a busy profile fails with a clear "profile locked/in use" message.

---

### Story QF-95: Audits, docs, CI

**Description**: Version history/rollback surfaced in CLI, package documentation, and CI running typecheck + unit + fixture integration tests.

**Acceptance Criteria**:
- `versions <id>` / `rollback` polished and documented
- Architecture + CLI + UX docs written
- CI runs `pnpm typecheck`, vitest, and fixture integration (LLM mocked except one tagged e2e)

#### Tasks
| Key | Task | Estimate (h) |
|-----|------|--------------|
| QF-96 | Version history + rollback polish (CLI + storage) | 2 |
| QF-97 | Documentation (architecture, CLI reference, UX guide) | 3 |
| QF-98 | CI pipeline (typecheck, vitest, fixture integration) | 3 |

#### Manual Test Plans

##### Task QF-96
- `versions <id>` shows v1/v2 with reasons; `rollback` restores and a subsequent run confirms behavior.
- Rollback after a heal is reversible (roll forward again to v2).

##### Task QF-97
- Docs render/read coherently; every CLI command in the reference actually exists and matches `--help`.
- UX guide's flows (create → teach → library → run → fix) are reproducible by a reviewer.

##### Task QF-98
- Push a branch — CI runs typecheck + unit + fixture integration; all green.
- Break a unit test intentionally — CI fails at the right job with a readable error.
- The one tagged LLM e2e is skippable when `QF_LLM_KEY` is absent.

---

## Manual Test Convention

Every task's manual test plan above should be executed by a human against the fixture site (`pnpm fixture`) unless stated otherwise. A task is **Done** only when: (1) its acceptance criteria pass, (2) its manual test plan fully passes, (3) `pnpm typecheck` and the package test suite are green, and (4) its dependencies are closed.

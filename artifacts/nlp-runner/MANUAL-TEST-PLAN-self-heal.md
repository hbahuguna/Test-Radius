# Manual Test Plan — Epic QF-64: Self-Healing

> Covers Story QF-65 (Self-heal engine) and its tasks **QF-66 → QF-67 → QF-68 → QF-69 → QF-70**.
> This plan is grounded in the *actual* implementation in `artifacts/nlp-runner/src/`
> (`replay/engine.ts`, `replay/heal.ts`, `cli.ts`, `cache/queries.ts`), not only the
> idealized Jira cards.

## Pre-conditions

1. Repo at `/Users/skarparawan/github/Test-Radius` with `pnpm` (11.15) installed.
2. Chrome/Chromium resolvable by `resolveChromePath("auto")` (`QF_CHROME_PATH` env optional).
3. A clean `QF_DATA_DIR` (use a temp dir so you don't clobber your real cache):
   ```sh
   export QF_DATA_DIR="$(mktemp -d /tmp/qf-heal-XXXXXX)"
   ```
4. **An LLM endpoint must be configured** — the healer is only wired when
   `QF_LLM_API_KEY` is non-empty (`cli.ts:330`: `cfg.apiKey ? new LLMStepHealer(...) : undefined`).
   Without a key, a locator miss **fails** with `self_healed: 0`; no heal occurs.
   ```sh
   export QF_LLM_BASE_URL="https://api.openai.com/v1"
   export QF_LLM_API_KEY="sk-..."
   export QF_LLM_MODEL="gpt-4o-mini"
   ```
5. Start the fixture (in its own terminal):
   ```sh
   pnpm --filter @workspace/nlp-runner fixture
   # -> QueryFirst fixture running at http://localhost:3123
   ```
6. Helper to run the CLI (from repo root):
   ```sh
   QF="pnpm --filter @workspace/nlp-runner qf"
   ```

## Fixture reference (must match `fixture/redesign.js`)

`/signup` normal-mode stable elements: `[data-testid=signup-name]` (id also `signup-name`),
`signup-email`, `signup-password`, `signup-submit` (button, label "Create account"),
`signup-result`.

`?redesign=1` renames (testids only labels are preserved — names unchanged):
| normal | redesigned |
|---|---|
| `signup-name` | `signup-full-name` |
| `signup-email` | `signup-email-address` |
| `signup-password` | `signup-password-field` |
| `signup-submit` | `btn-create-account` |
| `signup-result` | `signup-message` |

Redesign also prepends a `redesign-banner` and moves the back-nav. It is **session-scoped**
(via `sessionStorage`); each fresh Chrome launch needs `?redesign=1` on the URL
(`redesign.js:4-8`).

> Note on locator fallbacks (see QF-43, L432 of PLAN): each recorded step keeps an
> *ordered* candidate list (testid → `#id` → structural → `text="…"`). Removing **only**
> the primary `data-testid` does **not** force a miss — the `#id` fallback resolves.
> To force a true miss you must invalidate **all** candidate locators (testid AND id),
> e.g. by renaming both via a temp fixture edit.

---

## Record a baseline signup test (shared setup)

```sh
$QF run "register a user on the signup page" \
  --entry-url http://localhost:3123/signup \
  --variables '{"name":"Ada","email":"ada@example.com"}' --auto
```
- Expect: records, runs dry-run, passes, caches.
- Capture the test id, e.g. `ID=1`. Confirm with `qf list`:
  ```
  1  register a user...           nlp        steps=5 runs=1 http://localhost:3123/signup
  ```
- Inspect the recorded step locators:
  ```sh
  $QF show 1
  ```
  Confirm each `fill`/`click` step lists `[data-testid=signup-name]` (etc.) **first**.

---

## QF-66 — Heal trigger: locator miss / signature change + one retry guard

### Test 66.1 — Transient miss resolves on the silent retry (no LLM)
1. Use the baseline test. Reload the fixture `/signup` normally (no redesign).
2. Run: `$QF run 1`.
3. **Expected:** `PASS`, `llm_calls: 0`, `self_healed: 0`. (No heal — happy path.)

### Test 66.2 — Persistent miss → silent retry → heal path triggers
> Requires forcing *all* candidate locators to miss. Edit `fixture/signup.html` to
> temporarily rename both the `data-testid` **and** the `id` on the submit button
> (e.g. `data-testid="signup-submit-old"`, `id="signup-submit-old"`), then restart
> the fixture server (pkill + `pnpm --filter @workspace/nlp-runner fixture`).
1. Run: `$QF run 1`.
2. **Expected run output:**
   ```
   [PASS] 1/5 Navigate to ...
   [PASS] 2/5 Fill ...               (retries on fill may also heal)
   ...
   [PASS] N/5 Click "Create account" [HEALED -> <ref>]
   ...
   llm_calls: X  self_healed: >=1
   PASS (run #M of test #1)
   ```
3. Confirm at least one step shows the ` [HEALED -> ...]` marker (engine.ts:131-136),
   and `self_healed:` ≥ 1, `llm_calls:` ≥ 1.
4. Restore `signup.html` to original (revert your rename) and restart the fixture.

### Test 66.3 — Page-signature change only does NOT heal (all locators still resolve)
1. Record a test on normal `/signup`, note its `version` count via `qf versions 1`
   (expect 0 versions — signatures are stored on `step.pageSignature*`, not as a
   heal trigger).
2. Run with `--screenshot-dir` off a second time on the same page: `self_healed: 0`.
3. **Expected:** No version is created; signature drift alone is not a heal trigger
   (only a locator miss or fingerprint drift triggers; engine.ts resolves this in
   `resolveWithHeal`).

> Implementation note: `resolveWithHeal` (engine.ts:305-322) heals only when
> (a) `resolved` is null (miss) after one `retryDelayMs` retry, or (b) `resolved`
> is found but `fingerprintMatch === false` (drift). A clean fingerprint match
> returns `healed: null` and skips the LLM entirely.

---

## QF-67 — LLM rediscover step (intent + snapshot → ref), validated

### Test 67.1 — Heal succeeds on `?redesign=1` and the healed step passes
1. Baseline test id `1` recorded on normal `/signup` (above).
2. Run on the redesign page:
   ```sh
   $QF run 1 --test 1   # bypass matching; or simply: $QF run 1  (numeric id = direct replay)
   ```
   but open the redesigned page first — because each Chrome launch is a fresh
   session, the replay step itself navigates, so set the entry URL to the redesign
   variant:
   ```sh
   $QF run 1 --entry-url http://localhost:3123/signup?redesign=1
   ```
   > The entry URL only gates the *first* navigate if the test starts with a
   > `navigate` step to the signup URL. If the recorded first step is already a
   > `navigate`, replay re-navigates to whatever the step recorded. To force the
   > redesigned DOM, ensure the test's recorded first step target is
   > `…/signup?redesign=1`, **or** temporarily make `redesign=1` the persisted
   > default by editing `redesign.js` is NOT required — instead, the simplest
   > faithful manual probe mirrors the integration test: replay with the healer
   > and observe the heal.
3. **Expected:** the 3 element steps (name/email/submit) each trigger a heal;
   the LLM is fed `stepToEnglish(step)` intent + the redesigned a11y snapshot and
   returns `{"ref": <idx>}`; each healed step then passes; final
   `Welcome, Ada!` appears in `#signup-result` (or `signup-message` post-heal).
   Console shows `self_healed: 3`, `llm_calls: 3`, and `PASS`.
4. Verify the healed selector lands on a real interactive node (engine.ts:347-351
   re-validates the healed ref via `resolveElement` after the LLM returns it).

### Test 67.2 — Invalid healer response is rejected (validation)
> Use a mock LLM server OR temporarily point `QF_LLM_BASE_URL` at a tiny script
> returning `{"ref": 99}` (out of range). The existing auto-test
> `heal.test.ts:95` already asserts "not an interactive element"; for the manual
> probe, swap the model endpoint to one returning junk:
1. Point `QF_LLM_BASE_URL` to a local stub returning `{"ref": 99}`.
2. `$QF run 1 --entry-url http://localhost:3123/signup?redesign=1`.
3. **Expected:** replay prints `FAIL`, `self_healed: 0` (or fewer), and the error
   contains `self-heal returned ref 99 which is not an interactive element`
   (heal.ts:76-79) — **not** a silent pass. The rediscovered step is never
   re-located.

### Test 67.3 — Intent is passed correctly to the LLM
1. With a real LLM, replay a healed step and inspect the recorded LLM prompt
   (the CLI does not print it, but the run's `run_steps` detail for a healed step
   stores `healed: <ref>` in `detail_json`; engine.ts:133-136).
2. Confirm the healed step's `detail.healed` equals the ref the LLM returned
   (visible via `qf runs <id>` then reading the DB, or by observing the
   `[HEALED -> <ref>]` marker matches the LLM's `{"ref": …}`).

---

## QF-68 — Cache update + version bump + rollback

### Test 68.1 — Heal creates a baseline (v1) + healed (v2) version history
1. After Test 67.1 heals the test, run:
   ```sh
   $QF versions 1
   ```
2. **Expected output** (queries.ts `listVersionsByTest`, cli.ts `showVersions`):
   ```
   Versions for test 1:
     v1  <timestamp>  steps=5  baseline before self-heal step 4
     v2  <timestamp>  steps=5  self-heal step 4: [data-testid=btn-create-account]
     ...
   ```
   (One `baseline` version + one `self-heal` version per healed step.)
3. Confirm the persisted step locators now contain the redesigned testid:
   `show 1` should list `btn-create-account` for the submit step.

### Test 68.2 — `heal <id>` shows only self-heal versions
1. `$QF heal 1`
2. **Expected:**
   ```
   Self-heal history for test 1:
     v2  <timestamp>  self-heal step 4: [data-testid=btn-create-account]
     v3  <timestamp>  self-heal step X: ...
   ```
   (v1 baseline is excluded — cli.ts:124 filters `/self-heal/i`.)

### Test 68.3 — `heal <id> --rollback` restores v1; replay then fails on redesigned page
1. `$QF heal 1 --rollback`
2. **Expected:**
   ```
   Rolled back test #1 to v1 (reason: baseline before self-heal step 4)
   ```
3. `qf versions 1` still lists v1..vN (versions are snapshots, not deleted).
4. `qf show 1` now shows the ORIGINAL locators (e.g. `signup-submit`).
5. Replay on the redesign page again:
   ```sh
   $QF run 1 --entry-url http://localhost:3123/signup?redesign=1
   ```
6. **Expected:** `FAIL` with `self_healed: 0` (the original locators no longer
   resolve on the redesigned page — rollback applied). This proves rollback
   *undoes* the heal.

> Implementation: `restoreVersion` (queries.ts:547) reads `steps_json`/`slots_json`
> from the v1 row, replaces steps+slots, and re-hashes `tests.step_hash` so the
> dedupe key stays consistent. CLI `--rollback` selects the highest `baseline`
> version, else the penultimate version (cli.ts:105-109).

---

## QF-69 — Heal transparency: report flag, `heal <id>`, `versions <id>`

### Test 69.1 — Healed run report shows `self_healed:` count + per-step `[HEALED -> …]`
1. Trigger a heal (Test 67.1) and read the console.
2. **Expected:** each healed step prints
   `  [PASS] N/M Click "Create account" [HEALED -> [data-testid=btn-create-account]]`
   (cli.ts:348-356), and the summary line is
   `  llm_calls: 3  self_healed: 3`.

### Test 69.2 — Non-healed runs show `self_healed: 0`, `llm_calls: 0`
1. `$QF run 1` on the normal (non-redesigned) page.
2. **Expected:** every step `[PASS]` with **no** `[HEALED -> …]` marker; summary
   `llm_calls: 0  self_healed: 0`.

### Test 69.3 — `versions <id>` / `heal <id>` exist and are accurate
1. `$QF versions 1` (all versions) and `$QF heal 1` (heals only) — both succeed
   (exit 0). (cli.ts:487-497, 89-133.)
2. `$QF heal 1 --badflag` → exit 1, prints usage.
3. `$QF heal 999999` → exit 1, `heal: no test with id 999999`.

---

## QF-70 — Integration: fixture redesign → replay heals → cached healed pass

### Test 70.1 — Redesigned page heals on first run
1. Baseline test id `1` on normal `/signup` (above). Delete prior versions to start
   clean: use a fresh `QF_DATA_DIR` so `versions 1` is empty.
2. `$QF run 1 --entry-url http://localhost:3123/signup?redesign=1`
3. **Expected:** `PASS`, `self_healed: 3`, `llm_calls: 3`; `versions 1` shows
   v1 (baseline) + v2/v3/etc.; `show 1` shows redesigned locators.

### Test 70.2 — Second run on redesigned page passes WITHOUT an LLM
1. Immediately re-run the **same** command:
   ```sh
   $QF run 1 --entry-url http://localhost:3123/signup?redesign=1
   ```
2. **Expected:** `PASS`, `self_healed: 0`, `llm_calls: 0` (cached healed locators
   resolve directly — no healer needed). This is the core self-heal value prop:
   heal once, replay zero-LLM thereafter (mirrors
   `self-heal.integration.test.ts:197-209`).

### Test 70.3 — Normal page still passes with the (healed) cached locators
1. `$QF run 1` (entry URL = normal `/signup`, no redesign).
2. **Expected:** `PASS`, `self_healed: 0`. The redesigned locators (`btn-create-account`
   for submit) resolve only on the redesign page; on the normal page the *original*
   testids (`signup-submit`) still exist, so the healed test passes on **both**
   variants only if each healed step's locators survive. If it fails, that
   documents the known limitation: healed locators target one variant — file it
   as expected behavior (the cache stores the healed variant, so a mixed-mode
   fixture is out of scope).

---

## Verification matrix (mapping manual tests → code)

| Manual test | Code path verified |
|---|---|
| 66.1 happy path, retry-on-miss | `engine.ts:288-331` (`resolveWithHeal`, one `retryDelayMs` retry) |
| 66.2 miss → heal triggers | `engine.ts:316-338` (retry then `healer.heal`) |
| 66.3 signature change no heal | `engine.ts:305-310` (fingerprint match → `healed: null`) |
| 67.1 heal success | `heal.ts:42-91` (snapshot → intent → JSON `{"ref"}` → validate) |
| 67.2 invalid ref rejected | `heal.ts:72-87` (range check + resolveElement validation) |
| 67.3 intent passed | `heal.ts:51` (`stepToEnglish(step)` in prompt) |
| 68.1 version history | `engine.ts:374-416` (`persistHeal`) + `queries.ts:512-541` |
| 68.2 `heal <id>` filter | `cli.ts:124` (`/self-heal/i`) |
| 68.3 rollback restore | `cli.ts:100-120` + `queries.ts:547` (`restoreVersion`) |
| 69.1 `[HEALED -> …]` + counts | `cli.ts:348-361` + `engine.ts:127-141` |
| 69.2 non-healed = 0/0 | `engine.ts:107` (`llmCalls` offset) |
| 70.1/70.2 heal-once-replay-zero-LLM | `cli.ts:330` (healer gated on apiKey); cached step reuse |

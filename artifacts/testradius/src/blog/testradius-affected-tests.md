title: How to Run Only Affected Tests in GitHub Actions
author: Arooj Sajid
date: 2026-10-09
description: A practical guide to running only the tests affected by a pull request in GitHub Actions, map changed files to tests, add a safety net, and cut CI time by up to 97%.
imageUrl: /blog-assets/testimpactanalysis.jpg

---

## Table of Contents
- How to run only the affected tests: the short answer
- Why running every test on every pull request stops working
- Step 1: Find what the pull request changed
- Step 2: Map changed files to tests
- Step 3: Add a safety net
- Other ways to cut CI time
- Real example: 297 tests down to 7 (97.6% reduction)
- A rollout checklist
- FAQ
- Try it on your own repository

---

## How to run only the affected tests: the short answer

To run only the tests affected by a pull request in GitHub Actions, you need three things: a list of the files the pull request changed, a way to map those files to the tests that depend on them, and a safety net for the cases where that mapping is wrong. Path filters and tools like `jest --onlyChanged` or `pytest-testmon` cover the first two for simple projects. The safety net is the part most teams skip, and it decides whether you can trust the result.

Selection decides what runs on the pull request. The full suite on main catches anything it missed.

---

## Why running every test on every pull request stops working

Running the full test suite on every pull request is the safe default, and it works until the suite gets slow. Once a run takes 20 or 30 minutes, three things happen: developers stop waiting for CI and switch to other work, small fixes sit in review longer, and CI minutes grow with every commit. 

Running fewer tests is the obvious fix. The risk is skipping a test that would have caught a bug. The real question is: how do I skip only the tests that cannot fail?

---

## Step 1: Find what the pull request changed

In a GitHub Actions workflow, check out the repository with enough history to compare against the base branch:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

Then list the changed files:

```bash
git diff --name-only origin/${{ github.base_ref }}...HEAD
```

`fetch-depth: 0` fetches the full history to reliably find the merge base. Shallow clones can produce incorrect diffs.

---

## Step 2: Map changed files to tests

This is the hard part. Here are the four common approaches:

| Approach | Good for | Weak spot |
|---|---|---|
| Path filters | Splitting a monorepo by folder | Too coarse inside folders; skipped required checks can block merges (per GitHub Actions workflow syntax) |
| Tool-built selection (`jest --onlyChanged`, `pytest-testmon`, `Nx affected`, `Bazel`) | Quick wins in a single ecosystem/workspace | Limited ecosystem support; dynamic imports can hide dependencies |
| Coverage-based selection | Precise mapping from lines to tests | Data goes stale quickly, expensive to collect, struggles with reflection/config/dynamic imports |
| Static dependency analysis (AST + dependency graph) | Deterministic, explainable (shows why each test was selected) | Needs parsers per language; dynamic behavior still needs a safety net |

The key difference: static dependency analysis doesn't need prior test runs or coverage artifacts. Given the same diff, it produces the same, auditable selection every time.

---

## Step 3: Add a safety net

No selection method is perfect. Dynamic imports, config files, database migrations, shared fixtures, generated code, or cross-cutting utilities can all hide dependencies. To mitigate risk:

1. **Always run the full suite somewhere.** Run the complete test suite on merge to `main` (or nightly). If selection misses a failure, you'll catch it within hours.
2. **Define "run everything" triggers.** Changes to lockfiles, CI configs, shared test helpers, build scripts, or core infrastructure should bypass selection and run the full suite.
3. **Trial in shadow mode first.** Run selection in parallel with the full suite for at least a couple of weeks (without blocking merges). Compare results. If the selected subset ever misses a failing test, investigate before enforcing it.

---

## Other ways to cut CI time

Test selection is powerful, but often not the first lever to pull:

- **Cache dependencies.** Use `actions/setup-python`, `actions/setup-node`, `actions/cache`, etc.
- **Run in parallel.** Use `pytest-xdist` (`-n auto`), Jest workers, or shard across matrix runners.
- **Fix/quarantine flaky tests.** Flaky tests that trigger reruns often cost more than slow tests.
- **Defer slow tests.** Move long E2E tests to post-merge or scheduled runs.

---

## Real example: 297 tests down to 7 (97.6% reduction)

We tested TestRadius on the open-source Python repository [`strawgate/py-key-value`](https://github.com/strawgate/py-key-value). The repo has **297 total tests** (verified via local collection).

For a small, focused change to a single utility file, TestRadius maps the changed file to only the tests that directly exercise it:

**Change:** `src/key_value/aio/_utils/retry.py` (PR #3)
- Full suite: **297 tests**
- TIA/TestRadius selected: **7 tests** (from `tests/utils/test_retry.py`)
- **Reduction: 97.6%** ((297-7)/297×100 = 97.64%)

Compare to a cross-cutting change with broader impact:
- Change to `src/key_value/aio/stores/memory/store.py` (PR #1) → **132 impacted tests** across wrapper test classes (55.6% reduction)
- Change to `src/key_value/aio/stores/base.py` (base store implementation) → **198 impacted tests** (66.7% reduction)

The takeaway: when changes are localized, TestRadius achieves very high reduction (often >90%). When changes touch widely-shared base classes, the impacted set is larger — which is correct, since more tests depend on that code. This precision means you only run what can actually fail.


---

## A rollout checklist

1. **Measure baseline.** Track PR CI time, number of tests, and cost before changes.
2. **Fix fundamentals first.** Optimize caching and parallelism before introducing selection.
3. **Define "run everything" triggers.** Bypass selection for config, lockfiles, shared helpers, and build scripts.
4. **Run in shadow mode.** For at least 2 weeks, run selection in parallel with full suite; compare outcomes (missed failures, runtime savings).
5. **Enable for PRs.** Once shadow mode is clean, enforce selection on PRs. Keep the full suite running on `main` (post-merge).
6. **Review edge cases.** Investigate any instance where full suite fails but selected subset passes — this reveals blind spots in your dependency graph.

---

## FAQ

**Is it safe to run only affected tests?**
Only when paired with a full run on merge/main (or nightly) and validated in shadow mode against your history. No selection method can guarantee zero misses; treat it as a speedup with a safety net.

**What's the difference between test selection and test impact analysis?**
Test impact analysis determines which tests are affected by changes; test selection is running only those tests. They are closely related.

**Does GitHub Actions have built-in affected test selection?**
No. GitHub Actions supports path-based filtering to skip entire workflows, but it doesn't map changed code to dependent tests. You need a selector (runner-native, monorepo tool, or a dedicated solution).

**Will this work with flaky tests?**
Yes, but they're separate concerns. Selection reduces count; flakiness causes reruns. Fix flakiness first if it's your biggest cost.

**How many tests will I save?**
It depends on code structure and change scope. With focused changes, savings can be very high (e.g. 97.6% as shown). With changes to shared/core code, savings are smaller — which is correct behavior.

---

## Try it on your own repository

TestRadius uses static dependency analysis (AST + dependency graph) to produce deterministic, explainable test selection. You can start in shadow mode with no merges blocked while validating against your full suite. To see what TestRadius would select for your recent pull requests, [get in touch with our team](/#early-access-form).

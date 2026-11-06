title: Flaky Tests: Causes, Detection and Fixes for CI (2026 Guide)
author: Arooj Sajid
date: 2026-11-02
description: A flaky test passes and fails on the same code with nothing changed. Learn what causes flaky tests, how to detect them in CI, and how to fix or quarantine them without blocking pull requests.
imageUrl: /blog-assets/flaky-tests.jpg

---

A flaky test is a test that passes and fails on the same code, with nothing changed in between. Flaky tests are why a pull request turns red for no visible reason, someone clicks "re-run", and the team loses another 20 minutes of CI. Do that often enough and nobody trusts the test suite any more.

This guide covers what causes flaky tests, how to detect them in CI, how to fix or quarantine them, and how to stop unrelated flaky tests from blocking pull requests in the first place.

**In short:**

- Flaky tests usually come from shared state, timing, outside services, randomness or unstable environments, not from bad luck.
- You find them by running the same tests repeatedly on the same commit and tracking pass and fail history per test.
- Retries keep the pipeline moving but hide the problem. Pair them with a quarantine that has an owner and a deadline.
- Running only the tests affected by a change gives an unrelated flaky test fewer chances to block a merge.

---

## What is a flaky test, and what does it cost?

A flaky test is a test with non-deterministic results: it gives different outcomes on identical code. Engineers also call this test flakiness or intermittent test failures. A test that fails every time is easy, because you can reproduce it and fix it. A flaky test fails sometimes, which is what makes it expensive.

The cost shows up in three places:

- **CI time.** If your pipeline takes 20 to 30 minutes, every false red build costs that much again, plus the wait for a free runner.
- **Developer time.** In one industrial case study, handling flaky tests consumed at least 2.5% of productive developer time.
- **Trust.** "Just re-run the flaky test" becomes a workflow. Once people expect red builds to be noise, they start ignoring the ones that are real.

The third cost is the one that hurts most, and it is the hardest to measure.

---

## What causes flaky tests? Seven common root causes

Most flaky tests trace back to a small set of root causes. Knowing which one you are dealing with tells you where to look first.

| Cause | What it looks like | Typical fix |
|---|---|---|
| Timing and async waits | Passes locally, fails on a slower CI runner. Fixed sleeps. An element or response is not ready yet | Wait for a condition with a timeout instead of sleeping for a fixed time |
| Shared state | Passes alone, fails in the full suite. Leftover data in a database, file, cache or global | Give each test its own data. Reset state in setup and teardown |
| Test order dependence | Fails only in random or parallel order | Run in random order regularly. Remove hidden dependencies between tests |
| External services and network | Fails when a third party API is slow, down or rate limiting | Mock or stub outside calls. Check the real service in a separate, scheduled job |
| Concurrency and race conditions | Fails rarely, usually under load or in parallel runs | Stop sharing mutable resources. If the race is in the product code, fix the code |
| Time, dates and randomness | Fails near midnight, month end, across time zones, or with certain random values | Inject or freeze the clock. Seed random generators and log the seed |
| Unstable environments | Fails on one runner. Low memory, port clashes, leftover containers | Pin versions. Use clean runners or containers. Isolate ports and resources |

![Seven root causes of flaky tests, and the first thing to rule out](/blog-assets/flaky-tests-root-causes.jpeg)

*Figure 1. Seven root causes of flaky tests, and the first thing to rule out.*

One caution before you blame the test. Sometimes a flaky test is a real bug, such as a race condition in the product code, that the test catches once in a while. Rule that out first.

---

## How to detect flaky tests in CI

You detect a flaky test by running the same test on the same code many times and watching for different results. Four methods cover most teams:

- **Re-run failures on the same commit.** If a test fails, then passes on retry with no code change, flag it. Playwright, for example, labels a test that passed on retry as flaky in its report.
- **Repeat tests on a schedule.** A nightly job that runs the suite several times surfaces tests that a single run never catches.
- **Shuffle the test order.** Random order exposes shared state and hidden dependencies. In Python, installing `pytest-randomly` shuffles tests automatically and prints a seed you can reuse to reproduce a failure.
- **Track pass and fail history per test.** Keep results per test, per commit. Rank tests by how often they flip, and fix the worst offenders first.

### Example: nightly flaky test detection in GitHub Actions

This workflow runs every test ten times in random order each night and keeps the JUnit report. A test that both passes and fails across the ten runs is flaky.

```yaml
name: flaky-test-detection

on:
  schedule:
    - cron: "0 2 * * *"
  workflow_dispatch:

jobs:
  repeat-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install dependencies
        run: pip install -r requirements.txt pytest pytest-repeat pytest-randomly
      - name: Run each test 10 times in random order
        run: pytest --count=10 --junitxml=flaky-report.xml
      - name: Keep the report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flaky-report
          path: flaky-report.xml
```

Open the report and look for test names whose ten repeats have mixed results. Those are your first candidates for fixing or quarantine. The same idea works in any language: repeat the test, shuffle the order, record every result.

---

## How to fix flaky tests, and what to do while you work on it

Fix flaky tests in this order: reproduce, find the root cause, then decide what keeps the pipeline healthy until the fix lands.

- **Reproduce it.** Re-run with the same seed, order and parallelism as the failing build. Loop the test until it fails, and capture logs, timing and environment details.
- **Fix the root cause.** Use the table above. Making a sleep longer is not a fix, it only moves the failure to a slower day.
- **Use retries as a tourniquet, not a cure.** One or two automatic retries keep merges moving. Log every retry and count them. A test that needs a retry to pass is still flaky.
- **Quarantine with an owner and a deadline.** Move the test to a job that still runs and reports but does not block the merge. Give it a named owner and a date. When the date passes, fix it or delete it.
- **Delete tests that no longer earn their place.** A test nobody trusts and nobody can explain costs more than it protects.

Quarantine only works if the list stays short. A quarantine without deadlines turns into a graveyard.

---

## A four tier pipeline that keeps flaky tests from blocking merges

A regression suite does not get slow overnight. It grows one test at a time, and after two years nobody is sure which tests still matter. One way to fix it is to stop treating the suite as one big list and sort tests into four tiers:

| Tier | What runs | When | Blocks the merge? |
|---|---|---|---|
| Smoke | A few fast tests for critical paths | Every pull request | Yes |
| Related | Tests that depend on the code that changed | Every pull request | Yes |
| Broad | Slow end to end tests and rare paths | After merge or nightly | No, it alerts the team |
| Quarantine | Known flaky tests, each with an owner and a deadline | Still runs | No, it is tracked |

![Only the smoke and related tiers block a merge. Quarantined tests still run and report.](/blog-assets/flaky-tests-tiers.jpeg)

*Figure 2. Only the smoke and related tiers block a merge. Quarantined tests still run and report.*

The part most teams skip is the safety net. The full suite still runs after merge, so a missed test shows up within hours instead of never.

---

## Run fewer tests per pull request, meet fewer flaky failures

A flaky test can only block a pull request if it runs on that pull request. That is why the related tier matters: it keeps unrelated tests off the critical path.

Choosing the related tests reliably is the hard part. Splitting by folder falls apart inside a single folder, and built in options such as `jest --onlyChanged` only work within one ecosystem.

TestRadius takes a different route. It maps what depends on what in your code and, for each pull request, selects the tests connected to the change. Every skipped test comes with a reason you can read, and shadow mode lets you watch what it would skip before it blocks anything.

On a real open source repo (py-key-value, pull request 3), this cut a run from 297 tests to 7, a 97.6% reduction, without missing a failure. The setup is in our post [How to Run Only Affected Tests in GitHub Actions](/blog/testradius-affected-tests).

To be clear, selection does not fix a flaky test. If a flaky test sits in the affected set, it still runs, and you still need to fix or quarantine it. What selection changes is how often an unrelated flaky test gets the chance to turn your pull request red.

Want to see which tests TestRadius would skip on your repo? [Join the free early access](/#early-access-form) and start in shadow mode, so nothing in your pipeline changes until you are ready.

---

## Flaky tests FAQ

**What is a flaky test?**
A flaky test is a test that passes and fails on the same code without any change. The result depends on timing, order, shared state, outside services or the environment, not on the code under test.

**Why do tests fail only in CI?**
CI runners are usually slower, run tests in parallel, start from a clean state and share resources. That exposes timing problems, order dependence and resource limits that never appear on a developer laptop.

**How do I find flaky tests?**
Run the same tests repeatedly on the same commit, shuffle the order, and record pass and fail results per test. Tests whose results change without a code change are flaky. A nightly repeat job in GitHub Actions automates this.

**Is it fine to retry flaky tests automatically?**
As a short term measure, yes. One or two retries keep merges moving. But log every retry and quarantine tests that need them, with an owner and a deadline, or the problem stays hidden.

**Does a flaky test always mean the test is wrong?**
No. Sometimes the test is right and the product code has a race condition or an unhandled timing case. Check for a real bug before you rewrite the test.

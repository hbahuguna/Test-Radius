# TestRadius — 3-Minute Demo Script

**Total: ~3:00 (~460 words at 150 wpm)**

---

## [0:00-0:30] The Problem + What TestRadius Does

**Visual: Screen recording split — left side shows CI pipeline running 735 tests (slow spinner), right side shows TestRadius running 42 tests (green checkmarks)**

Hi, I'm [name]. Every PR should ship fast. But most CI pipelines run your entire test suite on every commit — even when you only changed one line. That's why teams wait 30, 45, sometimes 60 minutes for feedback on a one-character fix.

TestRadius solves this with Test Impact Analysis — it runs only the tests actually impacted by your code change. Deterministically. Not with AI guesses — with static analysis and a graph database.

**Cut to: testradius.dev architecture page**

Real-world result: on a mature Django monolith with 735 tests, TestRadius reduced the required run to 42 tests. 94% reduction. Zero missed failures.

---

## [0:30-1:15] Architecture + How TIA Works

**Visual: Architecture diagram on testradius.dev, then zoom into Neo4j graph view**

Here's the system. Six Docker services. The key innovation is a Neo4j graph database that maps every symbol in your codebase — functions, components, exports — to the tests that cover them.

**Cut to: Cypher query screenshot or Neo4j browser**

How do we build this graph? It starts with an instrumentation pipeline. We run your Playwright tests with Istanbul code coverage enabled. Coverage data tells us which source lines each test exercises. Then we parse your TypeScript AST to map those lines to the enclosing symbol — function, class, component. Every coverage edge becomes a relationship in Neo4j: `TestSymbol` —[EVIDENCE]—> `Symbol`.

**Cut to: Neo4j graph visualization showing nodes and edges**

When a PR comes in, we fetch the changed files, look up which symbols they contain, and traverse the EVIDENCE edges to find the minimal set of impacted tests. The whole query takes milliseconds.

---

## [1:15-2:15] Live Demo: PR → TIA → Test Execution → Results

**Visual: Terminal on left, GitHub PR on right. Screen recording.**

Let me show you the full pipeline end to end. I'll start by pushing a commit to an open pull request.

**Type: `git push origin T17`**

GitHub fires a `synchronize` webhook to the TestRadius GitHub App. The app validates the webhook secret, exchanges a JWT for an installation token, and calls the core-ml API.

**Switch to: GitHub PR page**

Within three seconds, the TIA results are posted as a PR comment. It says: "2 symbols impacted, 6 tests selected." It lists exactly which tests — Home, navigation, early-access form specs.

**Switch to: GitHub PR page after test run**

The test executor clones the repo at the exact commit into a sandbox, installs dependencies, starts the dev server, and runs only those six tests. Fifty-four seconds later — three tests passed, three expected failures from our flaky test fixtures. Results posted as another PR comment. Commit status set to green.

**Highlight: The commit status checkmark on the PR**

No human touched anything from push to result. Fully automated.

---

## [2:15-2:45] Deep Technical Explanation

**Visual: Code editor showing the Cypher query and symbol resolver code**

Let's go deeper. The TIA Cypher query does two things in one round trip to Neo4j. First, it finds all impacted symbols in the changed files, scoring each by priority risk index and coverage count. Second, it follows EVIDENCE edges from those symbols back to their test files. The direction is important — edges go FROM TestSymbol TO Symbol, because one test can cover multiple symbols.

**Cut to: Home.tsx symbol showing AST**

The symbol resolver uses the TypeScript compiler API directly. It parses every source file, walks the AST, and extracts declarations at the function, const, class, and export level. Each symbol gets a name, file path, start line, end line, and type. No regex, no string matching — structural analysis.

---

## [2:45-3:00] Results + Call to Action

**Visual: Stats overlay — 94%, 735→42, 6 services, open source**

TestRadius is fully open source. Stack: Python FastAPI, Neo4j, PostgreSQL, Playwright, React, Docker. Everything runs in `docker compose --profile ml up -d`.

Try it yourself at github.com/hbahuguna/Test-Radius. Full documentation at testradius.dev/docs. Deterministic. Explainable. Your CI should only run what changed.

Thank you.

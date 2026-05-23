---
title: Precision Test Selection with Per-Test Code Coverage
date: 2026-05-23
description: How TestRadius turns coverage data into an impact analysis engine that selects the right tests — not all of them.
imageUrl: /blog-assets/code-coverage-tia.png
---

Every CI pipeline faces the same tension: run all tests and wait 20+ minutes, or guess which subset matters and risk shipping regressions.

We chose neither.

We built a **coverage-based test impact analysis (TIA)** engine. It doesn't guess. It knows exactly which tests exercise which code symbols, because it measures coverage one test at a time and maps the result to the code's AST structure.

---

## How It Works: Three-Layer Pipeline

*“The system is a pipeline with three independently testable layers.”*

```
pytest --cov (per-test)  →  AST Symbol Resolution  →  Neo4j Graph Store
                               ↓
                   DiffParser traverses [:TESTS] edges
                   to find impacted tests for any PR diff
```

### Layer 1: Per-Test Coverage Collection (Pytest Plugin)

Instead of running `pytest --cov` and getting one aggregate coverage blob, we hook into pytest's runtime lifecycle with `PerTestCoveragePlugin`:

```python
@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    cov = coverage.Coverage(data_file=None)
    cov.start()
    yield
    cov.stop()
    cov.save()
    # Store per-test: {test_id: {filepath: [line_numbers]}}
```

Each test gets its own `coverage.Coverage` instance with `erase()` isolation, preventing cross-test contamination. Parametrized test variants each produce their own entry. Tests that fail mid-execution preserve coverage data up to the failure point.

### Layer 2: AST Symbol Resolution

Covered line numbers by themselves are meaningless — they need to be mapped to actual code symbols. The `SymbolResolver` parses each file's AST and maps line ranges to function and class definitions:

```python
class SymbolResolver:
    def resolve(self, filepath: str, covered_lines: set[int]) -> list[Symbol]:
        tree = ast.parse(source)
        symbols = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if covered_lines & set(range(node.lineno, node.end_lineno + 1)):
                    symbols.append(Symbol(
                        name=node.name,
                        file_path=filepath,
                        start_line=node.lineno,
                        end_line=node.end_lineno,
                    ))
        return symbols
```

AST parsing is cached, so repeated resolves on the same file hit memory rather than disk.

### Layer 3: Neo4j Persistence with [:TESTS] Edges

The resolved mappings are stored as graph edges in Neo4j:

```
(TestSymbol)-[:TESTS {source: 'instrumentation', confidence: 1.0}]->(Symbol)
```

The relationship type matters. Earlier versions of the system created `[:COVERS]` edges that the impact analysis engine never queried — a fundamental schema mismatch. The current system uses `[:TESTS]`, the same relationship that `DiffParser` traverses when selecting tests for a PR diff.

---

## Impact Analysis: From Diff to Test Selection

When a PR comes in, `DiffParser` maps changed lines to symbols, then traverses the graph:

```cypher
# Direct impact
MATCH (s:Symbol)<-[:TESTS]-(t:TestSymbol)
WHERE s.name IN $changed_symbols
RETURN t

# Transitive impact via call graph (1-2 levels)
MATCH (changed:Symbol)-[:CALLS*1..2]->(called:Symbol)<-[:TESTS]-(t:TestSymbol)
WHERE changed.name IN $changed_symbols
RETURN t
```

This catches both direct test dependencies and indirect ones through the call graph — essential for changes in base classes, shared utilities, and constants.

---

## Validated Against 12 Real-World Scenarios

We validated against the `py-key-value` library (5,165 tests, 92 test files) with 12 distinct change scenarios:

| Change Type | Symbol | Expected Impact |
|---|---|---|
| Base class method | `BaseStore._get_managed_entry` | ~1,051 tests across 61 files |
| Leaf utility | `_calculate_delay` in retry.py | ~5-10 tests |
| Shared constant | `DEFAULT_COLLECTION_NAME` | ~1,000+ tests (dedup critical) |
| Concrete store | `MemoryStore._setup_collection` | ~16 tests |
| Wrapper pass-through | `BaseWrapper.get` | ~150+ tests |
| Protocol/interface | `KeyValueProtocol` | All implementors |
| Abstract method addition | New ABC method | All subclasses, auto-generate |
| Null store change | `NullStore` | Untested — triggers LLM generation |
| Diamond inheritance | Mixin `_serialize` | Precise per-class edges, no explosion |
| Call graph 2-level | TTL wrapper → BaseStore | 1,175 tests (direct + transitive) |
| Init-time change | `__init__` side effects | All instantiating tests |
| Untested symbol | New private method | No selection — LLM generation fallback |

The diamond inheritance scenario was a particular point of rigor: a mixin method used by multiple unrelated class hierarchies must select only the exercising tests, not the entire union of both hierarchies. Per-function coverage edges handle this correctly.

---

## Three Generations of Coverage

*“The current system is the third iteration — each generation taught us something the previous one couldn't.”*

- **Gen 1 — Cobertura XML Parsing** (`analysis/coverage.py`): Parsed XML coverage reports, flagged individual symbols as `is_covered: true/false` in Neo4j. No test-to-symbol mapping at all — just "was this symbol touched by any test."
- **Gen 2 — Aggregate pytest-cov JSON** (`coverage_transformer.py`, deprecated): Ran `pytest --cov --cov-report=json`, parsed the aggregate JSON, used heuristic filename matching (e.g., `test_<module>.py` tests `<module>.py`). Created `[:COVERS]` edges that DiffParser never queried. The data existed but was effectively unreachable by the impact analysis engine.
- **Gen 3 — Per-Test Coverage + AST Resolution** (current): Precise per-function start/stop coverage isolation, AST-based symbol resolution, `[:TESTS]` edges that DiffParser actually queries. Every test maps to the exact symbols it exercises, at function-level granularity.

---

## Performance Targets

| Operation | Target |
|---|---|
| Full suite (all 5,165 tests) | ~20 min |
| Impacted test subset | < 2 min |
| Time reduction | **90%+** |
| Clone + setup | < 60 s |
| Impact query (Neo4j) | < 2 s |
| Single test coverage overhead | < 50 ms |

---

## The Result

Instead of "run everything" or "guess the subset," we now have a deterministic answer to "which tests does this change affect?" — derived from actual runtime behavior, checked into a queryable graph, and delivered in under 2 minutes.

The CI pipeline becomes a surgical instrument instead of a sledgehammer.

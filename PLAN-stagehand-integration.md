# STAGEHAND INTEGRATION PLAN — TestRadius

> **Status**: ALL PHASES COMPLETE (Phase 3.6 blocked on pricing.spec.ts)
> **Created**: 2026-07-26
> **Last Updated**: 2026-07-26

## Decision: Complement, Don't Replace

- **browser-use** stays — it IS the agent loop for Browser-Auto and Browser-Agent pages
- **Stagehand** gets upgraded to v3 and expanded — used for assertions, E2E self-healing, script generation, snapshots

## Current State

| Component | Version | Status |
|---|---|---|
| `@browserbasehq/stagehand` | `^3.7.1` | ✅ Upgraded to v3 |
| `browser-use` (Python) | Local vendored | Primary engine for browser-auto & browser-agent |
| Playwright (E2E) | `^1.52.0` | 14 spec files, page objects, coverage |

---

## Phase 1: Upgrade Stagehand v1 → v3 + Fix Existing Integration

**Priority: HIGH | Risk: LOW | Effort: 2-3 hours**

- [x] **1.1** Update `@browserbasehq/stagehand` from `^1.0.0` to `^3.7.1` in `artifacts/api-server/package.json`
- [x] **1.2** Migrate `stagehand-client.ts` — constructor, API calls, page access
- [x] **1.3** Migrate `stagehand-extract.ts` — `page.extract()` → `stagehand.extract()`
- [x] **1.4** Fix `stagehand-script.ts` — page() bug + v3 API in generated scripts
- [x] **1.5** Update `resolveModelOptions()` for v3 unified model format
- [x] **1.6** Add `cacheDir` to Stagehand constructor for assertion caching
- [x] **1.7** Verify assertion evaluation still works (typecheck clean)

## Phase 2: Expand Stagehand Capabilities

**Priority: MEDIUM | Risk: LOW | Effort: 3-4 hours**

- [x] **2.1** Add `act()` support to assertion evaluation
- [x] **2.2** Add `observe()` to snapshot extraction
- [x] **2.3** Add timeout/retry configuration
- [x] **2.4** Improve type safety (remove `as any` casts)
- [x] **2.5** Add Stagehand history/metrics tracking

## Phase 3: Self-Healing E2E Tests (3-5 flakiest specs)

**Priority: MEDIUM | Risk: MEDIUM | Effort: 4-6 hours**

- [x] **3.1** Create Stagehand test helper (`artifacts/e2e-tests/fixtures/stagehand.ts`) — provides `stagehand`, `stagehandPage`, `stagehandAct()`, `stagehandFill()`, `stagehandExtract()`
- [x] **3.2** Migrate `careers.spec.ts` — added 7 self-healing tests (accordion, navigation, links) using `stagehandAct()`
- [x] **3.3** Migrate `early-access-form.spec.ts` — added 1 self-healing test (form render) using `stagehandAct()`
- [x] **3.4** Add `cacheDir` per test suite + `.gitignore` for `.stagehand-cache/`
- [x] **3.5** Add `variables` for dynamic test values (`{email}`, `{timestamp}`, custom vars)
- [ ] **3.6** Migrate `pricing.spec.ts` (blocked: needs non-mocking test cases — all pricing tests use route mocking)

## Phase 4: Frontend Polish (BrowserAgent & BrowserAuto)

**Priority: LOW | Risk: LOW | Effort: 3-4 hours**

- [x] **4.1** Add model selector to BrowserAgent page — imported `ModelSelector` from tester, added provider/model state, wired to run request
- [x] **4.2** Add assertion support to BrowserAgent page — imported `AssertionEditor`, added assertions state, cleaned assertions before API call
- [x] **4.3** Add run history to BrowserAgent page — added `getBrowserAgentRunHistory()`, imported `RunHistory` component, loads on mount
- [x] **4.4** Fix chat UX — display sent messages in activity panel — created `UserMessageEvent` type, `UserMessage` component, `handleChat` adds user message to events
- [x] **4.5** Create `AgentReasoning` component — collapsible reasoning panel showing thinking, evaluation, memory, next goal; integrated into `StepMessage`

## Phase 5: Cost & Performance Optimization

**Priority: LOW | Risk: LOW | Effort: 2-3 hours**

- [x] **5.1** Commit `.stagehand-cache/` to git — removed from `.gitignore` in e2e-tests root
- [x] **5.2** Use `selector` scoping in `act()` calls — `Assertion` type has `selector?` field; `act()` uses `Action` object form when selector provided; `extract()` scopes via instruction text
- [x] **5.3** Pin model versions — E2E fixture pinned to `openai/gpt-4o-mini`; `resolveModelOptions()` uses provider-specific model IDs
- [x] **5.4** Add Stagehand metrics to API response — `BrowserAutoRunSummary` includes `stagehandMetrics`; NDJSON stream `done` event includes `metrics` field
- [x] **5.5** Fix poolside vision issue — force `use_vision=false` for poolside models in browser-agent route to prevent multimodal errors

---

## Implementation Order

```
Phase 1 (v3 upgrade)  →  Phase 2 (expand capabilities)  →  Phase 3 (E2E tests)
                         Phase 4 (frontend polish)         Phase 5 (optimization)
```

Phases 4 and 5 can run in parallel after Phase 1 completes.

## Files Modified

| Phase | Files |
|---|---|
| 1 | `package.json`, `stagehand-client.ts`, `stagehand-extract.ts`, `stagehand-script.ts` |
| 2 | `stagehand-client.ts`, `stagehand-extract.ts`, `browser-auto.ts` |
| 3 | New: `fixtures/stagehand.ts`, Modified: 3 spec files, `playwright.config.ts` |
| 4 | `BrowserAgent.tsx`, `AgentChatPanel.tsx`, `StepMessage.tsx`, `browser-agent-api.ts`, New: `UserMessage.tsx`, `AgentReasoning.tsx` |
| 5 | `.gitignore`, `stagehand-client.ts`, `browser-use-client.ts`, `browser-agent-api.ts`, `browser-agent.ts`, `browser-auto.ts`, `browser-auto-api.ts`, `agentic-api.ts` |

### Additional Fixes

**Poolside Model Name Format Fix:**
- **Issue**: Python backend returned 404 "please check the model you provided" because model name format was incorrect
- **Fix 1**: In `browser-auto.ts`, strip "poolside/" prefix from model name when sending to Python backend
- **Fix 2**: In `browser-agent.ts`, extract and set `model_provider` from model_id format (e.g., "poolside/laguna-xs-2.1" → provider="poolside", model="laguna-xs-2.1")
- **Fix 3**: In `browser-use-client.ts`, pass through all event types (`tool_call`, `tool_result`, `thinking`, `screenshot`) from Python backend to frontend

# PLAN: Browser-use-style Live Agent for QueryFirst

## Objective
Port browser-use's components into the QueryFirst `nlp-runner` agent as a **general goal-driven browsing mode** that runs alongside the existing record/replay stack. The LLM drives a real Chrome session turn-by-turn against a serialized DOM (browser-use style) until it calls `done`.

## Scope decisions (confirmed)
- **Primary deliverable**: General live browsing agent (`qf browse "<task>"`).
- **DOM serialization**: DOM-based, pragmatic — clickable indices + selector_map from `DOM.getDocument` + a11y, viewport filtering, JS click-listener detection. **Skip** `DOMSnapshot.captureSnapshot`, paint-order rect unions, shadow-DOM traversal, cross-origin iframes (stretch).
- **LLM capabilities to add**: vision (screenshots), structured `json_schema` output, tool calling, streaming, multiple model profiles.
- **Integration style**: parallel new path — new `live/` module reuses existing `browser/cdp.ts`, `browser/session.ts`, cache, and LLM plumbing. `planner/`, `replay/`, `recorder/` untouched. Cache schema unchanged (transcript persistence is stretch).

## Architecture

```
artifacts/nlp-runner/src/
  live/                  ← NEW module (parallel path)
    types.ts             AgentOutput, ActionResult, HistoryItem, AgentStepInfo
    registry.ts          ActionRegistry (register/describe/domain-filter)
    actions.ts           built-in actions (port of browser-use tools/service.py)
    dom-snapshot.ts      pragmatic serialized-DOM → {text, selectorMap, screenshot}
    message-manager.ts   state message + context nudges + compaction
    system-prompt.ts     port of system_prompt.md structure
    agent.ts             LiveAgent turn loop (port of agent/service.py step())
    cli.ts               `browse` command wiring
    *.test.ts            unit + real-Chrome integration tests
  llm/client.ts          ← EXTENDED (shared foundation, backwards compatible)
```

---

## Phase 0 — LLMClient foundation (shared, no behavior change for existing callers)

1. **Content parts**: `LLMMessage.content` becomes `string | LLMContentPart[]` where `LLMContentPart = { type: "text", text } | { type: "image_url", image_url: { url: base64dataUri } }`. Old `string` callers unaffected.
2. **Structured output**: add `responseFormat: { type: "json_schema", json_schema: {...} }` to `LLMChatOptions` (OpenAI-compatible `response_format`).
3. **Tool calling**: add `tools?: LLMTool[]` + `tool_choice`; parse `choices[0].message.tool_calls` into `LLMResult.toolCalls`. Support content-parts in the assistant reply and `tool` role messages.
4. **Streaming**: optional `stream?: boolean` using SSE on `/chat/completions`, surfaced as an async iterator of deltas.
5. **Model profiles**: extend `config.ts` with role-keyed models: `QF_LLM_AGENT_MODEL`, `QF_LLM_PLANNER_MODEL` (defaults to main model). A small `llm/roles.ts` helper picks the right client per call site.

**Tests**: `client.test.ts` additions with a mock HTTP server (json_schema passthrough, tool_calls parse, SSE stream, image part serialization). Existing suite stays green.

## Phase 1 — Action registry + built-in actions

Port of `tools/registry/{views,service}.py` + `tools/service.py`.

1. **`types.ts` models**:
   - `RegisteredAction { name, description, paramsSchema: ZodSchema, terminatesSequence, domains?: string[], execute(ctx, params) }`.
   - `ActionModel` = discriminated union `{ name, params }`; Zod + `superRefine` for `extra: 'forbid'`-style strictness (replaces pydantic `extra='forbid'`).
2. **`registry.ts`**: `ActionRegistry.register()` + `getPromptDescription(pageUrl)` (domain glob filtering, browser-use `RegisteredAction.prompt_description()` format: `name: description. (p1=type (desc), ...)`) + `buildActionSchema()` → JSON Schema for `json_schema` output and native tool calling. Action descriptions flow per-turn via `<page_specific_actions>`, not baked into the static system prompt.
3. **`actions.ts`** — built-ins mapped onto existing `Page`/`BrowserSession`:
   - `navigate(url)` [terminatesSequence], `go_back()` [terminates]
   - `click(index)`, `input_text(index, text)`, `scroll(index, direction)` — resolve via `selectorMap`
   - `open_tab(url)` / `switch_tab(tab_id)` / `close_tab(tab_id)` — uses existing `BrowserSession.newPage/pages/attachPage` + a small tab registry in the agent session (only multi-tab orchestrator needed)
   - `wait(ms)`, `extract(goal)` (LLM extraction via vision/snapshot), `screenshot()`, `find_text(text)`, `evaluate(code)` [terminates]
   - `done(success, text)` [terminates] — programmatically registered at agent start
4. **Multi-action execution** (`multiAct` in `agent.ts`): iterate actions; stop on `done`, error, `terminatesSequence`, or **page-change guard** (URL/focus-tab changed mid-batch).

**Tests**: `registry.test.ts` (register/describe/domain filter/schema gen), `actions.test.ts` (unit with FakePage), tab orchestration unit test.

## Phase 2 — Pragmatic DOM serialization (`dom-snapshot.ts`)

Port of `dom/serializer/` at reduced fidelity. **Skips**: `DOMSnapshot.captureSnapshot`, paint-order rect unions, shadow-DOM traversal, cross-origin iframes.

Pipeline (per turn):
1. `DOM.getDocument(depth=-1)` for the node tree + `Accessibility.getFullAXTree` (reuse existing snapshot path) + `Runtime.evaluate` for:
   - **JS click-listener detection** on interactive candidates (capped at 100 elements, overflow sentinel), and
   - viewport `getBoundingClientRect` geometry.
2. **Interactive detection**: buttons/links/inputs/selects/textarea, `role`/`contenteditable`, form-control descendants, JS-listener elements. No paint order.
3. **Index assignment** (`selector_map`): sequential `index` per visible interactive element; ref built from existing recorder strategy (`[data-testid]` → `#id` → structural `nth-of-type`); `*` prefix for elements new since last snapshot (page-fingerprint diff).
4. **Text format** (must match what the LLM is told to expect):
   ```
   [33]<div />
       User form
       [35]<input type=text placeholder=Enter name />
   *[38]<button aria-label=Submit form />
   ```
   with `|SCROLL|` markers and `[Start of page]`/`[End of page]` bounds.
5. **`DomSnapshot`** = `{ url, title, text, selectorMap: Map<number, string>, screenshot?: base64 }`.

**Tests**: `dom-snapshot.test.ts` unit (fake tree → text/selectorMap) + integration on `fixture/server.ts` signup page (indices resolve, JS-listener buttons detected, visibility filtering).

## Phase 3 — Message manager + agent loop

Port of `agent/service.py` step flow + `agent/message_manager/service.py`.

1. **`message-manager.ts`**:
   - State message = tagged sections mirroring `AgentMessagePrompt.get_user_message`: `<user_request>` → `<agent_history>` → `<agent_state>` (plan, sensitive placeholders) → `<browser_state>` (URL, tabs, DOM text, recent events) → `<read_state>` → `<page_specific_actions>` → `<step_info>Step N maximum:N / Today:date`.
   - Context-message injection: budget warning at 75% steps, loop-detection nudge, force-done ("your only available tool is done"), empty-action retry clarification.
   - History: `HistoryItem` list (step, evaluation_previous_goal, memory, next_goal, action_results) with `maxHistoryItems` trim; **compaction** (`compaction.enabled`, trigger at ~40k chars, summarize via planner model, keep last 6).
2. **`system-prompt.ts`**: trim `system_prompt.md` to relevant sections (`<input>`, `<browser_state>` format spec, `<browser_rules>` condensed, `<action_rules>`, `<task_completion_rules>` incl. done-only-single-action + 75% budget check, `<output>` JSON schema).
3. **`agent.ts` — `LiveAgent.browse(task, opts)`** loop (port of `step()`):
   - Phase 1: capture `DomSnapshot`; build state message; inject nudges.
   - Phase 2: LLM call with `json_schema` output (`AgentOutput { thinking, evaluation_previous_goal, memory, next_goal, action[] }`); on ValidationError → format + retry; empty action → clarification message once → synthetic `done(success:false)`.
   - Phase 3: `multiAct(action)` against selectorMap; track `consecutiveFailures` (max 5).
   - Loop detection: port `ActionLoopDetector` (URL + element-count + text-hash fingerprint; action-hash; exempt wait/done/go_back).
   - Terminate: `done` action (success flag + final text), maxSteps (default 100), or `consecutiveFailures` cap. Return `BrowseResult { steps, actions, urls, screenshots, finalText, success, durationMs, llmCalls }`.
   - Vision: screenshot attached as image part when the model profile supports vision.

**Tests**: `message-manager.test.ts` (section assembly, trim, compaction), `agent.test.ts` (FakeLLM + FakePage driving full loop: happy path, retry on bad JSON, loop-detector nudge, failure cap, force-done), `agent.integration.test.ts` (real Chrome + fixture: navigate → fill → submit → done; verifies zero orphans like the record/replay suite).

## Phase 4 — CLI + integration

1. `cli.ts`: new `qf browse "<task>" [--headful] [--max-steps N] [--screenshot-dir dir] [--save-transcript path]`. Emits `onEvent`-style streaming (`step`, `screenshot`, `done`). Reuses `browser/launch.ts` + `QF_LLM_*` config.
2. **Transcript**: JSON export of `BrowseResult` (steps + model outputs + screenshots) to `--save-transcript` — no DB changes for v1 (stretch: persist browsed steps as a replayable test via `store.saveTest`).
3. `index.ts`: export `LiveAgent`, `ActionRegistry`, `DomSnapshot`, `browseMain`.

**Tests**: `cli.test.ts` additions for `browse` flag parsing/validation.

## Phase 5 — Stretch (not in first delivery)
- api-server route + BrowserAgent-style UI for live browse.
- Auto-record: after a successful browse, save the performed action sequence as a replayable test (dry-run gate reuse).
- Cross-origin iframes, paint-order filtering, shadow-DOM in the serializer.

---

## Verification
- New tests all green; existing suite stays green (232 passed / 1 skipped, typecheck clean).
- Real-Chrome integration test covers: JS-listener clickable, viewport filtering, multi-action batch, page-change mid-batch break, `done` with final text, loop-detector nudge, no orphan Chrome processes.

## Key risks / decisions
- **json_schema + tool_calls together**: drive the agent with `json_schema` structured output (browser-use style); use native tool-calling only where the provider profiles cleanly, keeping the action parse path identical to what's testable.
- **Selector-map refs** reuse the recorder's `data-testid → id → structural` strategy so recorded-heal logic and live browsing stay consistent.
- **Message size**: compaction defaults mirror browser-use (40k chars / 25 steps), configurable via env.

## Reference (vendored browser-use source)
- `artifacts/browser-use/browser_use/agent/service.py` — step loop, multi_act, loop detector
- `artifacts/browser-use/browser_use/agent/message_manager/service.py` — state message, compaction
- `artifacts/browser-use/browser_use/tools/service.py` — built-in actions
- `artifacts/browser-use/browser_use/tools/registry/{views,service}.py` — registry + prompt descriptions
- `artifacts/browser-use/browser_use/dom/{service.py,serializer/serializer.py,serializer/clickable_elements.py}` — DOM pipeline
- `artifacts/browser-use/browser_use/agent/system_prompts/system_prompt.md` — prompt structure

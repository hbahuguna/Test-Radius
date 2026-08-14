# PLAN: Shadow CDP Recorder — browser-use as agent, our engine as recorder

## Objective

Use the Python **browser-use** service as the LLM-driven agent for the QueryFirst
"record" flow (better browsing), while a **shadow CDP recorder** in the Node
api-server passively captures `RecordedStep` metadata (locators, fingerprints,
page signatures, wait conditions) from the same Chrome instance via a second CDP
connection. The existing `ReplayRunner` (self-healing, dry-run gate, DataStore,
version snapshots) stays 100% unchanged.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  api-server (Node)                                           │
│                                                              │
│  POST /queryfirst/record  (rewritten)                        │
│    ├─ browser-use-client.ts → POST /run to Python service    │
│    │   ↓ returns { run_id }                                  │
│    ├─ GET /run/{run_id}/stream  (SSE from Python)             │
│    │   ↓ each "step" event:                                  │
│    │     { action_trace: [{ action, raw, element }] }        │
│    │                                                          │
│    ├─ ShadowRecorder (new)                                    │
│    │   ├─ connect CdpClient to browser-use's Chrome          │
│    │   │   (HTTP /json/version → webSocketDebuggerUrl → ws)  │
│    │   ├─ for each SSE step event:                           │
│    │   │   ├─ parse action_trace → know action + element      │
│    │   │   ├─ via CDP: pageSignatureBefore/After              │
│    │   │   ├─ via CDP: captureElementInfo → locators           │
│    │   │   ├─ via CDP: fingerprint                             │
│    │   │   ├─ derive waitCondition (URL/ref/sig diff)          │
│    │   │   └─ push RecordedStep to internal list              │
│    │   └─ on "done" event:                                    │
│    │       ├─ save RecordedSteps to DataStore                  │
│    │       └─ run dry-run gate (ReplayRunner, unchanged)      │
│    │                                                          │
│    └─ relay SSE events to frontend (existing pattern)        │
│                                                              │
│  POST /queryfirst/replay  (unchanged)                        │
│    → ReplayRunner.runTest (self-healing, version snapshots)   │
└──────────────────────────────────────────────────────────────┘
         │                          │
         ↓ HTTP                      ↓ CDP WebSocket (2nd connection)
┌────────────────┐    ┌──────────────────────────────────────┐
│ browser-use     │    │ Chrome (launched by browser-use)     │
│ (Python)        │    │  --remote-debugging-port=<random>    │
│ server.py       │───→│  browser-use CDP session (cdp_use)   │
│ Agent.run()     │    │  shadow recorder CDP session (ws)     │
└────────────────┘    └──────────────────────────────────────┘
```

## How the two sources combine per step

| RecordedStep field | Source: SSE action_trace | Source: CDP (shadow) |
|---|---|---|
| `action` | `action_trace[i].action` → map to our `StepAction` | — |
| `value` | `action_trace[i].raw` (url / text / value) | — |
| `selector` | build from `element.xpath` or `element.attributes` | — |
| `locators[]` | from `element.attributes` (data-testid, id) + `element.xpath` + `element.ax_name` (text=) | optionally re-derive via `captureElementInfo` for consistency |
| `elementFingerprint` | — | `page.evaluate(captureElementInfo)` → `page.fingerprint(selector)` |
| `pageSignatureBefore` | — | captured at previous step boundary |
| `pageSignatureAfter` | — | captured 250ms after SSE step event |
| `waitCondition` | — | URL diff / ref diff / signature diff (same `clickWaitCondition` logic) |
| `assertion` | — | `null` (browser-use doesn't assert) |

## Action mapping (browser-use → RecordedStep)

| browser-use action class | Our `StepAction` | Notes |
|---|---|---|
| `ClickElementAction` | `click` | `raw.index` → element |
| `InputElementAction` | `fill` | `raw.index` → element, `raw.text` → value (but redacted as `{{TEST_VALUE}}` in SSE — see Phase 1 caveat) |
| `NavigateToAction` | `navigate` | `raw.url` → value |
| `ScrollDownAction` / `ScrollUpAction` | `scroll` | may not have an element |
| `SelectDropdownOptionAction` | `select` | `raw.index` → element, `raw.value` → value |
| `DoneAction` | — | signals end of recording |
| `SendKeysAction` | `fill` | `raw.index` → element, `raw.text` → value |
| `GoBackAction` | `navigate` | navigate to `about:blank`? Actually maps to `go_back` (no current StepAction — see alternatives in Phase 1) |

## Files touched

```
artifacts/
  api-server/src/
    lib/
      browser-use-recorder.ts    ← NEW (~250 lines): ShadowRecorder class
      browser-use-client.ts      ← MINOR: export streamAgentEvents for reuse
      browser-use-cdp.ts          ← NEW (~60 lines): resolve Chrome wsUrl from HTTP /json/version
    routes/
      queryfirst.ts               ← MODIFY: rewrite /record endpoint to use browser-use + shadow recorder
  nlp-runner/src/
    index.ts                      ← EXPORT: CdpClient, connect (already exported)
    recorder/dom.ts               ← NO CHANGE (functions reused via Page.evaluate)
    recorder/recorder.ts          ← NO CHANGE (RecordedStep type reused)
    replay/engine.ts              ← NO CHANGE (ReplayRunner unchanged)
  browser-use/
    server.py                     ← PHASE 2: add /run/{run_id}/cdp-url endpoint (~15 lines, optional in Phase 1)
    start.sh                      ← NO CHANGE
```

---

## Phase 1 — Shadow CDP Recorder core (no Python changes)

**Priority: HIGH | Risk: MEDIUM | Effort: ~1 day**

### 1.1 `browser-use-cdp.ts` — resolve Chrome's WebSocket URL

browser-use launches Chrome with `--remote-debugging-port=<random>`. The HTTP
endpoint `http://127.0.0.1:<port>/json/version` returns
`{ webSocketDebuggerUrl: "ws://127.0.0.1:<port>/devtools/browser/<id>" }`.

But we don't know the port. Two approaches (implement both, prefer A):

**Approach A — discover via SSE step events (zero Python changes):**
The SSE `step` events include `screenshot`, `url`, `title` — but not the CDP
port. However, the browser-use `Browser` object is stored in
`state.browsers[run_id]` (server.py:490), and `browser.cdp_url` (session.py:492)
returns the HTTP CDP URL. We can get this from a new Python endpoint (Phase 2)
or by polling `http://127.0.0.1:<port>/json/version` across a port range
(brittle).

**Approach B — pass the CDP URL from browser-use (requires Python, Phase 2):**
Add a `cdp_url` field to the `RunResponse` or a new `GET /run/{run_id}/cdp-url`
endpoint. ~15 lines of Python.

**Phase 1 approach:** Since we need the CDP URL before the first step event
arrives, and we can't modify Python in Phase 1, we'll use a **fixed debug port**.
The api-server `/record` endpoint will pass `BROWSER_USE_CDP_URL` as an env var
or set `cdp_url` in the RunRequest (see 1.2). browser-use's `BrowserProfile`
already supports `cdp_url` (profile.py:598) — but it uses it to *connect* to an
existing browser, not to *launch* one.

**Revised Phase 1 approach:** The simplest path is to **launch our own Chrome**
and pass its debug port to browser-use via `cdp_url`. This way:
- browser-use connects to our Chrome (it supports `cdp_url` in BrowserProfile)
- We already have the CDP WebSocket URL
- No Python changes needed

Wait — browser-use's `server.py` doesn't accept `cdp_url` in `RunRequest`.
Adding it is a trivial Python change (Phase 2). For Phase 1, we'll do the
reverse: **launch Chrome ourselves, connect browser-use to it via a new
`cdp_url` field in RunRequest**.

Actually, the cleanest Phase 1 approach that requires **no Python changes at
all**: connect to browser-use's Chrome by scanning for its debug port. Chrome
writes the port to a file in the user-data-dir. But we don't know the
user-data-dir either.

**Final Phase 1 approach:** Add `cdp_url` to `RunRequest` in Python. This is
~3 lines in `server.py`. We'll do this as a minimal Python change in Phase 1
since it's unavoidable for the architecture to work.

- [x] **1.1a** Add `cdp_url: Optional[str] = Field(default=None)` to `RunRequest` (server.py:83-92)
- [x] **1.1b** In `run_agent_task` (server.py:482-489), if `request.cdp_url` is set, pass it to `BrowserProfile(cdp_url=...)` instead of launching a new browser
- [x] **1.1c** Create `browser-use-cdp.ts` with `resolveWsUrl(httpCdpUrl: string): Promise<string>` — fetches `<httpCdpUrl>/json/version`, parses `webSocketDebuggerUrl`, returns the `ws://` URL

### 1.2 `browser-use-recorder.ts` — the ShadowRecorder class

~250 lines. The core class:

```typescript
export class ShadowRecorder {
  private session: BrowserSession;  // our CDP connection to the same Chrome
  private page: Page | null = null;  // attached to browser-use's tab
  private steps: RecordedStep[] = [];
  private slots: RecordedSlot[] = [];
  private lastSignature: string | null = null;
  private lastUrl: string | null = null;
  private lastRefs: string[] | null = null;

  static async connect(cdpHttpUrl: string): Promise<ShadowRecorder> {
    const wsUrl = await resolveWsUrl(cdpHttpUrl);
    const client = await connect(wsUrl);
    // Create a BrowserSession from an existing CDP connection
    const session = BrowserSession.fromCdpClient(client);
    return new ShadowRecorder(session);
  }

  /** Called when the first SSE "loading" or "step" event arrives.
   * Attaches to the page browser-use created. */
  async attachToPage(): Promise<void> {
    const pages = await this.session.pages();
    // Find browser-use's page (the one with the target URL, not about:blank)
    const target = pages.find(p => p.type === "page") ?? pages[0];
    if (target) {
      this.page = await this.session.attachPage(target.targetId);
      // wait for the page to have a real URL
      await this.page.navigate("").catch(() => {}); // no-op, just to init
    }
  }

  /** Called BEFORE browser-use executes each step.
   * Captures the "before" state. */
  async beforeStep(): Promise<void> {
    if (!this.page) return;
    this.lastUrl = await this.page.getUrl().catch(() => "");
    this.lastSignature = await this.page.pageSignature().catch(() => "");
    this.lastRefs = await this.page.evaluate(collectVisibleRefs).catch(() => []);
  }

  /** Called AFTER browser-use's SSE step event arrives.
   * Captures the "after" state + builds the RecordedStep. */
  async afterStep(actionTrace: ActionTraceEntry[]): Promise<void> {
    if (!this.page) return;

    // Wait for the page to settle (same as Recorder's settleMs=250)
    await new Promise(r => setTimeout(r, 250));

    const urlAfter = await this.page.getUrl().catch(() => this.lastUrl ?? "");
    const sigAfter = await this.page.pageSignature().catch(() => "");
    const refsAfter = await this.page.evaluate(collectVisibleRefs).catch(() => []);

    for (const entry of actionTrace) {
      const step = this.buildRecordedStep(entry, urlAfter, sigAfter, refsAfter);
      this.steps.push(step);
    }
  }

  private buildRecordedStep(
    entry: ActionTraceEntry,
    urlAfter: string,
    sigAfter: string,
    refsAfter: string[],
  ): RecordedStep {
    const action = mapAction(entry.action);
    const element = entry.element as DOMInteractedElement | null;

    // Build selector + locators from the SSE element data
    const { selector, locators } = buildLocators(element);

    // Build waitCondition (same logic as Recorder.clickWaitCondition)
    const waitCondition = deriveWaitCondition(
      this.lastUrl, urlAfter, this.lastRefs, refsAfter,
      this.lastSignature, sigAfter,
    );

    // Compute fingerprint via CDP (run captureElementInfo in-page)
    // Done lazily — only for elements that have a selector
    // (fingerprint is computed synchronously here but the CDP call
    // happens in buildRecordedStepAsync — see implementation)
    return {
      action,
      selector,
      value: extractValue(entry),
      locators,
      elementFingerprint: null, // set in buildRecordedStepAsync
      pageSignatureBefore: this.lastSignature,
      pageSignatureAfter: sigAfter,
      waitCondition,
      assertion: null,
    };
  }

  /** Finish: compute fingerprints for all steps, detect slots, return. */
  async finalize(): Promise<{ steps: RecordedStep[]; slots: RecordedSlot[] }> {
    // Compute fingerprints for steps that have selectors
    for (const step of this.steps) {
      if (step.selector && this.page) {
        try {
          step.elementFingerprint = await this.page.fingerprint(step.selector);
        } catch { /* element may have navigated away */ }
      }
    }
    // Detect slots from fill steps (same as Recorder.detectSlot)
    // ... (reuse slot detection logic)
    return { steps: this.steps, slots: this.slots };
  }

  async close(): Promise<void> {
    // Don't close the browser — browser-use owns it.
    // Just close our CDP connection.
    this.session.client.close();
  }
}
```

Key sub-functions:

**`mapAction(actionName: string): StepAction`** — maps browser-use class names:
```
ClickElementAction → "click"
InputElementAction → "fill"
NavigateToAction → "navigate"
ScrollDownAction → "scroll"
ScrollUpAction → "scroll"
SelectDropdownOptionAction → "select"
SendKeysAction → "fill"
GoBackAction → "navigate" (url = special "go_back" marker — see alternatives)
```

**`buildLocators(element: DOMInteractedElement | null): { selector, locators }`**
- If element is null (e.g. navigate action): `{ selector: null, locators: [] }`
- If `element.attributes["data-testid"]`: `[{data-testid="..."}, ...]`
- If `element.attributes["id"]`: add `#id`
- Always add `element.x_path` as a fallback locator
- If `element.ax_name`: add `text="ax_name"` for button/a/summary
- `selector` = first locator (data-testid > id > xpath)

**`deriveWaitCondition(urlBefore, urlAfter, refsBefore, refsAfter, sigBefore, sigAfter): WaitCondition | null`**
- If URL changed: `{ kind: "url", contains: urlAfter.replace(/\/+$/, "") }`
- Else if a new ref appeared: `{ kind: "element", ref: newRef }`
- Else: `{ kind: "signature", hash: sigAfter, before: sigBefore }`
- Return `null` for non-page-changing actions (fill, scroll before submit)

**`extractValue(entry: ActionTraceEntry): string | null`**
- NavigateToAction: `entry.raw.url`
- InputElementAction: `entry.raw.text` (NOTE: browser-use redacts this as `"{{TEST_VALUE}}"` in server.py:380-384 — see caveat below)
- SelectDropdownOptionAction: `entry.raw.value`
- ClickElementAction: `null`
- ScrollAction: `null`

> **Caveat — input value redaction:** `server.py:380-384` redacts `text`/`value`/`input` fields in `InputElementAction` as `"{{TEST_VALUE}}"`. This means the recorded step won't capture the actual text typed. **Fix options:**
> 1. Disable redaction for recording runs (add a `redact_values: bool = True` field to `RunRequest`, default True, set False for recording)
> 2. Have the api-server pass `extra_context` with the values to use as slot defaults
> 3. Accept `{{TEST_VALUE}}` as a slot placeholder and let the user provide values at replay time
>
> Phase 1 uses option 3 (accept redaction); Phase 2 adds option 1 for better UX.

- [x] **1.2a** Implement `ShadowRecorder` class with `connect`, `attachToPage`, `beforeStep`, `afterStep`, `finalize`, `close`
- [x] **1.2b** Implement `mapAction`, `buildLocators`, `deriveWaitCondition`, `extractValue` helpers
- [x] **1.2c** Implement slot detection in `finalize` (reuse `detectSlot` logic from `recorder.ts:182-185`)
- [x] **1.2d** Unit tests with mocked CDP client + mocked SSE events

### 1.3 `BrowserSession.fromCdpClient` — connect to an existing Chrome

Add a static factory to `BrowserSession` that wraps an existing `CdpClient`
without spawning Chrome:

```typescript
static fromCdpClient(
  client: CdpClient,
  viewportWidth = 1280,
  viewportHeight = 720,
): BrowserSession {
  // Create a minimal LaunchedBrowser stub so close() is a no-op
  const fakeBrowser: LaunchedBrowser = {
    wsUrl: "", pid: 0, port: 0, headless: true,
    close: async () => {},
  };
  return new BrowserSession(fakeBrowser, client, viewportWidth, viewportHeight);
}
```

- [x] **1.3a** Add `BrowserSession.fromCdpClient` to `session.ts`
- [x] **1.3b** Export it from `index.ts`

### 1.4 Rewrite `/record` endpoint in `queryfirst.ts`

The new flow:
1. Launch our own Chrome (headless) via `BrowserSession.launch`
2. Get the CDP WebSocket URL
3. POST to browser-use `/run` with the `cdp_url` set to our Chrome's debug port
4. Start SSE stream from browser-use
5. While streaming, run `ShadowRecorder` to capture `RecordedStep[]`
6. On `done` event: finalize recorder, save to DataStore, run dry-run gate
7. Close our Chrome

```typescript
router.post("/record", async (req, res) => {
  const { query, entry_url, variables } = req.body;
  const llmCfg = await resolveLlmConfig(authUser, req.body);

  // 1. Launch our Chrome
  const ourChrome = await BrowserSession.launch({ headless: true, timeoutMs: 30_000 });
  const cdpHttpUrl = `http://127.0.0.1:${ourChrome.browser.port}`;

  // 2. Connect shadow recorder to the same Chrome
  const recorder = await ShadowRecorder.connect(cdpHttpUrl);

  // 3. Start browser-use run, pointing at our Chrome
  const runResponse = await fetch(`${BROWSER_USE_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
    body: JSON.stringify({
      url: entry_url ?? "about:blank",
      goal: query,
      model_id: llmCfg.model,
      max_steps: 50,
      cdp_url: cdpHttpUrl,  // NEW field (Phase 1.1)
      poolside_api_key: llmCfg.apiKey,
      model_provider: providerToUse(llmCfg),
    }),
  });
  const { run_id } = await runResponse.json();

  // 4. Stream SSE from browser-use + capture steps
  sseHeaders(res);
  sseWrite(res, { event: "started", kind: "record" });

  const stream = await fetch(`${BROWSER_USE_URL}/run/${run_id}/stream`, {
    headers: { "X-Internal-Secret": SECRET },
  });
  const reader = stream.body!.getReader();

  let lastWasStep = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // parse SSE lines...
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const event = JSON.parse(line.slice(6));
        // Relay to frontend
        sseWrite(res, { event: "record", ...translateEvent(event) });

        if (event.event === "loading" || event.event === "step") {
          if (lastWasStep) await recorder.beforeStep();
          if (event.event === "step") {
            await recorder.afterStep(event.action_trace ?? []);
          }
          lastWasStep = event.event === "step";
        }

        if (event.event === "done") {
          // 5. Finalize + save
          const { steps, slots } = await recorder.finalize();
          const saved = store.saveTest({
            name: query.slice(0, 80),
            source: "recorder",
            entryUrl: entry_url,
            query,
            steps: steps.map(toNewStep),
            slots,
          });

          // 6. Dry-run gate (unchanged)
          const testWithSteps = store.getTestWithSteps(saved.id);
          const gateSession = await BrowserSession.launch({ headless: true });
          const gatePage = await gateSession.newPage();
          const runner = new ReplayRunner(gatePage);
          const result = await runner.runTest(store, testWithSteps, {
            variables: variables ?? {},
            timeoutMs: 30_000,
          });

          sseWrite(res, {
            event: "done",
            ok: result.success,
            testId: result.success ? saved.id : undefined,
            error: result.success ? undefined : result.error,
          });

          await gateSession.close();
        }
      }
    }
  }

  // 7. Cleanup
  await recorder.close();
  await ourChrome.close();
  res.end();
});
```

> **Why launch our own Chrome:** browser-use's `BrowserProfile` accepts
> `cdp_url` — if set, browser-use connects to an existing Chrome instead of
> launching its own. This gives us the debug port. The alternative (let
> browser-use launch Chrome, then discover the port) requires either a Python
> endpoint or port scanning.

- [x] **1.4a** Implement the rewritten `/record` endpoint
- [x] **1.4b** Implement event translation (browser-use SSE → QfEvent format)
- [x] **1.4c** Implement `toNewStep` converter (RecordedStep → NewStep for DataStore)
- [x] **1.4d** Keep the existing `/screenshot`, `/stop`, `/replay` endpoints working unchanged

### 1.5 Frontend — `QueryFirstDemo.tsx` updates

The SSE event format changes slightly (browser-use sends `step` events with
different field names than our current `RecordAgentEvent`). The frontend needs
to handle the new event shapes:

- `event: "started"` — unchanged
- `event: "record"` — new sub-types:
  - `{ type: "plan", turn, thinking, next_goal, actions }` (from browser-use `step` event's `model_output`)
  - `{ type: "step", turn, stepIndex, action, ok }` (from browser-use `action_trace`)
  - `{ type: "guard" }` (browser-use doesn't emit guard events — skip)
- `event: "done"` — unchanged
- `event: "error"` — unchanged

The milestones feature doesn't exist in browser-use (the LLM doesn't plan
milestones). We'll either:
- Drop milestones from the UI during record mode
- Or derive pseudo-milestones from the done event's `action_trace` (post-hoc)

- [x] **1.5a** Update `QfEvent` type to handle browser-use event shapes
- [x] **1.5b** Update `handleEvent` in `QueryFirstDemo.tsx` to handle new `record` sub-types
- [x] **1.5c** Handle missing milestones gracefully (hide the card when no milestones)

---

## Phase 2 — Python enhancements for better recording fidelity

**Priority: MEDIUM | Risk: LOW | Effort: ~2 hours**

### 2.1 Disable input value redaction for recording

Add `redact_values: bool = Field(default=True)` to `RunRequest`. In
`format_action_trace` (server.py:380-384), skip the redaction when
`redact_values=False`.

```python
class RunRequest(BaseModel):
    # ... existing fields ...
    redact_values: bool = Field(default=True)
    cdp_url: Optional[str] = Field(default=None)
```

The api-server passes `redact_values: false` for recording runs so the shadow
recorder captures the actual typed text as slot defaults.

- [x] **2.1** Add `redact_values` field + conditional in `format_action_trace`

### 2.2 Expose CDP URL in RunResponse (alternative to 1.1)

Add `cdp_url: Optional[str] = None` to `RunResponse`. After the browser is
launched in `run_agent_task`, set it on the response. This allows the api-server
to discover the port without launching its own Chrome.

```python
# In run_agent_task, after browser is created (line 489):
state.runs[run_id]["cdp_url"] = browser.cdp_url
```

Add a new endpoint:
```python
@app.get("/run/{run_id}/cdp-url")
async def get_cdp_url(run_id: str, _: bool = Depends(verify_internal_secret)):
    if run_id not in state.runs:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"cdp_url": state.runs[run_id].get("cdp_url")}
```

- [x] **2.2** Add `GET /run/{run_id}/cdp-url` endpoint (~15 lines)
- [x] **2.2a** If using this approach, update Phase 1.4 to poll for the CDP URL instead of launching our own Chrome (simpler, avoids double Chrome)

### 2.3 Support `go_back` action in RecordedStep

browser-use's `GoBackAction` has no equivalent in our `StepAction` union. Options:
1. Add `"go_back"` to `StepAction` + handle in `ReplayRunner` (simplest —
   `page.send("Page.goBack")` or `history.back()`)
2. Map to `navigate` with the previous URL (captured by shadow recorder's
   `lastUrl`)

Option 1 is cleaner. If we go with Option 2, the shadow recorder knows the
previous URL from `beforeStep()`.

- [x] **2.3** Decide approach + implement (prefer Option 1: add `"go_back"` to StepAction)

---

## Phase 3 — Testing, polish, edge cases

**Priority: MEDIUM | Risk: LOW | Effort: ~3 hours**

### 3.1 Integration test

A full end-to-end test:
1. Start a local fixture server (reuse existing `signup.html` / `dynamic.html`)
2. Launch the browser-use Python service
3. Call the new `/record` endpoint with a simple task
4. Verify: steps are recorded, dry-run passes, test is saved to DataStore
5. Call `/replay` on the saved test → verify it passes

- [x] **3.1** Write integration test (may need to be CI-only due to Python dependency)

### 3.2 Race condition testing

The shadow recorder's `afterStep` runs 250ms after the SSE event. If
browser-use's next action starts before the recorder finishes, we could miss
capturing the "before" state for the next step.

Mitigation: browser-use emits step events sequentially (step N completes before
step N+1 begins). The SSE stream is a single queue, so events are ordered. But
the shadow recorder's CDP calls are async — we need to ensure `beforeStep` for
step N+1 waits until `afterStep` for step N completes.

Implementation: use a simple promise chain — `afterStep` returns a promise;
`beforeStep` is only called after the previous `afterStep` resolves.

- [x] **3.2** Add sequencing guard (promise chain) to prevent overlapping steps
- [x] **3.2a** Add timeout: if `afterStep` takes >5s, proceed without the metadata

### 3.3 Error handling

- browser-use agent fails (SSE `error` event) → save partial steps? No — delete the test if no steps recorded, or save with a "failed" marker
- Shadow recorder can't connect to Chrome → fall back to no-recording mode (just relay SSE to frontend, skip dry-run)
- Dry-run fails → same as current: delete test, return error to frontend

- [x] **3.3** Implement error handling for all failure modes

### 3.4 Screenshot polling

The existing `/screenshot` endpoint polls `active.page`. In the new flow,
`active.session` is our Chrome, but the `Page` object should be the shadow
recorder's page (attached to browser-use's tab).

- [x] **3.4** Ensure `active.page` is set to the shadow recorder's page for screenshot polling

---

## Phase 4 — Fallback path (stretch)

**Priority: LOW | Risk: LOW | Effort: ~2 hours**

If browser-use is unavailable, or the CDP connection fails, fall back to the
existing `RecordAgent` (our TypeScript LLM planner) as the recording engine.
This preserves backward compatibility.

- [x] **4.1** Add `QF_RECORD_ENGINE` env var: `"browser-use"` (default) | `"native"` (existing planner)
- [x] **4.2** If `browser-use` is set but the Python service is down, auto-fallback to `"native"` with a warning log

---

## Dependency graph

```
1.1a (Python: cdp_url in RunRequest)
  ↓
1.1b (Python: BrowserProfile uses cdp_url)
  ↓  ← OR: 1.3a (BrowserSession.fromCdpClient) + our own Chrome launch
1.1c (browser-use-cdp.ts: resolveWsUrl)
  ↓
1.2a-d (ShadowRecorder)   1.3a-b (BrowserSession.fromCdpClient)
  ↓                          ↓
1.4a-d (rewrite /record)  ────┘
  ↓
1.5a-c (frontend updates)
  ↓
2.1-2.3 (Python enhancements)
  ↓
3.1-3.4 (testing + polish)
  ↓
4.1-4.2 (fallback, stretch)
```

## Key design decisions

1. **We launch Chrome, not browser-use** — browser-use connects to our Chrome
   via `cdp_url`. This gives us the debug port without Python changes. (Phase 2
   removes this need by exposing the CDP URL from Python.)

2. **Shadow recorder uses our CDP client, not browser-use's** — a second CDP
   WebSocket connection to the same Chrome. CDP supports multiple connections.
   We never interfere with browser-use's actions.

3. **SSE stream is the timing source** — each browser-use "step" event tells us
   "browser-use just did something." We capture before/after state around that
   event. No polling, no guessing.

4. **Replay engine is untouched** — the `ReplayRunner`, `DataStore`, self-healing,
   version snapshots, and dry-run gate all work on `RecordedStep` objects. The
   shadow recorder produces those objects. The replay engine doesn't know or
   care that browser-use was the agent.

5. **Input values are redacted by default** — browser-use replaces typed text
   with `"{{TEST_VALUE}}"`. In Phase 1 this becomes a slot placeholder (the user
   provides real values at replay time). In Phase 2 we disable redaction for
   recording runs.

6. **No milestones in Phase 1** — browser-use doesn't plan milestones. The
   milestone card in the frontend is hidden during record mode.
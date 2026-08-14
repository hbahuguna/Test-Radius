/**
 * Shadow CDP Recorder — bridges browser-use (Python) agent steps with our
 * QueryFirst recording format.
 *
 * Browser-use drives Chrome via CDP (cdp_use). We connect a SECOND CDP client
 * to the same Chrome instance and passively capture recording metadata
 * (RecordedStep + RecordedSlot) that our ReplayRunner needs for self-healing
 * dry-run / playback.
 *
 * The recorder listens to browser-use's SSE step events (which tell us WHAT
 * action was taken and on WHICH element), then independently queries the page
 * via our CDP connection (to capture pageSignature, locators, fingerprint,
 * waitCondition).
 */
import { resolveWsUrl } from "./browser-use-cdp.js";
import {
  connect,
  type CdpClient,
  BrowserSession,
  type Page,
  captureDomSnapshot,
  collectDomSnippet,
  formatDom,
  type DomEntry,
  type RecordedStep,
  type RecordedSlot,
  detectSlot,
  detectSlotKind,
  type StepAction,
  type WaitCondition,
  type NewStep,
  hashSteps,
} from "@workspace/nlp-runner";

export interface BrowserUseElement {
  node_name?: string;
  attributes?: Record<string, string | null>;
  x_path?: string;
  ax_name?: string;
  element_hash?: number;
  stable_hash?: number | null;
  bounds?: { x: number; y: number; width: number; height: number } | null;
}

export interface BrowserUseActionTraceEntry {
  action: string;
  raw: unknown;
  element: BrowserUseElement | null;
}

export interface BrowserUseStepEvent {
  event: "step";
  step_number: number;
  url: string | null;
  title: string | null;
  action_trace: BrowserUseActionTraceEntry[];
}

const SETTLE_MS = 250;
const CDP_ATTACH_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** CSS.escape polyfill for Node (not available outside browsers). */
function cssEscape(value: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.CSS !== "undefined" && typeof g.CSS.escape === "function") {
    return g.CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&").replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/**
 * Detect whether a recorded element is a consent/cookie banner or modal
 * overlay that only appears under certain browser-state conditions (e.g. first
 * visit, cookies not yet granted). Such steps should be marked optional so
 * replay skips them gracefully when the element is absent rather than failing.
 *
 * We check the accessible name (ax_name) and aria-label attribute because
 * these reflect the visible label most reliably across cookie-banner vendors.
 */
function isConsentElement(element: BrowserUseElement | null, axName: string | null): boolean {
  const text = [
    axName,
    element?.attributes?.["aria-label"],
    element?.ax_name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  // Match specific consent/cookie/privacy keywords. "allow" and "accept" alone
  // are too broad; require them paired with a consent context word.
  return /\bcookie\b|\bconsent\b|\bgdpr\b|\baccept\s+all\b|\ballow\s+all\b|\breject\s+all\b|\bdismiss\s+cookie\b|\bcookie\s+banner\b|\bprivacy\s+settings\b/.test(text);
}

/**
 * Maps a browser-use action class name to our StepAction.
 */
function mapAction(actionName: string): StepAction | null {
  const lower = actionName.toLowerCase();
  if (lower.includes("click")) return "click";
  if (lower.includes("input") || lower.includes("sendkeys") || lower.includes("keys") || lower.includes("type")) return "fill";
  if (lower.includes("navigate")) return "navigate";
  if (lower.includes("select")) return "select";
  if (lower.includes("scroll")) return "scroll";
  if (lower.includes("wait")) return "wait";
  if (lower.includes("go_back") || lower.includes("goback")) return "go_back";
  return null;
}

/**
 * Build a CSS selector + locator list from browser-use's element data.
 * Mirrors the prioritization in recorder/dom.ts captureElementInfo.
 */
function buildLocators(element: BrowserUseElement | null): {
  selector: string | null;
  locators: string[];
} {
  if (!element) return { selector: null, locators: [] };

  const attrs = element.attributes ?? {};
  const locators: string[] = [];

  // data-testid
  const testid = attrs["data-testid"];
  if (testid) {
    locators.push(`[data-testid="${cssEscape(testid)}"]`);
  }
  // id
  const id = attrs["id"];
  if (id) {
    locators.push(`#${cssEscape(id)}`);
  }
  // x_path
  const xpath = element.x_path;
  if (xpath) {
    // Convert xpath to a CSS selector approximation for our replay engine
    const css = xpathToCss(xpath);
    if (css) locators.push(css);
  }
  // text= — used for any interactive element that has a visible label.
  // Kept broad so tabs, menu items, list items, and role-based elements are
  // captured with a stable text locator alongside any CSS/XPath fallbacks.
  const axName = element.ax_name;
  const tag = (element.node_name ?? "").toLowerCase();
  const role = (attrs["role"] ?? "").toLowerCase();
  const TEXT_TAGS = new Set(["button", "a", "summary", "li", "option", "label", "span", "div", "input", "select", "textarea"]);
  const TEXT_ROLES = new Set(["button", "link", "tab", "menuitem", "option", "checkbox", "radio"]);
  if (axName && (TEXT_TAGS.has(tag) || TEXT_ROLES.has(role))) {
    locators.push(`text="${axName.slice(0, 80)}"`);
  }

  const selector = locators.length > 0 ? locators[0] : null;
  return { selector, locators: locators.length > 0 ? locators : [] };
}

/**
 * Convert a simple XPath like `//button[@data-testid='foo']` or
 * `//div[@class='bar']/a[2]` to a CSS selector. Returns null if it can't
 * parse (caller falls back to xpath as-is in elementFingerprint).
 */
function xpathToCss(xpath: string): string | null {
  // Strip leading slashes
  let s = xpath.replace(/^\/+/, "");

  // Split on / and process each step
  const steps = s.split("/");
  const cssSteps: string[] = [];
  for (const step of steps) {
    if (!step) continue;

    // Match: tagname[N] or tagname[@attr='value']
    const m = step.match(/^([a-zA-Z0-9-*]+)?(?:\[([^\]]+)\])?$/);
    if (!m) return null;

    const [, tag, predicate] = m;
    let css = tag || "*";

    if (predicate) {
      if (predicate.startsWith("@")) {
        // [@attr='val'] or [@attr="val"]
        const attrMatch = predicate.match(/@([a-zA-Z-]+)=['"]([^'"]*)['"]/);
        if (attrMatch) {
          const attrName = attrMatch[1];
          const attrVal = attrMatch[2];
          css += `[${attrName}="${cssEscape(attrVal)}"]`;
        }
      } else if (/^\d+$/.test(predicate)) {
        // [N] in XPath is 1-indexed. In CSS, we map this to :nth-of-type(N)
        const n = parseInt(predicate, 10);
        css = `${css}:nth-of-type(${n})`;
      }
    }

    cssSteps.push(css);
  }

  return cssSteps.join(" > ");
}

/**
 * Extract the value/URL from a browser-use action trace entry.
 * browser-use 2.x nests params under the action name, e.g.
 * {"navigate": {"url": "..."}} or {"input": {"text": "...", "index": 1}}.
 */
function extractValue(entry: BrowserUseActionTraceEntry): string | null {
  const raw = entry.raw;
  if (typeof raw !== "object" || raw === null) return null;
  const rawObj = raw as Record<string, unknown>;

  const firstKey = Object.keys(rawObj)[0] as string | undefined;
  const params =
    firstKey && typeof rawObj[firstKey] === "object" && rawObj[firstKey] !== null
      ? (rawObj[firstKey] as Record<string, unknown>)
      : rawObj;

  // Navigate: { url: "..." }
  if ("url" in params) return params["url"] as string | null;

  // Input/fill: { text: "...", index: N }
  if ("text" in params) return params["text"] as string | null;

  // Select: { index: N, value: "..." }
  if ("value" in params) return params["value"] as string | null;

  return null;
}

/**
 * Derive a wait condition from before/after snapshots.
 * Mirrors Recorder.clickWaitCondition (recorder.ts:385-407).
 */
function deriveWaitCondition(
  urlBefore: string,
  urlAfter: string,
  refsBefore: string[],
  refsAfter: string[],
  sigBefore: string,
  sigAfter: string,
): WaitCondition | null {
  // Tier 1: URL changed → wait for the new URL
  if (urlAfter !== urlBefore) {
    return {
      kind: "url",
      contains: urlAfter.replace(/\/+$/, ""),
      desc: `url contains "${urlAfter}"`,
    };
  }

  // Tier 2: a new visible ref appeared (element became visible)
  const before = new Set(Array.isArray(refsBefore) ? refsBefore : []);
  const newRef = (Array.isArray(refsAfter) ? refsAfter : []).find(
    (ref) => !before.has(ref),
  );
  if (newRef) {
    return {
      kind: "element",
      ref: newRef,
      desc: `"${newRef}" visible`,
    };
  }

  // Tier 3: signature changed (non-URL, non-ref change)
  if (sigAfter !== sigBefore) {
    return {
      kind: "signature",
      hash: sigAfter,
      before: sigBefore,
      desc: "page signature settles",
    };
  }

  return null;
}

/**
 * Collect visible refs from the current page (same as recorder's collectVisibleRefs).
 */
async function collectVisibleRefs(page: Page): Promise<string[]> {
  const all = await page.evaluate(() => {
    const refs: string[] = [];
    const nodes = document.querySelectorAll("[id],[data-testid]");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i] as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const testid = el.getAttribute("data-testid");
        refs.push(testid ? `[data-testid="${CSS.escape(testid)}"]` : `#${CSS.escape(el.id)}`);
      }
    }
    return refs;
  });
  return Array.isArray(all) ? all : [];
}

export interface ShadowRecorderResult {
  steps: RecordedStep[];
  slots: RecordedSlot[];
  stepHash: string;
  entryUrl: string;
}

export class ShadowRecorder {
  private session: BrowserSession;
  private page: Page | null = null;
  private steps: RecordedStep[] = [];
  private slots: RecordedSlot[] = [];

  private lastSignature: string | null = null;
  private lastUrl: string | null = null;
  private lastRefs: string[] | null = null;
  private entryUrl: string | null = null;

  /** Serializes before/afterStep to prevent race conditions. */
  private stepPromise: Promise<void> = Promise.resolve();

  private constructor(session: BrowserSession) {
    this.session = session;
  }

  getPage(): Page | null {
    return this.page;
  }

  /**
   * Connect to browser-use's Chrome instance via its HTTP CDP endpoint.
   * @param httpCdpUrl e.g. "http://127.0.0.1:9242"
   */
  static async connect(httpCdpUrl: string): Promise<ShadowRecorder> {
    const wsUrl = await resolveWsUrl(httpCdpUrl);
    const client = await connect(wsUrl);
    const session = BrowserSession.fromCdpClient(client);
    const recorder = new ShadowRecorder(session);
    return recorder;
  }

  /**
   * Attach to the page that browser-use is driving.
   * Called on the first SSE event.
   */
  async attachToPage(): Promise<void> {
    const deadline = Date.now() + CDP_ATTACH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const pages = await this.session.pages();
        const target = pages.find((p) => p.url !== "about:blank");
        if (target) {
          this.page = await this.session.attachPage(target.targetId);
          // Initialize before-state from the current page
          await this.captureBeforeState();
          // The URL where the recording began is the test's entry point, so
          // replay starts there instead of on the final page.
          this.entryUrl = this.lastUrl;
          return;
        }
      } catch {
        // retry
      }
      await sleep(200);
    }
    throw new Error("ShadowRecorder: no browser-use page found to attach to");
  }

  /** Capture the "before" state for the next step. Called before browser-use executes an action. */
  private async captureBeforeState(): Promise<void> {
    if (!this.page) return;
    try {
      const [url, sig, refs] = await Promise.all([
        this.page.getUrl().catch(() => ""),
        this.page.pageSignature().catch(() => ""),
        collectVisibleRefs(this.page).catch(() => []),
      ]);
      this.lastUrl = url;
      this.lastSignature = sig;
      this.lastRefs = refs;
    } catch {
      // ignore
    }
  }

  /** Capture the "after" state and build RecordedStep for each action. Called after browser-use's SSE step event. */
  private async captureAfterState(
    actionTrace: BrowserUseActionTraceEntry[],
  ): Promise<void> {
    if (!this.page) return;

    // Wait for the page to settle (same as Recorder's settleMs=250)
    await sleep(SETTLE_MS);

    const [urlAfter, sigAfter, refsAfter] = await Promise.all([
      this.page.getUrl().catch(() => this.lastUrl ?? ""),
      this.page.pageSignature().catch(() => this.lastSignature ?? ""),
      collectVisibleRefs(this.page).catch(() => this.lastRefs ?? []),
    ]);

    for (const entry of actionTrace) {
      const step = await this.buildRecordedStep(
        entry,
        urlAfter,
        sigAfter,
        refsAfter,
      );
      if (step) this.steps.push(step);
    }
  }

  private async buildRecordedStep(
    entry: BrowserUseActionTraceEntry,
    urlAfter: string,
    sigAfter: string,
    refsAfter: string[],
  ): Promise<RecordedStep | null> {
    if (!this.page) return null;

    const stepAction = mapAction(entry.action);

    // GoBackAction → map to go_back action
    if (stepAction === null) return null;

    const { selector, locators } = buildLocators(entry.element);

    // A navigation between the before/after snapshots means the element that
    // was interacted with is gone — its selector often still matches a DIFFERENT
    // element on the new page (e.g. a sticky nav link), so fingerprinting the
    // post-navigation element would record a wrong baseline and cause a spurious
    // self-heal on replay. Skip it and leave elementFingerprint null.
    const urlChanged = this.lastUrl !== null && urlAfter !== this.lastUrl;

    // Compute fingerprint via CDP if we have a selector
    let fingerprint: string | null = null;
    if (selector && !urlChanged) {
      try {
        fingerprint = await this.page.fingerprint(selector).catch(() => null);
      } catch {
        // element may have navigated away
      }
    }

    const waitCondition = deriveWaitCondition(
      this.lastUrl ?? "",
      urlAfter,
      this.lastRefs ?? [],
      refsAfter,
      this.lastSignature ?? "",
      sigAfter,
    );

    const value = extractValue(entry);

    // Slot detection (same as Recorder.fill)
    if (stepAction === "fill" && value) {
      const slot = detectSlot(value);
      if (slot) {
        this.slots.push({
          name: slot.name,
          kind: slot.kind,
          defaultValue: value,
        });
      }
    }

    // Auto-detect optional steps: cookie/consent banners and overlays only
    // appear under certain browser-state conditions (first visit, no stored
    // consent cookie). Mark them optional so replay skips gracefully when the
    // element is absent instead of failing the whole test.
    const optional = isConsentElement(entry.element, entry.element?.ax_name ?? null);

    return {
      action: stepAction,
      selector,
      value,
      locators,
      elementFingerprint: fingerprint,
      pageSignatureBefore: this.lastSignature,
      pageSignatureAfter: sigAfter,
      waitCondition,
      assertion: null,
      optional,
    };
  }

  /**
   * Process a browser-use SSE "step" event: capture before-state (for next step),
   * then after-state + build RecordedSteps for the actions in this step.
   *
   * This method serializes steps to prevent race conditions — afterStep for step N
   * must complete before beforeStep for step N+1.
   */
  async processStepEvent(event: BrowserUseStepEvent): Promise<void> {
    // Chain on the previous step's completion to ensure serialization
    this.stepPromise = this.stepPromise.catch(() => {}).then(async () => {
      // Capture the after-state for THIS step's actions
      await this.captureAfterState(event.action_trace ?? []);

      // Capture the before-state for the NEXT step
      await this.captureBeforeState();
    });

    try {
      await this.stepPromise;
    } catch (err) {
      // Recorded steps are best-effort; but surface the failure so dropped
      // steps are debuggable instead of silently vanishing.
      console.error(
        `ShadowRecorder: failed to process step ${event.step_number}:`,
        err,
      );
    }
  }

  /** Called on "loading" event — browser-use just navigated. Capture before-state. */
  async processLoadingEvent(): Promise<void> {
    this.stepPromise = this.stepPromise.catch(() => {}).then(async () => {
      await this.captureBeforeState();
    });
    try {
      await this.stepPromise;
    } catch {}
  }

  /**
   * Finalize: compute fingerprints that were deferred, detect slot kinds,
   * and return the complete result.
   */
  async finalize(): Promise<ShadowRecorderResult> {
    const entryUrl = this.entryUrl ?? this.lastUrl ?? "";

    // Deduplicate slots
    const uniqueSlots: RecordedSlot[] = [];
    const seenSlotKinds = new Set<string>();
    for (const slot of this.slots) {
      if (!seenSlotKinds.has(slot.kind)) {
        seenSlotKinds.add(slot.kind);
        uniqueSlots.push(slot);
      }
    }

    return {
      steps: this.steps,
      slots: uniqueSlots,
      stepHash: hashSteps(this.steps),
      entryUrl,
    };
  }

  /**
   * Close the CDP connection. Does NOT close the browser — browser-use owns it.
   */
  async close(): Promise<void> {
    try {
      this.session.client.close();
    } catch {
      // ignore
    }
  }

  /** Internal: attachPage needs a sessionId. BrowserSession.attachPage takes targetId. */
  private async attachToTarget(targetId: string): Promise<Page> {
    return this.session.attachPage(targetId);
  }
}

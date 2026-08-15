import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { WaitTimeoutError } from "../browser/session.js";
import type { Page } from "../browser/session.js";
import type { DataStore } from "../cache/queries.js";
import type { Slot, Step, TestWithSteps, WaitCondition } from "../cache/types.js";
import { stepToEnglish } from "../util/describe.js";
import { elementIsVisible, elementText, elementValue } from "../util/dom-queries.js";
import { resolveElement, type ResolveResult } from "./dom.js";
import type { HealResult, StepHealer } from "./heal.js";

export class ReplayError extends Error {
  override name = "ReplayError";
}

export interface ReplayEvent {
  type: "step" | "done";
  idx: number;
  status: "passed" | "failed" | "skipped";
  intent: string;
  detail: Record<string, unknown>;
  healed?: string | null;
  success?: boolean;
  runId?: number;
  testId?: number;
  error?: string;
  llmCalls?: number;
  selfHealed?: number;
}

export interface ReplayOptions {
  /** Per-slot variable values; applied to fill/select steps whose recorded value matches a slot default. */
  variables?: Record<string, string>;
  /** Write one PNG per step into this directory. */
  screenshotDir?: string;
  /** Default wait-condition timeout in ms (overridable per condition). */
  timeoutMs?: number;
  /** Wait-condition polling interval in ms. */
  pollMs?: number;
  /**
   * LLM chat calls made outside the runner but attributable to this run
   * (e.g. the QF-62 slot re-fill LLM fallback). Added to the recorded run's
   * `llm_calls` so `qf runs` reflects re-fill activity.
   */
  llmCalls?: number;
  /**
   * A short phrase that identifies the test's success/goal state (e.g.
   * "Thanks for signing up to the Mitie Newsletter"). When set, the runner
   * checks `document.body.innerText` for this phrase before executing each
   * step (after the first navigate). If the phrase is already present the
   * remaining steps are skipped and the run is recorded as passed — making
   * the test idempotent against one-time side effects such as form submissions.
   */
  completionHint?: string;
  /**
   * Optional self-healer invoked when a step's element can't be located after
   * the full resolve timeout (Epic QF-64 / QF-66/QF-67). When omitted, a
   * locator miss fails the step as before.
   */
  healer?: StepHealer;
  /** Polling interval (ms) between element-resolution attempts. Default 200ms. */
  retryDelayMs?: number;
  /**
   * How long (ms) to poll for an element before giving up and invoking the
   * healer (or failing). Default 8 000 ms. Covers async-injected UI such as
   * cookie consent banners that take 1–3 s to appear after page load.
   */
  resolveTimeoutMs?: number;
  /** SSE streaming hook: called for each step result during replay. */
  onEvent?: (event: ReplayEvent) => void;
  /**
   * When replaying as part of a suite, the grouping suite-run id; written to
   * the created `runs` row so member runs can be grouped per suite execution.
   */
  suiteRunId?: number;
}

export interface ReplayStepResult {
  idx: number;
  action: Step["action"];
  status: "passed" | "failed" | "skipped";
  intent: string;
  detail: unknown;
}

export interface ReplayResult {
  runId: number;
  testId: number;
  success: boolean;
  steps: ReplayStepResult[];
  extracted: Record<string, string>;
  /** LLM chat calls attributable to this run (slot re-fill + self-heals). */
  llmCalls: number;
  /** Number of steps that were self-healed during this replay (QF-66/67). */
  selfHealed: number;
  /** Human-readable identifiers for each healed step: `step N: <intent> -> <locator>`. */
  selfHealedSteps: string[];
  /** Set when the run failed: `step N/M: <intent> — <reason>`. */
  error?: string;
}

/**
 * Build the substitution map: slot.defaultValue -> variable value for every
 * slot that has a provided variable. Fill/select steps then substitute their
 * recorded `value` (which matches the slot default) with the variable.
 */
export function applyVariables(
  slots: Pick<Slot, "name" | "defaultValue">[],
  variables: Record<string, string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const slot of slots) {
    const value = variables[slot.name];
    if (value !== undefined && slot.defaultValue !== null) {
      map.set(slot.defaultValue, value);
    }
  }
  return map;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Assign a priority score to a locator for replay ordering.
 * Lower score = tried first.
 *
 * Order: text="…" (most resilient to DOM changes) → #id / [data-testid=…]
 * (specific and readable) → class-based / role-based (medium) → absolute CSS
 * paths containing " > " (most brittle, breaks on structural DOM changes).
 */
function locatorScore(loc: string): number {
  if (loc.startsWith('text="')) return 0;
  if (loc.startsWith("#") || loc.startsWith("[data-testid=") || loc.startsWith('[data-testid="')) return 1;
  if (loc.includes(" > ")) return 3;
  return 2;
}

/**
 * Return a copy of `locators` sorted by replay resilience: text locators
 * first, absolute CSS paths last. The recorder captures locators in DOM-
 * traversal order (CSS-first); replay inverts that priority so the most
 * stable locators are tried before brittle positional paths.
 */
function prioritizeLocators(locators: string[]): string[] {
  return [...locators].sort((a, b) => locatorScore(a) - locatorScore(b));
}

export class ReplayRunner {
  private store: DataStore | null = null;
  constructor(private readonly page: Page) {}

  async runTest(
    store: DataStore,
    test: TestWithSteps,
    options: ReplayOptions = {},
  ): Promise<ReplayResult> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const pollMs = options.pollMs ?? 200;
    const slots = store.listSlotsByTest(test.id);
    const valueMap = applyVariables(slots, options.variables ?? {});
    const slotNameByDefault = new Map(
      slots
        .filter((s) => s.defaultValue !== null)
        .map((s) => [s.defaultValue as string, s.name]),
    );
    const extracted: Record<string, string> = {};
    this.store = store;

    const llmCalls = options.llmCalls ?? 0;
    const run = store.createRun({
      testId: test.id,
      status: "running",
      llmCalls,
      suiteRunId: options.suiteRunId,
    });
    const steps = test.steps;
    const results: ReplayStepResult[] = [];
    let selfHealed = 0;
    let currentLlmCalls = llmCalls;
    const selfHealedSteps: string[] = [];

    const retryDelayMs = options.retryDelayMs ?? 200;
    const resolveTimeoutMs = options.resolveTimeoutMs ?? 8_000;
    const runOpts = { timeoutMs, pollMs, retryDelayMs, resolveTimeoutMs, healer: options.healer };

    for (let i = 0; i < steps.length; i++) {
      // ── Completion-hint short-circuit ──────────────────────────────────────
      // After the first navigate has loaded the page (i > 0), check whether
      // the recorded success phrase is already visible. If so, skip all
      // remaining steps and record the run as passed — making the test
      // idempotent against one-time side effects (form submissions, etc.).
      if (i > 0 && options.completionHint) {
        try {
          const bodyText = (await this.page.evaluate(() => document.body.innerText)) as string;
          if (bodyText.includes(options.completionHint)) {
            for (let k = i; k < steps.length; k++) {
              const s = steps[k];
              const skipIntent = stepToEnglish(s);
              const detail = { reason: "goal already achieved" };
              results.push({ idx: k, action: s.action, status: "skipped", intent: skipIntent, detail });
              store.addRunStep(run.id, { idx: k, status: "skipped", detail });
              options.onEvent?.({ type: "step", idx: k, status: "skipped", intent: skipIntent, detail, healed: null });
            }
            store.finishRun(run.id, "passed");
            return {
              runId: run.id,
              testId: test.id,
              success: true,
              steps: results,
              extracted,
              llmCalls: currentLlmCalls,
              selfHealed,
              selfHealedSteps,
            };
          }
        } catch {
          // page.evaluate can fail if the page is mid-navigation; just proceed
        }
      }
      // ──────────────────────────────────────────────────────────────────────

      const step = steps[i];
      const intent = stepToEnglish(step);
      try {
        const exec = await this.executeStep(step, valueMap, slotNameByDefault, extracted, runOpts);

        // Optional step whose element was absent — record as "skipped" and
        // continue the run rather than failing.
        if (exec.skipped) {
          const detail: Record<string, unknown> = { reason: "optional element not present", optional: true };
          results.push({ idx: i, action: step.action, status: "skipped", intent, detail });
          store.addRunStep(run.id, { idx: i, status: "skipped", detail });
          options.onEvent?.({ type: "step", idx: i, status: "skipped", intent, detail, healed: null });
          if (options.screenshotDir) {
            await this.screenshot(options.screenshotDir, run.id, i + 1, step.action);
          }
          continue;
        }

        if (exec.healed) {
          selfHealed++;
          currentLlmCalls += 1;
          store.addRunLlmCalls(run.id, 1);
          selfHealedSteps.push(`step ${i + 1}: ${intent} -> ${exec.healed.matchedSelector}`);
        }
        const detail: Record<string, unknown> =
          exec.detail && typeof exec.detail === "object"
            ? { ...(exec.detail as Record<string, unknown>), healed: exec.healed?.matchedSelector ?? null }
            : { value: exec.detail, healed: exec.healed?.matchedSelector ?? null };
        results.push({ idx: i, action: step.action, status: "passed", intent, detail });
        store.addRunStep(run.id, { idx: i, status: "passed", detail });
        options.onEvent?.({ type: "step", idx: i, status: "passed", intent, detail, healed: exec.healed?.matchedSelector ?? null, runId: run.id });
        if (options.screenshotDir) {
          await this.screenshot(options.screenshotDir, run.id, i + 1, step.action);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          idx: i,
          action: step.action,
          status: "failed",
          intent,
          detail: { error: message },
        });
        store.addRunStep(run.id, {
          idx: i,
          status: "failed",
          detail: { error: message },
        });
        options.onEvent?.({ type: "step", idx: i, status: "failed", intent, detail: { error: message }, runId: run.id });
        for (let k = i + 1; k < steps.length; k++) {
          const skipped = steps[k];
          results.push({
            idx: k,
            action: skipped.action,
            status: "skipped",
            intent: stepToEnglish(skipped),
            detail: { reason: "previous step failed" },
          });
          store.addRunStep(run.id, {
            idx: k,
            status: "skipped",
            detail: { reason: "previous step failed" },
          });
        }
        store.finishRun(run.id, "failed", message);
        return {
          runId: run.id,
          testId: test.id,
          success: false,
          steps: results,
          extracted,
          llmCalls: currentLlmCalls,
          selfHealed,
          selfHealedSteps,
          error: `step ${i + 1}/${steps.length}: ${intent} — ${message}`,
        };
      }
    }

    store.finishRun(run.id, "passed");
    return {
      runId: run.id,
      testId: test.id,
      success: true,
      steps: results,
      extracted,
      llmCalls: currentLlmCalls,
      selfHealed,
      selfHealedSteps,
    };
  }

  // ----- internals --------------------------------------------------------

  private async executeStep(
    step: Step,
    valueMap: Map<string, string>,
    slotNameByDefault: Map<string, string>,
    extracted: Record<string, string>,
    opts: { timeoutMs: number; pollMs: number; retryDelayMs: number; resolveTimeoutMs: number; healer?: StepHealer },
  ): Promise<{ detail: unknown; healed?: HealResult; skipped?: true }> {
    switch (step.action) {
      case "navigate": {
        await this.page.navigate(step.value ?? "");
        await this.waitCondition(step.waitCondition, opts);
        return { detail: { url: step.value } };
      }
      case "click": {
        let resolved;
        try {
          resolved = await this.resolveWithHeal(step, opts);
        } catch (err) {
          // Only skip on a verified locator-miss (ReplayError from resolveWithHeal).
          // Other errors — EvaluationError, WaitTimeoutError, NavigationError — are
          // real operational failures and must propagate even on optional steps.
          if (step.optional && err instanceof ReplayError) {
            return { detail: { reason: "optional element not present" }, skipped: true };
          }
          throw err;
        }
        await this.waitForVisible(resolved.selector, step, opts);
        await this.page.click(resolved.selector);
        await this.waitCondition(step.waitCondition, opts);
        return { detail: { selector: resolved.selector, fingerprintMatch: resolved.fingerprintMatch }, healed: resolved.healed ?? undefined };
      }
      case "fill": {
        let resolved;
        try {
          resolved = await this.resolveWithHeal(step, opts);
        } catch (err) {
          if (step.optional && err instanceof ReplayError) {
            return { detail: { reason: "optional element not present" }, skipped: true };
          }
          throw err;
        }
        await this.waitForVisible(resolved.selector, step, opts);
        const value = valueMap.get(step.value ?? "") ?? step.value ?? "";
        await this.page.fill(resolved.selector, value);
        await this.waitCondition(step.waitCondition, opts);
        return { detail: { selector: resolved.selector, value, fingerprintMatch: resolved.fingerprintMatch }, healed: resolved.healed ?? undefined };
      }
      case "select": {
        let resolved;
        try {
          resolved = await this.resolveWithHeal(step, opts);
        } catch (err) {
          if (step.optional && err instanceof ReplayError) {
            return { detail: { reason: "optional element not present" }, skipped: true };
          }
          throw err;
        }
        await this.waitForVisible(resolved.selector, step, opts);
        const value = valueMap.get(step.value ?? "") ?? step.value ?? "";
        await this.page.select(resolved.selector, value);
        await this.waitCondition(step.waitCondition, opts);
        return { detail: { selector: resolved.selector, value, fingerprintMatch: resolved.fingerprintMatch }, healed: resolved.healed ?? undefined };
      }
      case "scroll": {
        // A scroll step recorded without a target element is a page-level scroll
        // (the agent scrolled the viewport, not to a specific element). Execute
        // it as a window.scrollBy instead of failing with "no locator candidates".
        const hasLocator = (step.locators && step.locators.length > 0) || step.selector;
        if (!hasLocator) {
          await this.page.evaluate(() => { window.scrollBy(0, window.innerHeight * 0.75); });
          await this.waitCondition(step.waitCondition, opts);
          return { detail: { pageScroll: true } };
        }
        let resolved;
        try {
          resolved = await this.resolveWithHeal(step, opts);
        } catch (err) {
          if (step.optional && err instanceof ReplayError) {
            return { detail: { reason: "optional element not present" }, skipped: true };
          }
          throw err;
        }
        await this.waitForVisible(resolved.selector, step, opts);
        await this.page.scroll(resolved.selector);
        await this.waitCondition(step.waitCondition, opts);
        return { detail: { selector: resolved.selector, fingerprintMatch: resolved.fingerprintMatch }, healed: resolved.healed ?? undefined };
      }
      case "extract": {
        const resolved = await this.resolveWithHeal(step, opts);
        let value = await this.page.evaluate(elementValue, resolved.selector);
        if (value === "") {
          value = await this.page.evaluate(elementText, resolved.selector);
        }
        const key =
          slotNameByDefault.get(step.value ?? "") ??
          resolved.selector;
        extracted[key] = value;
        return { detail: { selector: resolved.selector, value }, healed: resolved.healed ?? undefined };
      }
      case "assert":
        return { detail: await this.runAssertion(step, opts) };
      case "wait":
        await this.waitCondition(step.waitCondition, opts);
        return { detail: { waited: true } };
      case "go_back": {
        await this.page.goBack();
        await this.waitCondition(step.waitCondition, opts);
        return { detail: { url: await this.page.getUrl() } };
      }
      default:
        throw new ReplayError(`unknown action "${String(step.action)}"`);
    }
  }

  private async tryResolve(
    step: Step,
  ): Promise<{ selector: string; fingerprintMatch: boolean } | null> {
    const raw =
      step.locators && step.locators.length > 0
        ? step.locators
        : step.selector
          ? [step.selector]
          : [];
    if (raw.length === 0) {
      throw new ReplayError(`no locator candidates for "${step.action}" step`);
    }
    // Reorder so text-based locators are tried first (most resilient to DOM
    // structural changes), CSS absolute paths last (most brittle).
    const locators = prioritizeLocators(raw);
    const res: ResolveResult = await this.page.evaluate(
      resolveElement,
      locators,
      step.elementFingerprint,
    );
    if (!res.found || !res.selector) {
      return null;
    }
    return {
      selector: res.selector,
      fingerprintMatch: res.fingerprintMatch,
    };
  }

  private async resolveWithHeal(
    step: Step,
    opts: { retryDelayMs: number; resolveTimeoutMs: number; healer?: StepHealer },
  ): Promise<{
    selector: string;
    fingerprintMatch: boolean;
    healed: HealResult | null;
  }> {
    const stepLocators =
      step.locators && step.locators.length > 0
        ? step.locators
        : step.selector
          ? [step.selector]
          : [];
    const missError = () =>
      new ReplayError(`no element matches any of: ${prioritizeLocators(stepLocators).join(", ")}`);

    // An exact (fingerprint-matching) resolution is the happy path: the cached
    // locator still identifies the same element, so no healing is needed. When
    // the recorded step has no fingerprint baseline (e.g. a navigation click —
    // the interacted element is gone so we couldn't capture one), drift cannot
    // be detected, so a resolved locator is accepted as-is.
    const matchesBaseline = (r: NonNullable<Awaited<ReturnType<typeof this.tryResolve>>>) =>
      r.fingerprintMatch || !step.elementFingerprint;

    // Poll for the element with a configurable timeout instead of a single
    // short retry. This handles async-injected UI (cookie banners, overlays,
    // lazy-loaded content) that takes 1–3 s to appear after page load.
    const resolveDeadline = Date.now() + opts.resolveTimeoutMs;
    let resolved = await this.tryResolve(step);
    if (resolved && matchesBaseline(resolved)) {
      return { ...resolved, healed: null };
    }

    while (Date.now() < resolveDeadline) {
      const remaining = resolveDeadline - Date.now();
      await sleep(Math.min(opts.retryDelayMs, remaining));
      const next = await this.tryResolve(step);
      if (next) {
        if (matchesBaseline(next)) return { ...next, healed: null };
        // Keep the first partial match as fallback (fingerprint mismatch but
        // element located) — continues polling hoping for exact match.
        if (!resolved) resolved = next;
      }
    }

    // No healer wired: accept a drifted fallback locator if one resolved (so a
    // removed stable attribute still replays via a fallback locator), otherwise
    // surface the original miss.
    if (!opts.healer) {
      if (resolved) return { ...resolved, healed: null };
      throw missError();
    }

    // Drift or miss, with a healer wired in: rediscover the element through the
    // healer. A fingerprint mismatch means the page has changed under a stable
    // locator (e.g. an `id` survived while the testid was renamed), so the
    // cached locators/fingerprint/wait-condition are stale and must be refreshed.
    const healed = await opts.healer.heal(step, this.page);
    if (!healed) throw missError();

    const locators = healed.locators;
    let check: ResolveResult;
    try {
      check = await this.page.evaluate(resolveElement, locators, healed.elementFingerprint);
    } catch {
      check = { found: false, selector: null, fingerprint: null, fingerprintMatch: false, matchedLocator: null };
    }
    if (!check.found || !check.selector) {
      throw new ReplayError(
        `healed locator ${locators.join(", ")} does not resolve on the page`,
      );
    }
    // QF-68: rewrite the step in memory (so its wait-condition targets the
    // rediscovered element) and snapshot a version in the cache.
    this.applyHealToStep(step, healed);
    await this.persistHeal(step, healed);
    return {
      selector: check.selector,
      fingerprintMatch: check.fingerprintMatch,
      healed,
    };
  }

  /** Rewrite the in-memory step so its wait-condition targets the rediscovered
   * element (the old element-present wait target no longer exists after a
   * page redesign). */
  private applyHealToStep(step: Step, healed: HealResult): void {
    step.locators = healed.locators;
    step.elementFingerprint = healed.elementFingerprint;
    if (step.waitCondition?.kind === "element") {
      step.waitCondition = { ...step.waitCondition, ref: healed.matchedSelector };
    }
  }

  private async persistHeal(step: Step, healed: HealResult): Promise<void> {
    const store = this.store;
    if (!store) return; // no store available (e.g. healer called outside runTest)
    const testId = step.testId;

    // Rewrite the element-present wait condition to the healed selector when the
    // recorded wait still references the (now-missing) original locator.
    const waitCondition =
      step.waitCondition?.kind === "element"
        ? { ...step.waitCondition, ref: healed.matchedSelector }
        : step.waitCondition;

    let versions = store.listVersionsByTest(testId);
    // On the first heal, snapshot the original (pre-heal) steps as v1 so the
    // version history shows "v1 original" + "v2 healed".
    if (versions.length === 0) {
      const currentSteps = store.listStepsByTest(testId);
      const currentSlots = store.listSlotsByTest(testId);
      store.createVersion({
        testId,
        version: 1,
        steps: currentSteps,
        slots: currentSlots,
        reason: `baseline before self-heal step ${step.idx + 1}`,
      });
      versions = store.listVersionsByTest(testId);
    }

    store.updateStep(step.id, {
      locators: healed.locators,
      elementFingerprint: healed.elementFingerprint,
      waitCondition,
    });
    const updatedSteps = store.listStepsByTest(testId);
    const updatedSlots = store.listSlotsByTest(testId);
    store.createVersion({
      testId,
      version: versions.length + 1,
      steps: updatedSteps,
      slots: updatedSlots,
      reason: `self-heal step ${step.idx + 1}: ${healed.matchedSelector}`,
    });
  }

  private async runAssertion(
    step: Step,
    opts: { timeoutMs: number; pollMs: number },
  ): Promise<unknown> {
    const a = step.assertion;
    if (a?.op === "url") {
      const url = (await this.page.getUrl()).replace(/\/+$/, "");
      const expected = String(a.expected ?? "").replace(/\/+$/, "");
      if (!url.includes(expected)) {
        throw new ReplayError(`URL "${url}" does not contain "${expected}"`);
      }
      return { op: "url", expected, url };
    }
    if (a?.op === "text") {
      const sel = step.selector;
      if (!sel) throw new ReplayError("assert text requires a selector");
      const text = await this.page.evaluate(elementText, sel);
      const expected = String(a.expected ?? "");
      if (!text.includes(expected)) {
        throw new ReplayError(
          `element "${sel}" text "${text}" does not contain "${expected}"`,
        );
      }
      return { op: "text", expected, text };
    }
    if (a?.op === "visible") {
      const sel = step.selector;
      if (!sel) throw new ReplayError("assert visible requires a selector");
      const visible = await this.page.evaluate(elementIsVisible, sel);
      if (!visible) {
        throw new ReplayError(`element "${sel}" is not visible`);
      }
      return { op: "visible", selector: sel };
    }
    void opts;
    throw new ReplayError(`unknown assertion op "${String(a?.op)}"`);
  }

  private async waitCondition(
    wc: WaitCondition | null,
    opts: { timeoutMs: number; pollMs: number },
  ): Promise<void> {
    if (!wc) return;
    const timeoutMs = wc.timeoutMs ?? opts.timeoutMs;
    const pollMs = wc.pollMs ?? opts.pollMs;
    const deadline = Date.now() + timeoutMs;

    const remaining = () => Date.now() < deadline;

    switch (wc.kind) {
      case "url": {
        const contains = (wc.contains ?? "").replace(/\/+$/, "");
        for (;;) {
          const url = (await this.page.getUrl()).replace(/\/+$/, "");
          if (url.includes(contains)) return;
          if (!remaining()) {
            throw new WaitTimeoutError(
              `Timed out waiting for url containing "${contains}"`,
            );
          }
          await sleep(pollMs);
        }
      }
      case "element": {
        const ref = wc.ref;
        if (!ref) return;
        for (;;) {
          const visible = await this.page.evaluate(elementIsVisible, ref);
          if (visible) return;
          if (!remaining()) {
            throw new WaitTimeoutError(`Timed out waiting for "${ref}" visible`);
          }
          await sleep(pollMs);
        }
      }
      case "signature": {
        const hash = wc.hash;
        if (!hash) return;
        const before = wc.before;
        if (before !== undefined && before === hash) return; // action didn't change the page
        for (;;) {
          const sig = await this.page.pageSignature();
          if (sig === hash) return;
          // browser-use never demands an exact snapshot: it performs the action
          // and proceeds once the page reacted. Accept any movement off the
          // pre-action state — async rendering (mega-menus, tab panels) almost
          // never reproduces the exact recorded hash. Without `before` (older
          // recordings) the strict hash match is preserved.
          if (before !== undefined && before !== hash && sig !== before) return;
          if (!remaining()) {
            throw new WaitTimeoutError(
              `Timed out waiting for page signature ${hash}`,
            );
          }
          await sleep(pollMs);
        }
      }
      case "manual":
        return;
      default:
        return;
    }
  }

  /** browser-use parity: wait until the resolved element is actually
   * visible/interactable before dispatching the action. Covers elements that
   * are in the DOM but CSS-hidden until an earlier interaction (e.g. a menu
   * item that only appears once its parent dropdown is open). */
  private async waitForVisible(
    selector: string,
    step: Step,
    opts: { timeoutMs: number; pollMs: number },
  ): Promise<void> {
    const deadline = Date.now() + opts.timeoutMs;
    const label = step.locators?.join(", ") ?? selector;
    for (;;) {
      const visible = await this.page.evaluate(elementIsVisible, selector);
      if (visible) return;
      if (Date.now() >= deadline) {
        throw new WaitTimeoutError(
          `Timed out waiting for "${label}" visible before ${step.action}`,
        );
      }
      await sleep(opts.pollMs);
    }
  }

  private async screenshot(
    dir: string,
    runId: number,
    stepNo: number,
    action: Step["action"],
  ): Promise<void> {
    mkdirSync(dir, { recursive: true });
    const file = join(
      dir,
      `${runId}-${String(stepNo).padStart(2, "0")}-${action}.png`,
    );
    await this.page.screenshot({ file });
  }
}

/**
 * Self-healing (Epic QF-64 / QF-67).
 *
 * When the replay engine cannot locate a cached step's element (the page
 * changed), the healer rediscovers it: it takes the step's intent and a fresh
 * accessibility snapshot, asks the LLM to pick the matching interactive
 * element, validates the returned ref against the live page, and returns new
 * locator candidates plus a fresh fingerprint for the cache update.
 */
import type { LLMClient } from "../llm/client.js";
import type { Page } from "../browser/session.js";
import type { Step } from "../cache/types.js";
import { stepToEnglish } from "../util/describe.js";
import { buildSnapshot } from "../planner/snapshot.js";
import { resolveElement } from "./dom.js";

export interface HealResult {
  /** Ordered locator candidates for the rediscovered element. */
  locators: string[];
  /** Fresh fingerprint computed for the rediscovered element. */
  elementFingerprint: string | null;
  /** The CSS selector that resolved on the live page. */
  matchedSelector: string;
}

export interface StepHealer {
  /**
   * Rediscover the element a failing step targets. Returns new locator
   * candidates and a fresh fingerprint, or `null` when the healer declines
   * (no plausible match) so the original failure is surfaced.
   */
  heal(step: Step, page: Page): Promise<HealResult | null>;
}

export class HealError extends Error {
  override name = "HealError";
}

export class LLMStepHealer implements StepHealer {
  constructor(private readonly llm: LLMClient) {}

  async heal(step: Step, page: Page): Promise<HealResult> {
    const nodes = await page.getAccessibilitySnapshot();
    let snapshot;
    try {
      snapshot = await buildSnapshot(page, nodes);
    } catch {
      throw new HealError("failed to build the page snapshot for self-heal");
    }

    const intent = stepToEnglish(step);
    const elementsDesc = snapshot.elements.length
      ? snapshot.elements
          .map((e) => `[${e.index}] ${e.role} "${e.name}" (${e.ref})`)
          .join("\n")
      : "(no interactive elements on the page)";

    const prompt = [
      "A cached replay step can no longer find its element because the page changed.",
      `The step's intent: "${intent}".`,
      "Pick the page element this step targets from the accessibility snapshot below.",
      'Reply with ONLY a JSON object: {"ref": <index>}',
      "",
      "Interactive elements (index: role \"name\" (cssRef)):",
      elementsDesc,
    ].join("\n");

    const res = await this.llm.chat(
      [{ role: "user", content: prompt }],
      { temperature: 0, responseFormat: { type: "json_object" } },
    );

    let ref: number | null = null;
    let parseErr: HealError | null = null;
    try {
      ref = this.parseRef(res.text);
    } catch (e) {
      ref = null;
      parseErr = e instanceof HealError ? e : new HealError(String(e));
    }

    let el = ref !== null ? snapshot.elements[ref - 1] : undefined;

    // Fallback: match the step intent text against element names in the snapshot.
    // E.g. intent 'Click "What we do"' → find element named 'What we do'.
    if (!el) {
      el = this.matchByIntent(step, intent, snapshot.elements);
    }

    if (!el) {
      if (parseErr) throw parseErr;
      throw new HealError(
        `self-heal returned ref ${ref} which is not an interactive element`,
      );
    }

    // validation: the rediscovered ref must actually resolve on the live page
    const check = await page.evaluate(resolveElement, [el.ref], null);
    if (!check.found || !check.selector) {
      throw new HealError(
        `self-heal ref ${el.ref} does not resolve to an element on the page`,
      );
    }

    const elementFingerprint = await page.fingerprint(el.ref).catch(() => null);
    return { locators: [el.ref], elementFingerprint, matchedSelector: el.ref };
  }

  private matchByIntent(
    step: Step,
    intent: string,
    elements: { index: number; role: string; name: string; ref: string }[],
  ): { index: number; role: string; name: string; ref: string } | undefined {
    if (elements.length === 0) return undefined;

    // Collect all text clues from the step: quoted text in locators, selector text, step value
    const clues: string[] = [];

    // 1. Quoted text from text="..." locators
    for (const loc of step.locators ?? []) {
      if (loc.startsWith('text="')) {
        clues.push(loc.slice(6, -1));
      }
    }
    // 2. Quoted text from the intent string (e.g. Click "What we do")
    const m = /"([^"]+)"/.exec(intent);
    if (m) clues.push(m[1]);
    // 3. Step value (for fill/select the value is the text)
    if (step.value) clues.push(step.value);

    if (clues.length === 0) return undefined;

    for (const clue of clues) {
      const needle = clue.toLowerCase().trim();
      // Exact match first
      let best = elements.find((e) => e.name.toLowerCase().trim() === needle);
      if (best) return best;
      // Contains match (either direction)
      best = elements.find(
        (e) => e.name.toLowerCase().includes(needle) || needle.includes(e.name.toLowerCase()),
      );
      if (best) return best;
    }

    return undefined;
  }

  private parseRef(text: string): number {
    const trimmed = text.trim();
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first === -1 || last === -1 || last < first) {
      throw new HealError(
        `self-heal did not return a JSON object: ${trimmed.slice(0, 80)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(first, last + 1));
    } catch (e) {
      throw new HealError(`self-heal returned invalid JSON: ${(e as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new HealError("self-heal returned a non-object payload");
    }
    const obj = parsed as Record<string, unknown>;
    const candidates = [obj.ref, obj.index, obj.element_index, obj.id];
    for (const c of candidates) {
      if (typeof c === "number" && Number.isInteger(c) && c >= 1) return c;
      if (typeof c === "string") {
        const n = Number(c);
        if (Number.isInteger(n) && n >= 1) return n;
      }
    }
    // Fallback: scan all values in the object for a positive integer
    for (const v of Object.values(obj)) {
      if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1) return n;
      }
    }
    throw new HealError(
      `self-heal ref must be a positive integer, got ${JSON.stringify(obj).slice(0, 120)}`,
    );
  }
}

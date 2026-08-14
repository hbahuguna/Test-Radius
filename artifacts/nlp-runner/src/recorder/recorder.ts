import type { Page } from "../browser/session.js";
import { ElementNotFoundError } from "../browser/session.js";
import type { SaveTestInput, SaveTestResult } from "../cache/queries.js";
import type { DataStore } from "../cache/queries.js";
import type {
  Assertion,
  SlotKind,
  StepAction,
  WaitCondition,
} from "../cache/types.js";
import { fnv1a } from "../util/hash.js";
import {
  captureElementInfo,
  collectVisibleRefs,
} from "./dom.js";
import {
  elementIsVisible,
  elementText,
  elementValue,
} from "../util/dom-queries.js";
import { detectSlot, detectSlotKind } from "./slots.js";

export interface RecordedStep {
  action: StepAction;
  selector: string | null;
  value: string | null;
  locators: string[];
  elementFingerprint: string | null;
  pageSignatureBefore: string | null;
  pageSignatureAfter: string | null;
  waitCondition: WaitCondition | null;
  assertion: Assertion | null;
}

export interface RecordedSlot {
  name: string;
  kind: SlotKind;
  defaultValue: string;
}

export interface RecorderOptions {
  settleMs?: number;
}

export function hashSteps(steps: RecordedStep[]): string {
  const essence = steps
    .map((s) =>
      JSON.stringify({
        action: s.action,
        selector: s.selector,
        value: s.value,
        locators: s.locators,
        elementFingerprint: s.elementFingerprint,
        pageSignatureBefore: s.pageSignatureBefore,
        pageSignatureAfter: s.pageSignatureAfter,
        waitCondition: s.waitCondition,
        assertion: s.assertion,
      }),
    )
    .join("\n");
  return fnv1a(essence);
}

function mergeSlots(base: RecordedSlot[], extra: RecordedSlot[] | undefined): RecordedSlot[] {
  if (!extra || extra.length === 0) return base;
  const byKind = new Set<string>();
  for (const s of base) byKind.add(s.kind);
  const out: RecordedSlot[] = [...base];
  for (const s of extra) {
    if (!byKind.has(s.kind)) {
      byKind.add(s.kind);
      out.push(s);
    }
  }
  return out;
}

export class Recorder {
  private readonly steps: RecordedStep[] = [];
  private readonly slots: RecordedSlot[] = [];
  private entryUrl: string | null = null;
  private readonly settleMs: number;

  constructor(
    private readonly page: Page,
    options: RecorderOptions = {},
  ) {
    this.settleMs = options.settleMs ?? 250;
  }

  getPage(): Page {
    return this.page;
  }

  getSteps(): RecordedStep[] {
    return this.steps.map((s) => ({ ...s }));
  }

  getSlots(): RecordedSlot[] {
    return this.slots.map((s) => ({ ...s }));
  }

  getEntryUrl(): string | null {
    return this.entryUrl;
  }

  // ----- actions ----------------------------------------------------------

  async navigate(url: string): Promise<void> {
    const pageSignatureBefore = await this.page.pageSignature();
    const { url: actualUrl } = await this.page.navigate(url);
    const pageSignatureAfter = await this.page.pageSignature();
    const waitUrl = actualUrl || url;
    this.entryUrl = waitUrl;
    this.pushStep({
      action: "navigate",
      selector: null,
      value: url,
      locators: [],
      elementFingerprint: null,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition: {
        kind: "url",
        contains: waitUrl,
        desc: `url contains "${waitUrl}"`,
      },
      assertion: null,
    });
  }

  async click(selector: string): Promise<void> {
    const pageSignatureBefore = await this.page.pageSignature();
    const urlBefore = await this.page.getUrl();
    const refsBefore = await this.page.evaluate(collectVisibleRefs);
    const { locators, fingerprint } = await this.captureElement(selector);
    await this.page.click(selector);
    await this.settle();
    const pageSignatureAfter = await this.page.pageSignature();
    const urlAfter = await this.page.getUrl();
    const waitCondition = await this.clickWaitCondition(
      urlBefore,
      urlAfter,
      refsBefore,
      pageSignatureBefore,
      pageSignatureAfter,
    );
    this.pushStep({
      action: "click",
      selector,
      value: null,
      locators,
      elementFingerprint: fingerprint,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition,
      assertion: null,
    });
  }

  async fill(selector: string, text: string): Promise<void> {
    const pageSignatureBefore = await this.page.pageSignature();
    const { locators, fingerprint, label } = await this.captureElement(selector);
    await this.page.fill(selector, text);
    await this.settle();
    const pageSignatureAfter = await this.page.pageSignature();
    this.pushStep({
      action: "fill",
      selector,
      value: text,
      locators,
      elementFingerprint: fingerprint,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition: {
        kind: "element",
        ref: locators[0] ?? selector,
        desc: `"${label || locators[0] || selector}" present`,
      },
      assertion: null,
    });
    const slot = detectSlot(text);
    if (slot) {
      this.slots.push({ name: slot.name, kind: slot.kind, defaultValue: text });
    }
  }

  async select(selector: string, value: string): Promise<void> {
    const pageSignatureBefore = await this.page.pageSignature();
    const { locators, fingerprint, label } = await this.captureElement(selector);
    await this.page.select(selector, value);
    await this.settle();
    const pageSignatureAfter = await this.page.pageSignature();
    this.pushStep({
      action: "select",
      selector,
      value,
      locators,
      elementFingerprint: fingerprint,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition: {
        kind: "element",
        ref: locators[0] ?? selector,
        desc: `"${label || locators[0] || selector}" present`,
      },
      assertion: null,
    });
  }

  async scroll(
    selector: string,
    options?: { block?: ScrollLogicalPosition },
  ): Promise<void> {
    const pageSignatureBefore = await this.page.pageSignature();
    const { locators, fingerprint, label } = await this.captureElement(selector);
    await this.page.scroll(selector, options);
    await this.settle();
    const pageSignatureAfter = await this.page.pageSignature();
    this.pushStep({
      action: "scroll",
      selector,
      value: null,
      locators,
      elementFingerprint: fingerprint,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition: {
        kind: "element",
        ref: locators[0] ?? selector,
        desc: `"${label || locators[0] || selector}" present`,
      },
      assertion: null,
    });
  }

  async assertVisible(selector: string): Promise<void> {
    const pageSignatureBefore = await this.page.pageSignature();
    const visible = await this.page.evaluate(elementIsVisible, selector);
    if (!visible) {
      throw new Error(`assertVisible failed: "${selector}" is not visible`);
    }
    const pageSignatureAfter = await this.page.pageSignature();
    this.pushStep({
      action: "assert",
      selector,
      value: null,
      locators: [],
      elementFingerprint: null,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition: null,
      assertion: { op: "visible", expected: true },
    });
  }

  async assertText(selector: string, expected: string): Promise<void> {
    const pageSignatureBefore = await this.page.pageSignature();
    const text = await this.page.evaluate(elementText, selector);
    if (!text.includes(expected)) {
      throw new Error(
        `assertText failed: expected "${expected}" inside "${text}"`,
      );
    }
    const pageSignatureAfter = await this.page.pageSignature();
    this.pushStep({
      action: "assert",
      selector,
      value: null,
      locators: [],
      elementFingerprint: null,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition: null,
      assertion: { op: "text", expected },
    });
  }

  async assertUrl(contains: string): Promise<void> {
    const pageSignatureBefore = await this.page.pageSignature();
    const url = await this.page.getUrl();
    if (!url.includes(contains)) {
      throw new Error(`assertUrl failed: "${url}" does not contain "${contains}"`);
    }
    const pageSignatureAfter = await this.page.pageSignature();
    this.pushStep({
      action: "assert",
      selector: null,
      value: null,
      locators: [],
      elementFingerprint: null,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition: null,
      assertion: { op: "url", expected: contains },
    });
  }

  async extract(selector: string, name?: string): Promise<string | null> {
    const pageSignatureBefore = await this.page.pageSignature();
    const { locators, fingerprint } = await this.captureElement(selector);
    const value = await this.page.evaluate(elementValue, selector);
    const pageSignatureAfter = await this.page.pageSignature();
    this.pushStep({
      action: "extract",
      selector,
      value,
      locators,
      elementFingerprint: fingerprint,
      pageSignatureBefore,
      pageSignatureAfter,
      waitCondition: null,
      assertion: null,
    });
    if (name) {
      this.slots.push({
        name,
        kind: detectSlotKind(value) ?? "text",
        defaultValue: value,
      });
    }
    return value;
  }

  // ----- persistence ------------------------------------------------------

  async buildSaveInput(
    name: string,
    options: {
      query?: string | null;
      normalizedQuery?: string | null;
      queryEmbedding?: Uint8Array | null;
      description?: string | null;
      extraSlots?: RecordedSlot[];
    } = {},
  ): Promise<SaveTestInput> {
    const entryUrl = this.entryUrl ?? (await this.page.getUrl());
    return {
      name,
      source: "recorder",
      entryUrl,
      stepHash: hashSteps(this.steps),
      query: options.query ?? null,
      normalizedQuery: options.normalizedQuery ?? null,
      queryEmbedding: options.queryEmbedding ?? null,
      description: options.description ?? null,
      steps: this.steps.map((s) => ({ ...s })),
      slots: mergeSlots(this.slots, options.extraSlots).map((s) => ({ ...s })),
    };
  }

  async saveTest(
    store: DataStore,
    name: string,
    options: {
      query?: string | null;
      normalizedQuery?: string | null;
      queryEmbedding?: Uint8Array | null;
      description?: string | null;
      extraSlots?: RecordedSlot[];
    } = {},
  ): Promise<SaveTestResult> {
    return store.saveTest(await this.buildSaveInput(name, options));
  }

  // ----- internals --------------------------------------------------------

  private pushStep(step: RecordedStep): void {
    this.steps.push(step);
  }

  private async captureElement(
    selector: string,
  ): Promise<{ locators: string[]; fingerprint: string; label: string }> {
    const info = await this.page.evaluate(captureElementInfo, selector);
    if (!info.found) {
      throw new ElementNotFoundError(
        `Recorder: no element matches selector "${selector}"`,
      );
    }
    const fingerprint = await this.page.fingerprint(selector);
    return { locators: info.locators, fingerprint, label: info.label };
  }

  private async clickWaitCondition(
    urlBefore: string,
    urlAfter: string,
    refsBefore: string[],
    pageSignatureBefore: string,
    pageSignatureAfter: string,
  ): Promise<WaitCondition> {
    if (urlAfter !== urlBefore) {
      return { kind: "url", contains: urlAfter, desc: `url contains "${urlAfter}"` };
    }
    const refsAfter = await this.page.evaluate(collectVisibleRefs);
    const before = new Set(refsBefore);
    const newRef = refsAfter.find((ref) => !before.has(ref));
    if (newRef) {
      return { kind: "element", ref: newRef, desc: `"${newRef}" visible` };
    }
    return {
      kind: "signature",
      hash: pageSignatureAfter,
      before: pageSignatureBefore,
      desc: "page signature settles",
    };
  }

  private async settle(): Promise<void> {
    if (this.settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    }
  }
}

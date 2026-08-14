/**
 * Test doubles for the live-agent module: a scriptable fake `Page` and a fake
 * `LiveContext`, so action/agent logic is unit-testable without Chrome.
 */
import type { Page } from "../browser/session.js";
import type { LiveContext, LiveTab } from "./types.js";

export class FakePage {
  public url = "about:blank";
  public clicks: string[] = [];
  public fills: { selector: string; text: string }[] = [];
  public scrolls: string[] = [];
  public evaluated: unknown[][] = [];
  public navigateCalls: string[] = [];
  public historyBacks = 0;
  public screenshotData = "ZmFrZXBuZw==";
  public waitFired = 0;

  /** Scripted results returned in order for `evaluate` calls. */
  public scriptedEvaluate: unknown[] = [];

  async navigate(url: string): Promise<{ url: string }> {
    this.navigateCalls.push(url);
    this.url = url;
    return { url };
  }

  async getUrl(): Promise<string> {
    return this.url;
  }

  async evaluate<T = unknown>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
    this.evaluated.push(args);
    if (typeof fn === "string") {
      if (this.scriptedEvaluate.length > 0) {
        return this.scriptedEvaluate.shift() as T;
      }
      return "eval-ok" as T;
    }
    if (this.scriptedEvaluate.length > 0) {
      return this.scriptedEvaluate.shift() as T;
    }
    return "eval-ok" as T;
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector);
  }

  async fill(selector: string, text: string): Promise<void> {
    this.fills.push({ selector, text });
  }

  async scroll(selector: string): Promise<void> {
    this.scrolls.push(selector);
  }

  async screenshot(): Promise<string> {
    return this.screenshotData;
  }

  async waitFor<T = unknown>(predicate: string | ((...args: unknown[]) => T)): Promise<T> {
    this.waitFired++;
    if (typeof predicate === "string") return true as T;
    return predicate() as T;
  }
}

export function fakeContext(overrides: Partial<LiveContext> = {}): LiveContext {
  const page = new FakePage() as unknown as Page;
  return {
    page,
    browserSession: {} as never,
    llm: undefined,
    resolveSelector: (index: number) => `[data-qf-index="${index}"]`,
    openTab: async () => {},
    switchTab: async () => {},
    closeTab: async () => {},
    listTabs: async (): Promise<LiveTab[]> => [],
    ...overrides,
  };
}

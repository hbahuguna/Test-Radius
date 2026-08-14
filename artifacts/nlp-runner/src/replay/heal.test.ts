import { describe, expect, it } from "vitest";
import { HealError, LLMStepHealer } from "./heal.js";
import { MockLLMClient } from "../planner/test-utils.js";
import type { Page } from "../browser/session.js";
import type { AccessibilityNode } from "../browser/session.js";

const REFS = {
  name: "[data-testid=signup-full-name]",
  email: "[data-testid=signup-email-address]",
  submit: "[data-testid=btn-create-account]",
};

const ELEMENTS: AccessibilityNode[] = [
  { ref: REFS.name, role: "textbox", name: "Name" } as AccessibilityNode,
  { ref: REFS.email, role: "textbox", name: "Email" } as AccessibilityNode,
  { ref: REFS.submit, role: "button", name: "Create account" } as AccessibilityNode,
];

/** Minimal page double: snapshot returns ELEMENTS; resolveElement always finds
 * the element whose ref was requested. */
class FakePage {
  url = "http://localhost:3123/signup";
  titleVal = "Sign up — QueryFirst Fixture";
  snapshots: AccessibilityNode[] = ELEMENTS;
  fingerprints = new Map<string, string>();
  /** refs present in the live DOM (resolvable via resolveElement). */
  liveRefs: Set<string> = new Set(Object.values(REFS));

  async getUrl(): Promise<string> {
    return this.url;
  }
  async getAccessibilitySnapshot(): Promise<AccessibilityNode[]> {
    return this.snapshots;
  }
  async fingerprint(selector: string): Promise<string> {
    return this.fingerprints.get(selector) ?? `fp-${selector}`;
  }
  async evaluate<T = unknown>(
    fn: string | ((...args: unknown[]) => T),
    ...args: unknown[]
  ): Promise<T> {
    const body = typeof fn === "string" ? fn : fn.toString();
    // document.title probe (buildSnapshot)
    if (body.includes("document.title")) return this.titleVal as T;
    // resolveElement probe
    if (body.includes("expectedFingerprint") || body.includes("firstFound")) {
      const locators = (args[0] ?? []) as string[];
      const candidate = locators.find((l) => this.liveRefs.has(l));
      if (candidate) {
        return {
          found: true,
          selector: candidate,
          fingerprint: this.fingerprints.get(candidate) ?? "fp",
          fingerprintMatch: false,
          matchedLocator: candidate,
        } as T;
      }
      return {
        found: false,
        selector: null,
        fingerprint: null,
        fingerprintMatch: false,
        matchedLocator: null,
      } as T;
    }
    return undefined as T;
  }
}

describe("LLMStepHealer", () => {
  it("parses a JSON {ref} response and validates the element resolves", async () => {
    const page = new FakePage();
    const llm = new MockLLMClient(['{"ref": 3}']);
    const healer = new LLMStepHealer(llm);

    const res = await healer.heal(
      { action: "click", locators: ["[data-testid=signup-submit]"], elementFingerprint: "old" } as never,
      page as unknown as Page,
    );

    expect(res).not.toBeNull();
    expect(res!.matchedSelector).toBe(REFS.submit);
    expect(res!.locators).toEqual([REFS.submit]);
  });

  it("throws HealError when the LLM returns no JSON object", async () => {
    const page = new FakePage();
    const llm = new MockLLMClient(["could not find it"]);
    const healer = new LLMStepHealer(llm);
    await expect(
      healer.heal({ action: "click", locators: [], elementFingerprint: null } as never, page as unknown as Page),
    ).rejects.toThrow(HealError);
  });

  it("throws HealError when the ref is out of range (not a real element)", async () => {
    const page = new FakePage();
    const llm = new MockLLMClient(['{"ref": 99}']);
    const healer = new LLMStepHealer(llm);
    await expect(
      healer.heal({ action: "click", locators: [], elementFingerprint: null } as never, page as unknown as Page),
    ).rejects.toThrow(/not an interactive element/);
  });

  it("throws HealError when the ref is not a positive integer", async () => {
    const page = new FakePage();
    const llm = new MockLLMClient(['{"ref": -2}']);
    const healer = new LLMStepHealer(llm);
    await expect(
      healer.heal({ action: "click", locators: [], elementFingerprint: null } as never, page as unknown as Page),
    ).rejects.toThrow(/positive integer/);
  });

  it("throws HealError when the returned ref does not resolve on the page", async () => {
    const page = new FakePage();
    // element exists in the snapshot but has been removed from the live DOM
    page.liveRefs.delete(REFS.name);
    const llm = new MockLLMClient(['{"ref": 1}']);
    const healer = new LLMStepHealer(llm);
    await expect(
      healer.heal({ action: "click", locators: [], elementFingerprint: null } as never, page as unknown as Page),
    ).rejects.toThrow(/does not resolve/);
  });
});

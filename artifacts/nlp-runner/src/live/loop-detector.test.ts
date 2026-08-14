import { describe, expect, it } from "vitest";
import { ActionLoopDetector, PageFingerprint } from "./loop-detector.js";

describe("PageFingerprint", () => {
  it("hashes url + elementCount + dom text", () => {
    const a = PageFingerprint.fromBrowserState("https://x.test/", "[1]<a />", 1);
    const b = PageFingerprint.fromBrowserState("https://x.test/", "[1]<a />", 1);
    const c = PageFingerprint.fromBrowserState("https://x.test/", "[1]<a /> [2]<a />", 2);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe("ActionLoopDetector", () => {
  it("does not nudge on fresh actions", () => {
    const d = new ActionLoopDetector(20);
    d.recordActions([
      { name: "navigate", params: { url: "https://a.test/" } },
      { name: "click", params: { index: 1 } },
    ]);
    expect(d.getNudgeMessage()).toBeNull();
  });

  it("nudges after 5 identical clicks", () => {
    const d = new ActionLoopDetector(20);
    for (let i = 0; i < 5; i++) d.recordActions([{ name: "click", params: { index: 3 } }]);
    const nudge = d.getNudgeMessage();
    expect(nudge).toContain("repeated a similar action 5 times");
  });

  it("escalates nudge at 8 and 12", () => {
    const d = new ActionLoopDetector(20);
    for (let i = 0; i < 8; i++) d.recordActions([{ name: "click", params: { index: 1 } }]);
    expect(d.getNudgeMessage()).toContain("Are you still making progress");
    for (let i = 0; i < 4; i++) d.recordActions([{ name: "click", params: { index: 1 } }]);
    expect(d.getNudgeMessage()).toContain("a different approach might get you there faster");
  });

  it("exempts wait/done/go_back from repetition", () => {
    const d = new ActionLoopDetector(20);
    for (let i = 0; i < 20; i++) d.recordActions([{ name: "wait", params: { ms: 500 } }]);
    expect(d.maxRepetitionCount).toBe(0);
    expect(d.getNudgeMessage()).toBeNull();
  });

  it("detects page stagnation across consecutive identical states", () => {
    const d = new ActionLoopDetector();
    for (let i = 0; i < 6; i++) d.recordPageState("https://x.test/", "[1]<a />", 1);
    const nudge = d.getNudgeMessage();
    expect(nudge).toContain("page content has not changed across 5");
  });

  it("treats different input text as different actions", () => {
    const d = new ActionLoopDetector(20);
    d.recordActions([{ name: "input_text", params: { index: 1, text: "A" } }]);
    for (let i = 0; i < 4; i++) d.recordActions([{ name: "input_text", params: { index: 1, text: "A" } }]);
    expect(d.maxRepetitionCount).toBe(5);
    d.recordActions([{ name: "input_text", params: { index: 1, text: "B" } }]);
    expect(d.maxRepetitionCount).toBe(5);
  });

  it("trims the action window", () => {
    const d = new ActionLoopDetector(5);
    for (let i = 0; i < 10; i++) d.recordActions([{ name: "click", params: { index: i } }]);
    expect(d["recentActionHashes"].length).toBe(5);
  });
});
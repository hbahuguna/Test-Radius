import { describe, expect, it } from "vitest";
import { MessageManager, historyItemToString, makeHistoryItem } from "./message-manager.js";
import type { AgentOutput, AgentStepInfo } from "./views.js";
import type { ActionResult } from "./types.js";

const stepInfo = (n: number, max = 10): AgentStepInfo => ({ stepNumber: n, maxSteps: max });

function state(browser: { url: string; tabs?: { tabId: string; url: string; title: string }[] } = { url: "https://x.test/" }) {
  return {
    browser: {
      url: browser.url,
      title: "Page",
      domText: "[Start of page]\n[1]<a href=/x />\n[End of page]",
      tabs: browser.tabs ?? [{ tabId: "abcd", url: browser.url, title: "Page" }],
      screenshot: null,
    },
    actionsDescription: "navigate: go to a url. (url=string)\nclick: click by index. (index=integer)",
    readState: null,
    stepInfo: stepInfo(0),
  };
}

describe("MessageManager.buildStateMessage", () => {
  it("assembles all tagged sections in order", () => {
    const mm = new MessageManager("do the thing", "SYS");
    const text = mm.buildStateMessage(state());
    expect(text.indexOf("<user_request>")).toBeLessThan(text.indexOf("<agent_history>"));
    expect(text.indexOf("<agent_history>")).toBeLessThan(text.indexOf("<browser_state>"));
    expect(text.indexOf("<browser_state>")).toBeLessThan(text.indexOf("<page_specific_actions>"));
    expect(text.indexOf("<page_specific_actions>")).toBeLessThan(text.indexOf("<step_info>"));
    expect(text).toContain("Current URL: https://x.test/");
    expect(text).toContain("Tab abcd: https://x.test/");
    expect(text).toContain("Step1 maximum:10");
  });

  it("includes read_state only when present", () => {
    const mm = new MessageManager("task", "SYS");
    const without = mm.buildStateMessage(state());
    expect(without).not.toContain("<read_state>");
    const withRead = mm.buildStateMessage({ ...state(), readState: "extracted: foo" });
    expect(withRead).toContain("<read_state>\nextracted: foo");
  });

  it("appends context messages once then clears them", () => {
    const mm = new MessageManager("task", "SYS");
    mm.addContextMessage("BUDGET WARNING: 8/10 steps");
    const text = mm.buildStateMessage(state());
    expect(text).toContain("BUDGET WARNING");
    const text2 = mm.buildStateMessage(state());
    expect(text2).not.toContain("BUDGET WARNING");
  });
});

describe("MessageManager history trim", () => {
  it("keeps all items under the limit", () => {
    const mm = new MessageManager("task", "SYS", { maxHistoryItems: 6 });
    for (let i = 0; i < 3; i++) mm.addHistoryItem(makeHistoryItem(i, emptyOutput(), results()));
    expect(mm.buildStateMessage(state()).match(/<step_\{(\d+)\}>:/g)?.length).toBe(3);
  });

  it("omits the middle and keeps first + recent when over the limit", () => {
    const mm = new MessageManager("task", "SYS", { maxHistoryItems: 6 });
    for (let i = 0; i < 10; i++) mm.addHistoryItem(makeHistoryItem(i, emptyOutput(), results()));
    const text = mm.buildStateMessage(state());
    expect(text).toContain("<step_{0}>:");
    expect(text).toContain("4 previous steps omitted");
    expect(text).toContain("<step_{9}>:");
    expect(text).not.toContain("<step_{4}>:");
  });

  it("rejects maxHistoryItems <= 5", () => {
    expect(() => new MessageManager("t", "s", { maxHistoryItems: 5 })).toThrow();
  });
});

describe("historyItemToString", () => {
  it("renders evaluation, memory, next goal, and action results", () => {
    const item = makeHistoryItem(
      2,
      { evaluation_previous_goal: "clicked submit", memory: "form sent", next_goal: "wait", action: [] },
      [{ isDone: false, error: "timeout" }, { isDone: true, success: true, extractedContent: "ok" }],
    );
    const text = historyItemToString(item);
    expect(text).toContain("Evaluation of Previous Step: clicked submit");
    expect(text).toContain("Memory: form sent");
    expect(text).toContain("Next Goal: wait");
    expect(text).toContain("error: timeout");
    expect(text).toContain("done(success): ok");
  });
});

function emptyOutput(): AgentOutput {
  return { evaluation_previous_goal: "", memory: "", next_goal: "", action: [] };
}

function results(): ActionResult[] {
  return [{ isDone: false }];
}
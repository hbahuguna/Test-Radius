import { describe, expect, it } from "vitest";
import {
  CLICK,
  CLOSE_TAB,
  EVALUATE,
  EXTRACT,
  FIND_TEXT,
  GO_BACK,
  INPUT_TEXT,
  NAVIGATE,
  OPEN_TAB,
  SCREENSHOT,
  SCROLL,
  SWITCH_TAB,
  WAIT,
  doneAction,
} from "./actions.js";
import { fakeContext, FakePage } from "./test-utils.js";

describe("navigate", () => {
  it("navigates the page and does not finish", async () => {
    const page = new FakePage();
    const ctx = fakeContext({ page: page as never });
    const result = await NAVIGATE.execute(ctx, { url: "https://x.test/" });
    expect(page.navigateCalls).toEqual(["https://x.test/"]);
    expect(result).toEqual({ isDone: false });
    expect(NAVIGATE.terminatesSequence).toBe(true);
  });
});

describe("go_back", () => {
  it("calls history.back and settles on a URL change", async () => {
    const page = new FakePage();
    page.url = "https://x.test/second";
    const ctx = fakeContext({ page: page as never });
    const result = await GO_BACK.execute(ctx, {});
    expect(page.historyBacks + page.evaluated.length).toBeGreaterThan(0);
    expect(result.isDone).toBe(false);
  });
});

describe("click / input_text / scroll", () => {
  it("click resolves the index through the context selector map", async () => {
    const page = new FakePage();
    const ctx = fakeContext({
      page: page as never,
      resolveSelector: (i: number) => `#el-${i}`,
    });
    await CLICK.execute(ctx, { index: 7 });
    expect(page.clicks).toEqual(["#el-7"]);
  });

  it("input_text fills the resolved selector", async () => {
    const page = new FakePage();
    const ctx = fakeContext({ page: page as never });
    await INPUT_TEXT.execute(ctx, { index: 2, text: "hello" });
    expect(page.fills).toEqual([{ selector: '[data-qf-index="2"]', text: "hello" }]);
  });

  it("scroll by index scrolls the element; by direction scrolls the window", async () => {
    const page = new FakePage();
    const ctx = fakeContext({ page: page as never });
    await SCROLL.execute(ctx, { index: 3 });
    expect(page.scrolls).toEqual(['[data-qf-index="3"]']);
    await SCROLL.execute(ctx, { direction: "down" });
    expect(page.evaluated).toContainEqual([1]);
    await SCROLL.execute(ctx, { direction: "up" });
    expect(page.evaluated).toContainEqual([-1]);
  });
});

describe("wait", () => {
  it("sleeps for the requested ms", async () => {
    const started = Date.now();
    await WAIT.execute({} as never, { ms: 30 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe("tabs", () => {
  it("open_tab delegates to the context and terminates", async () => {
    let opened: string | undefined;
    const ctx = fakeContext({ openTab: async (u?: string) => { opened = u; } });
    await OPEN_TAB.execute(ctx, { url: "https://new.test" });
    expect(opened).toBe("https://new.test");
    expect(OPEN_TAB.terminatesSequence).toBe(true);
  });

  it("switch_tab and close_tab delegate by tab id", async () => {
    const switched: string[] = [];
    const closed: string[] = [];
    const ctx = fakeContext({
      switchTab: async (id: string) => { switched.push(id); },
      closeTab: async (id: string) => { closed.push(id); },
    });
    await SWITCH_TAB.execute(ctx, { tab_id: "abcd" });
    await CLOSE_TAB.execute(ctx, { tab_id: "abcd" });
    expect(switched).toEqual(["abcd"]);
    expect(closed).toEqual(["abcd"]);
  });
});

describe("screenshot", () => {
  it("attaches the base64 image", async () => {
    const page = new FakePage();
    const result = await SCREENSHOT.execute(fakeContext({ page: page as never }), {});
    expect(result.images).toEqual([{ name: "current-page", data: "ZmFrZXBuZw==" }]);
  });
});

describe("evaluate", () => {
  it("returns the serialized value as extracted content", async () => {
    const page = new FakePage();
    page.scriptedEvaluate.push({ a: 1 });
    const ctx = fakeContext({ page: page as never });
    const result = await EVALUATE.execute(ctx, { code: "({a: 1})" });
    expect(result.extractedContent).toContain('"a"');
  });
});

describe("find_text", () => {
  it("reports matches via evaluate", async () => {
    const page = new FakePage();
    page.scriptedEvaluate.push([{ tag: "a", text: "Search results" }]);
    const ctx = fakeContext({ page: page as never });
    const result = await FIND_TEXT.execute(ctx, { text: "results" });
    expect(result.extractedContent).toContain("Search results");
  });
});

describe("extract", () => {
  it("returns page text without an LLM", async () => {
    const page = new FakePage();
    page.scriptedEvaluate.push("some page text here");
    const result = await EXTRACT.execute(fakeContext({ page: page as never }), {
      goal: "the email",
    });
    expect(result.extractedContent).toBe("some page text here");
    expect(result.includeExtractedContentOnlyOnce).toBe(true);
  });

  it("runs a focused LLM extraction when an llm is wired", async () => {
    const page = new FakePage();
    page.scriptedEvaluate.push("raw page content");
    const llm = {
      async chat(messages: { role: string; content: string }[]) {
        expect(messages[0].content).toContain('Goal: "the email"');
        return { text: '{"extracted": "a@b.co"}' };
      },
    };
    const ctx = fakeContext({ page: page as never, llm: llm as never });
    const result = await EXTRACT.execute(ctx, { goal: "the email" });
    expect(result.extractedContent).toBe("a@b.co");
  });
});

describe("done", () => {
  it("finishes the session with success and a summary", async () => {
    const done = doneAction();
    const result = await done.execute({} as never, {
      success: true,
      text: "Found it.",
    });
    expect(result).toEqual({
      isDone: true,
      success: true,
      extractedContent: "Found it.",
    });
    expect(done.terminatesSequence).toBe(true);
  });
});

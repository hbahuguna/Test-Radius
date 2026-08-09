import { describe, expect, it } from "vitest";
import {
  browserGenerateStagehandScript,
  toStagehandTrace,
} from "../browser-trace-adapter";
import type { GeneratedTraceStep } from "../playwright-script";

const clickStep = (over: Partial<GeneratedTraceStep> = {}): GeneratedTraceStep => ({
  stepNumber: 1,
  url: "https://example.com/",
  title: "Example",
  actions: [{
    action: "click_element(index=0)",
    raw: { click_element: { index: 0 } },
    element: { ax_name: "Search", node_name: "button", x_path: "/html/body/button", attributes: {} },
  }],
  ...over,
});

describe("toStagehandTrace", () => {
  it("maps a click_element into a Stagehand act with a semantic description", () => {
    const trace = toStagehandTrace([clickStep()]);
    expect(trace).toHaveLength(1);
    const action = trace[0].actions[0];
    expect(action.type).toBe("act");
    expect(action.action).toContain("click");
    expect(action.action).toContain("Search button");
  });

  it("falls back to xpath when no accessible name exists", () => {
    const trace = toStagehandTrace([
      clickStep({ actions: [{ action: "click_element", raw: { click_element: {} }, element: { node_name: "div", x_path: "/html/body/div[1]", attributes: {} } }] }),
    ]);
    expect(trace[0].actions[0].action).toBe("click");
    expect(trace[0].actions[0].selector).toBe("xpath=/html/body/div[1]");
  });

  it("maps input_text with a label and preserves the value", () => {
    const trace = toStagehandTrace([{
      stepNumber: 1,
      url: "https://example.com/",
      title: null,
      actions: [{
        action: "input_text",
        raw: { input_text: { text: "{{TEST_VALUE}}" } },
        element: { node_name: "input", ax_name: "Username", x_path: "/html/body/input", attributes: { "aria-label": "Username" } },
      }],
    }]);
    const action = trace[0].actions[0];
    expect(action.action).toContain('type "{{TEST_VALUE}}" into Username');
    expect(action.value).toBe("{{TEST_VALUE}}");
  });

  it("maps raw click with no element to a locator-less click (warning handled downstream)", () => {
    const trace = toStagehandTrace([
      { stepNumber: 1, url: "https://example.com/", title: null, actions: [{ action: "click_element", raw: { click_element: {} }, element: null }] },
    ]);
    expect(trace[0].actions[0].selector).toBeUndefined();
  });
});

describe("browserGenerateStagehandScript", () => {
  it("produces runnable Playwright code with a root navigation and final waitForURL", () => {
    const steps: GeneratedTraceStep[] = [
      { stepNumber: 1, url: "https://example.com/", title: "Example", actions: [] },
      clickStep({
        stepNumber: 2,
        url: "https://example.com/results",
        title: "Results",
      }),
    ];
    const result = browserGenerateStagehandScript("https://example.com", "click search", steps);
    expect(result.code).toContain("export default async function run");
    expect(result.code).toContain("page.goto");
    expect(result.code).toContain("waitForURL");
  });

  it("keeps redacted values out of the rendered selector", () => {
    const steps: GeneratedTraceStep[] = [
      {
        stepNumber: 1,
        url: "https://example.com/",
        title: null,
        actions: [{
          action: "input_text",
          raw: { input_text: { text: "{{TEST_VALUE}}" } },
          element: { node_name: "input", ax_name: "Password", attributes: { "aria-label": "Password" } },
        }],
      },
    ];
    const result = browserGenerateStagehandScript("https://example.com", "login", steps);
    expect(result.code).toContain("TEST_VALUE");
  });
});
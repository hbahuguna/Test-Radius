import { describe, expect, it } from "vitest";
import { generateStagehandPlaywrightScript } from "../stagehand-playwright";

describe("generateStagehandPlaywrightScript", () => {
  it("translates recorded Stagehand click and fill actions", () => {
    const result = generateStagehandPlaywrightScript(
      "https://example.com",
      "Search for a product",
      [{
        stepNumber: 1,
        url: "https://example.com",
        actions: [
          { type: "act", action: "click", selector: "button.search" },
          { type: "act", action: "fill", selector: "input[name=q]", value: "shoes" },
        ],
      }],
    );

    expect(result.code).toContain('page.locator("button.search").click()');
    expect(result.code).toContain('page.locator("input[name=q]").fill');
    expect(result.warnings).toEqual([]);
  });

  it("reports missing selectors instead of inventing locators", () => {
    const result = generateStagehandPlaywrightScript(
      "https://example.com",
      "Click the button",
      [{ stepNumber: 1, url: "https://example.com", actions: [{ type: "act", action: "click" }] }],
    );

    expect(result.code).toContain("TODO: add a stable locator");
    expect(result.warnings).toContain("A Stagehand click action did not include a selector.");
  });

  it("translates semantic act instructions and keyboard navigation", () => {
    const result = generateStagehandPlaywrightScript(
      "https://example.com",
      "Click the Learn more link",
      [{
        stepNumber: 1,
        url: "https://example.com/",
        actions: [
          { type: "act", action: "click the Learn more link", pageUrl: "https://example.com/" },
          { type: "keys", method: "press", value: "Enter", pageUrl: "https://www.iana.org/help/example-domains" },
        ],
      }],
    );

    expect(result.code).toContain('page.getByRole("link", { name: "Learn more" }).click()');
    expect(result.code).toContain('page.keyboard.press("Enter")');
    expect(result.code).toContain('page.waitForURL("https://www.iana.org/help/example-domains")');
  });

  it("handles select, checkbox, keyboard press, focus and hover with actionArgs", () => {
    const result = generateStagehandPlaywrightScript(
      "https://example.com",
      "Book a flight",
      [{
        stepNumber: 1,
        url: "https://example.com/",
        actions: [
          { type: "act", action: "select", actionArgs: { selector: "select.trip", value: "Round trip" } },
          { type: "act", action: "check", actionArgs: { selector: "input.datepicker" } },
          { type: "keys", actionArgs: { key: "Enter" } },
          { type: "act", action: "hover", actionArgs: { selector: "button.search" } },
          { type: "act", action: "press", actionArgs: { key: "Tab" } },
        ],
      }],
    );

    expect(result.code).toContain('page.locator("select.trip").selectOption("Round trip")');
    expect(result.code).toContain('page.locator("input.datepicker").check()');
    expect(result.code).toContain('page.keyboard.press("Enter")');
    expect(result.code).toContain('page.locator("button.search").hover()');
    expect(result.code).toContain('page.keyboard.press("Tab")');
    expect(result.warnings.length).toBe(0);
  });

  it("generates an assertion step from structured output", () => {
    const result = generateStagehandPlaywrightScript(
      "https://www.google.com/travel/flights",
      "Find the cheapest flight from NYC to London",
      [{
        stepNumber: 1,
        url: "https://www.google.com/travel/flights",
        actions: [{ type: "act", action: "click", actionArgs: { selector: "button.search" } }],
      }],
      { price: "$199", airline: "Delta", departureTime: "8:00 AM" },
    );

    expect(result.code).toContain('page.getByText("$199", { exact: false })');
    expect(result.code).toContain("assert price");
    expect(result.code).toContain("assert airline");
  });

  it("uses Stagehand descriptions when act has no selector", () => {
    const result = generateStagehandPlaywrightScript(
      "https://example.com",
      "Click the Learn more link",
      [{
        stepNumber: 1,
        url: "https://example.com/",
        actions: [{
          type: "act",
          action: "click",
          description: "I can see the Learn more link. Let me click it.",
          pageUrl: "https://example.com/",
        }],
      }],
    );

    expect(result.code).toContain('page.getByRole("link", { name: "Learn more" }).click()');
    expect(result.warnings).toEqual([]);
  });
});

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

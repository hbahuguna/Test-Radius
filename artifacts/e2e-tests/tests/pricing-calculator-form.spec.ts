import { test, expect } from "../fixtures/test";
import { PricingPage } from "../pages/PricingPage";

test.describe("Pricing Page - Team Cost Calculator Form", () => {
  test.beforeEach(async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await pricing.getCalculatorSection().scrollIntoViewIfNeeded();
  });

  test("calculator form renders with all elements visible", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await expect(pricing.getCalculatorSection()).toBeVisible();
    await expect(pricing.getCalculatorDevCountLabel()).toBeVisible();
    await expect(pricing.getCalculatorSlider()).toBeVisible();
    await expect(pricing.getCalculatorDevCountValue()).toBeVisible();
    await expect(pricing.getCalculatorTierRow("starter")).toBeVisible();
    await expect(pricing.getCalculatorTierRow("growth")).toBeVisible();
    await expect(pricing.getCalculatorTierRow("scale")).toBeVisible();
    await expect(pricing.getCalculatorTierRow("enterprise")).toBeVisible();
  });

  test("default state at dev count 10 shows correct tiers and best value", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await expect(pricing.getCalculatorDevCountValue()).toHaveText("10");
    await expect(pricing.getCalculatorTierNotInRange("starter")).toBeVisible();
    await expect(
      pricing.getCalculatorTierRow("growth").getByText("Best Value"),
    ).toBeVisible();
    await expect(pricing.getCalculatorTierNotInRange("scale")).toBeVisible();
    await expect(
      pricing.getCalculatorTierNotInRange("enterprise"),
    ).toBeVisible();
  });

  test("adjusting slider to 3 devs updates calculator correctly", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.setSliderValue(3);
    await expect(pricing.getCalculatorDevCountValue()).toHaveText("3");
    await expect(
      pricing.getCalculatorTierRow("starter").getByText("Best Value"),
    ).toBeVisible();
    await expect(pricing.getCalculatorTierNotInRange("growth")).toBeVisible();
    await expect(pricing.getCalculatorTierNotInRange("scale")).toBeVisible();
    await expect(
      pricing.getCalculatorTierNotInRange("enterprise"),
    ).toBeVisible();
  });

  test("adjusting slider to 50 devs shows scale as best value", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.setSliderValue(50);
    await expect(pricing.getCalculatorDevCountValue()).toHaveText("50");
    await expect(pricing.getCalculatorTierNotInRange("starter")).toBeVisible();
    await expect(pricing.getCalculatorTierNotInRange("growth")).toBeVisible();
    await expect(
      pricing.getCalculatorTierRow("scale").getByText("Best Value"),
    ).toBeVisible();
    await expect(
      pricing.getCalculatorTierNotInRange("enterprise"),
    ).toBeVisible();
  });

  test("adjusting slider to 90 devs shows enterprise as best value", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.setSliderValue(90);
    await expect(pricing.getCalculatorDevCountValue()).toHaveText("90");
    await expect(pricing.getCalculatorTierNotInRange("starter")).toBeVisible();
    await expect(pricing.getCalculatorTierNotInRange("growth")).toBeVisible();
    await expect(pricing.getCalculatorTierNotInRange("scale")).toBeVisible();
    await expect(
      pricing.getCalculatorTierRow("enterprise").getByText("Best Value"),
    ).toBeVisible();
  });

  test("slider adjusts via keyboard interaction", async ({ page }) => {
    const pricing = new PricingPage(page);
    const slider = pricing.getCalculatorSlider();
    await slider.focus();
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(pricing.getCalculatorDevCountValue()).toHaveText("3");
  });
});

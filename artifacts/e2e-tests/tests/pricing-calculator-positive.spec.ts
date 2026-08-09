import { test, expect } from "../fixtures/test";
import { PricingPage } from "../pages/PricingPage";

test.describe("Pricing Page - Team Cost Calculator Positive", () => {
  test("clicking calculator heading reveals form with all elements", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();

    await pricing.getCalculatorSection().click();
    await expect(pricing.getCalculatorSection()).toBeVisible();

    await expect(pricing.getCalculatorDevCountLabel()).toBeVisible();
    await expect(pricing.getCalculatorSlider()).toBeVisible();
    await expect(pricing.getCalculatorDevCountValue()).toBeVisible();

    await expect(pricing.getCalculatorTierRow("starter")).toBeVisible();
    await expect(pricing.getCalculatorTierRow("growth")).toBeVisible();
    await expect(pricing.getCalculatorTierRow("scale")).toBeVisible();
    await expect(pricing.getCalculatorTierRow("enterprise")).toBeVisible();

    await expect(pricing.getBestValueBadge()).toBeVisible();
  });
});

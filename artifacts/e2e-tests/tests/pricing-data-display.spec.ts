import { test, expect } from "../fixtures/test";
import { PricingPage } from "../pages/PricingPage";

test.describe("Pricing Page - Data Display", () => {
  test("toggles billing and starts trial across multiple cycles", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();

    const monthlyPrices: Record<string, string> = {
      Free: "$0",
      Starter: "$79",
      Growth: "$25",
      Scale: "$19",
      Enterprise: "From $1,499",
    };

    const annualPrices: Record<string, string> = {
      Free: "$0",
      Starter: "$790",
      Growth: "$250",
      Scale: "$190",
      Enterprise: "From $1,499",
    };

    const isAnnualIteration = (i: number) => i % 2 === 0;

    for (let i = 0; i < 5; i++) {
      await pricing.getBillingToggle().click();

      const expectedPrices = isAnnualIteration(i) ? annualPrices : monthlyPrices;
      await expect(pricing.getTierPrice("Free")).toHaveText(expectedPrices.Free);
      await expect(pricing.getTierPrice("Starter")).toHaveText(
        expectedPrices.Starter,
      );
      await expect(pricing.getTierPrice("Growth")).toHaveText(
        expectedPrices.Growth,
      );
      await expect(pricing.getTierPrice("Scale")).toHaveText(
        expectedPrices.Scale,
      );
      await expect(pricing.getTierPrice("Enterprise")).toHaveText(
        expectedPrices.Enterprise,
      );

      await pricing.getStartTrialButton().click();
      await expect(page.locator("#early-access-form")).toBeInViewport();
    }
  });
});

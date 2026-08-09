import { test, expect } from "../fixtures/test";
import { PricingPage } from "../pages/PricingPage";

test.describe("Pricing Page - Payment", () => {
  test("billing toggle switches between monthly and annual pricing correctly", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();

    await expect(pricing.getBillingToggle()).toBeVisible();
    await expect(pricing.getBillingLabel("monthly")).toBeVisible();
    await expect(pricing.getBillingLabel("annual")).toBeVisible();
    await expect(pricing.getSaveBadge()).toBeVisible();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$79");
    await expect(pricing.getTierPrice("Growth")).toHaveText("$25");
    await expect(pricing.getTierPrice("Scale")).toHaveText("$19");

    await pricing.getBillingToggle().click();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$790");
    await expect(pricing.getTierPrice("Growth")).toHaveText("$250");
    await expect(pricing.getTierPrice("Scale")).toHaveText("$190");

    await pricing.getBillingToggle().click();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$79");
    await expect(pricing.getTierPrice("Growth")).toHaveText("$25");
    await expect(pricing.getTierPrice("Scale")).toHaveText("$19");

    await pricing.getBillingToggle().click();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$790");

    await pricing.getBillingToggle().click();

    await expect(pricing.getTierPrice("Growth")).toHaveText("$25");

    await pricing.getBillingToggle().click();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$790");

    await pricing.getBillingToggle().click();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$79");
  });

  test("free and enterprise prices stay unchanged when toggling billing", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();

    await expect(pricing.getTierPrice("Free")).toHaveText("$0");
    await expect(pricing.getTierPrice("Enterprise")).toHaveText("From $1,499");

    for (let i = 0; i < 3; i++) {
      await pricing.getBillingToggle().click();
      await expect(pricing.getTierPrice("Free")).toHaveText("$0");
      await expect(pricing.getTierPrice("Enterprise")).toHaveText("From $1,499");
    }
  });

  test("annual price hint text appears on paid tiers in annual mode", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();

    expect(await pricing.getAnnualPriceText("Starter")).toBeVisible();
    expect(await pricing.getAnnualPriceText("Growth")).toBeVisible();
    expect(await pricing.getAnnualPriceText("Scale")).toBeVisible();

    await pricing.getBillingToggle().click();

    await expect(pricing.getAnnualPriceText("Starter")).toBeVisible();
    await expect(pricing.getAnnualPriceText("Growth")).toBeVisible();
    await expect(pricing.getAnnualPriceText("Scale")).toBeVisible();

    await pricing.getBillingToggle().click();

    await expect(pricing.getAnnualPriceText("Starter")).toBeVisible();
  });

  test("switches billing via getByLabel locator", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();

    await expect(pricing.getBillingToggleLabel()).toBeVisible();
    await expect(pricing.getBillingToggle()).toBeVisible();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$79");
    await expect(pricing.getTierPrice("Growth")).toHaveText("$25");
    await expect(pricing.getTierPrice("Scale")).toHaveText("$19");

    await pricing.getBillingToggleLabel().click();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$790");
    await expect(pricing.getTierPrice("Growth")).toHaveText("$250");
    await expect(pricing.getTierPrice("Scale")).toHaveText("$190");

    await pricing.getBillingToggleLabel().click();

    await expect(pricing.getTierPrice("Starter")).toHaveText("$79");
    await expect(pricing.getTierPrice("Growth")).toHaveText("$25");
    await expect(pricing.getTierPrice("Scale")).toHaveText("$19");
  });
});

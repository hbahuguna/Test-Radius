import { test, expect } from "../fixtures/test";
import { PricingPage } from "../pages/PricingPage";
import { mockWeb3FormsSuccess } from "../fixtures/mocks";

test.describe("Pricing Page - Early Access Flow", () => {
  test("billing toggle, start trial, fill email, request early access, and reset form", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();

    await expect(pricing.getBillingToggle()).toBeVisible();
    await pricing.getBillingToggle().click();
    await expect(pricing.getTierPrice("Starter")).toHaveText("$790");

    await pricing.getStartTrialButton().click();
    await expect(pricing.getEmailInput()).toBeInViewport();

    await mockWeb3FormsSuccess(page);

    await pricing.getEmailInput().fill("engineer@company.com");
    await expect(pricing.getEmailInput()).toHaveValue("engineer@company.com");

    await pricing.getRequestEarlyAccessButton().click();
    await expect(pricing.getSuccessMessage()).toBeVisible();

    await pricing.getSubmitAnotherButton().click();
    await expect(pricing.getEmailInput()).toBeVisible();
    await expect(pricing.getEmailInput()).toHaveValue("");
  });
});

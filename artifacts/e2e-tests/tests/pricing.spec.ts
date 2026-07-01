import { test, expect } from "../fixtures/test";
import { PricingPage } from "../pages/PricingPage";
import { ROUTES, NAV_LABELS } from "../fixtures/test-data";

test.describe("Pricing Page", () => {
  test("page loads with correct heading", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getHeroHeading()).toBeVisible();
  });

  test("all five tier cards are visible with correct names", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("Free", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("Starter", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Growth", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Scale", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Enterprise", { exact: true }).first(),
    ).toBeVisible();
  });

  test("growth card displays correct monthly price", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("$25", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("/dev / month").first()).toBeVisible();
  });

  test("free shows $0 forever", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getTierCard("Free")).toBeVisible();
    await expect(pricing.getTierPrice("Free")).toHaveText("$0");
  });

  test("enterprise shows from $1,499 pricing", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(
      page.getByText("Enterprise", { exact: true }).first(),
    ).toBeVisible();
    await expect(pricing.getTierPrice("Enterprise")).toHaveText("From $1,499");
  });

  test("most popular badge is visible on growth card", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getMostPopularBadge()).toBeVisible();
  });

  test("30-day money back guarantee is displayed", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getGuaranteeBadge()).toBeVisible();
  });

  test("growth card has developer range text", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("6–25 developers").first()).toBeVisible();
  });

  test("headline mentions teams of every size", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getHeroHeading()).toHaveText(/teams of every size/);
  });

  test("pricing accessible from header navigation", async ({ page }) => {
    await page.goto("/");
    await page.locator(`nav a[href='${ROUTES.PRICING}']`).click();
    await expect(page).toHaveURL(ROUTES.PRICING);
  });

  test("back to home navigation works", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await page.locator("nav a[href='/']").first().click();
    await expect(page).toHaveURL("/");
  });

  test("growth card scrolls to early access form on button click", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await page.getByRole("button", { name: "Start Trial" }).first().click();
    await expect(page.locator("#early-access-form")).toBeInViewport();
  });

  test("free card has get started free button", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(
      page.getByRole("button", { name: "Get Started Free" }),
    ).toBeVisible();
  });

  test("starter and growth cards have start trial button", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    const buttons = page.getByRole("button", { name: "Start Trial" });
    await expect(buttons).toHaveCount(3);
  });

  test("enterprise card has contact sales button", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(
      page.getByRole("button", { name: "Contact Sales" }),
    ).toBeVisible();
  });

  test("faq accordion expands and collapses", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("Frequently asked questions")).toBeVisible();
    await pricing
      .getFaqAccordionTrigger("Can I start with the Free plan")
      .click();
    await expect(
      page.getByText(/The Free plan is yours forever/),
    ).toBeVisible();
    await pricing
      .getFaqAccordionTrigger("Can I start with the Free plan")
      .click();
    await expect(
      page.getByText(/The Free plan is yours forever/),
    ).not.toBeVisible();
  });

  test("all pricing feature checkmarks are visible", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(
      page.getByText("Full shadow mode analysis", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Up to 5 developers", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Explainability dashboard"),
    ).toBeVisible();
    await expect(page.getByText("Advanced analytics")).toBeVisible();
    await expect(
      page.getByText("Dedicated account manager"),
    ).toBeVisible();
  });

  test("layout renders early access form at bottom", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.locator("#early-access-form")).toBeVisible();
    const emailInput = page.locator(
      "#early-access-form input[type='email']",
    );
    await expect(emailInput).toBeVisible();
  });

  test("billing toggle shows annual prices when switched on", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getTierPrice("Starter")).toHaveText("$79");
    await pricing.getBillingToggle().click();
    await expect(pricing.getTierPrice("Starter")).toHaveText("$790");
    await expect(
      pricing.getTierCard("Starter").getByText("2 months free"),
    ).toBeVisible();
  });

  test("billing toggle restores monthly prices when switched back", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await pricing.getBillingToggle().click();
    await expect(pricing.getTierPrice("Starter")).toHaveText("$790");
    await pricing.getBillingToggle().click();
    await expect(pricing.getTierPrice("Starter")).toHaveText("$79");
  });

  test("free card shows $0 regardless of billing toggle", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getTierPrice("Free")).toHaveText("$0");
    await pricing.getBillingToggle().click();
    await expect(pricing.getTierPrice("Free")).toHaveText("$0");
  });

  test("enterprise card shows from $1,499 regardless of toggle", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getTierPrice("Enterprise")).toHaveText(
      "From $1,499",
    );
    await pricing.getBillingToggle().click();
    await expect(pricing.getTierPrice("Enterprise")).toHaveText(
      "From $1,499",
    );
  });

  test("comparison table is visible with competitor rows", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getComparisonTable()).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "Explainable AI" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Launchable" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "DIY Scripts" }),
    ).toBeVisible();
  });

  test("calculator shows best value badge for recommended tier", async ({
    page,
  }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getDeveloperCount()).toBeVisible();
    await expect(pricing.getCalculatorSlider()).toBeVisible();
    await expect(pricing.getCalculatorTierRow("growth")).toBeVisible();
    await expect(pricing.getBestValueBadge()).toBeVisible();
  });
});

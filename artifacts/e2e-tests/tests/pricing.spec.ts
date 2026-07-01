import { test, expect } from "../fixtures/test";
import { PricingPage } from "../pages/PricingPage";
import { ROUTES, NAV_LABELS } from "../fixtures/test-data";

test.describe("Pricing Page", () => {
  test("page loads with correct heading", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getHeroHeading()).toBeVisible();
  });

  test("all three tier cards are visible with correct names", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("Shadow Mode", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Team", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Enterprise", { exact: true }).first()).toBeVisible();
  });

  test("team card displays correct monthly price", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("$29", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("per seat / month")).toBeVisible();
  });

  test("shadow mode shows free forever", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByRole("heading", { name: "Shadow Mode" })).toBeVisible();
    await expect(page.getByText("$0")).toBeVisible();
    await expect(page.getByText("forever")).toBeVisible();
  });

  test("enterprise shows custom pricing", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("Enterprise", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Custom", { exact: true }).first()).toBeVisible();
  });

  test("most popular badge is visible on team card", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getMostPopularBadge()).toBeVisible();
  });

  test("30-day money back guarantee is displayed", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getGuaranteeBadge()).toBeVisible();
  });

  test("team card has 5 seat minimum text", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("5 seat minimum")).toBeVisible();
  });

  test("headline mentions plans for every team", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(pricing.getHeroHeading()).toContainText("every team");
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

  test("team card scrolls to early access form on button click", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await page.getByRole("button", { name: "Start Free Trial" }).click();
    await expect(page.locator("#early-access-form")).toBeInViewport();
  });

  test("shadow mode card has get started free button", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByRole("button", { name: "Get Started Free" })).toBeVisible();
  });

  test("team card has start free trial button", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByRole("button", { name: "Start Free Trial" })).toBeVisible();
  });

  test("enterprise card has contact sales button", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByRole("button", { name: "Contact Sales" })).toBeVisible();
  });

  test("faq accordion expands and collapses", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("Frequently asked questions")).toBeVisible();
    await pricing.getFaqAccordionTrigger("Why a 5-seat minimum").click();
    await expect(page.getByText(/We serve engineering teams/)).toBeVisible();
    await pricing.getFaqAccordionTrigger("Why a 5-seat minimum").click();
    await expect(page.getByText(/We serve engineering teams/)).not.toBeVisible();
  });

  test("all pricing feature checkmarks are visible", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.getByText("Free shadow-mode analysis")).toBeVisible();
    await expect(page.getByText("5 analyses per month")).toBeVisible();
    await expect(page.getByText("Unlimited shadow-mode analyses")).toBeVisible();
    await expect(page.getByText("SSO & SAML")).toBeVisible();
    await expect(page.getByText("Dedicated account manager")).toBeVisible();
  });

  test("layout renders early access form at bottom", async ({ page }) => {
    const pricing = new PricingPage(page);
    await pricing.goto();
    await expect(page.locator("#early-access-form")).toBeVisible();
    const emailInput = page.locator("#early-access-form input[type='email']");
    await expect(emailInput).toBeVisible();
  });
});

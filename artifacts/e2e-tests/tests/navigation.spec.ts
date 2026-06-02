import { test, expect } from "../fixtures/test";

test.describe("Navigation", () => {
  test("header logo links to home page", async ({ page }) => {
    await page.goto("/blog");
    await page.locator("nav a[href='/']").first().click();
    await expect(page).toHaveURL("/");
  });

  test("Blog link navigates to /blog", async ({ page }) => {
    await page.goto("/");
    await page.locator("nav a[href='/blog']").click();
    await expect(page).toHaveURL("/blog");
  });

  test("Careers link navigates to /jobs", async ({ page }) => {
    await page.goto("/");
    await page.locator("nav a[href='/jobs']").click();
    await expect(page).toHaveURL("/jobs");
  });

  test("Get Early Access button scrolls to form", async ({ page }) => {
    await page.goto("/");
    const button = page.locator("nav").getByRole("button", { name: "Get Early Access" });
    await button.click();
    await expect(page.locator("#early-access-form")).toBeInViewport();
  });

  test("Join Pilot button scrolls to form", async ({ page }) => {
    await page.goto("/");
    const button = page.locator("nav").getByRole("button", { name: "Join Pilot" });
    await button.click();
    await expect(page.locator("#early-access-form")).toBeInViewport();
  });

  test("footer Careers link navigates to /jobs", async ({ page }) => {
    await page.goto("/");
    await page.locator("footer a[href='/jobs']").click();
    await expect(page).toHaveURL("/jobs");
  });

  test("footer Contact link is mailto", async ({ page }) => {
    await page.goto("/");
    const contactLink = page.locator("footer a[href='mailto:hello@testradius.dev']");
    await expect(contactLink).toBeVisible();
  });

  test("footer shows copyright", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("footer")).toContainText("2025 TestRadius");
  });
});

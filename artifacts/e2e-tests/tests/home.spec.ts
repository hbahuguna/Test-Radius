import { test, expect } from "../fixtures/test";
import { HomePage } from "../pages/HomePage";

test.describe("Home Page", () => {
  let home: HomePage;

  test.beforeEach(async ({ page }) => {
    home = new HomePage(page);
    await home.goto();
  });

  test("hero section renders with tagline", async () => {
    await expect(home.getHeroHeading()).toBeVisible();
    await expect(home.getPrivateBetaBadge()).toBeVisible();
  });

  test("Get Early Access hero CTA scrolls to form", async () => {
    await home.getGetEarlyAccessButton().click();
    await expect(home.page.locator("#early-access-form")).toBeInViewport();
  });

  test("Join the Pilot hero CTA scrolls to form", async () => {
    await home.getJoinThePilotButton().click();
    await expect(home.page.locator("#early-access-form")).toBeInViewport();
  });

  test("problem section displays three problem cards", async () => {
    const section = home.getProblemSection();
    await expect(section.getByText("Slow CI Pipelines")).toBeVisible();
    await expect(section.getByText("Flaky Test Noise")).toBeVisible();
    await expect(section.getByText("Release Bottlenecks")).toBeVisible();
  });

  test("solution section shows three steps", async () => {
    await expect(home.page.getByText("Map Code Changes")).toBeVisible();
    await expect(home.page.getByText("Select Impacted Tests")).toBeVisible();
    await expect(home.page.getByText("Eliminate Noise")).toBeVisible();
  });

  test("differentiation section shows three cards", async () => {
    const section = home.page.locator("section").filter({ hasText: "Why not just use" });
    await expect(section).toBeVisible();
    await expect(section.getByRole("heading", { name: "Running everything" })).toBeVisible();
    await expect(section.getByRole("heading", { name: "Black-box AI" })).toBeVisible();
    await expect(section.getByRole("heading", { name: "TestRadius" })).toBeVisible();
  });

  test("stat counters display", async () => {
    await expect(home.getStatDefaultRun()).toBeVisible();
    await expect(home.getStatTestRadius()).toBeVisible();
  });

  test("testimonial cards display", async () => {
    const testimonialSection = home.page.locator("section").filter({ hasText: "We tested it on massive codebases" });
    await expect(testimonialSection.getByText("Engineering Manager")).toBeVisible();
    await expect(testimonialSection.getByText("Staff Software Engineer")).toBeVisible();
  });

  test("latest articles section loads blog cards", async () => {
    await expect(home.getLatestArticlesSection()).toBeVisible();
    const cards = home.getBlogArticleCards();
    await expect(cards).toHaveCount(3);
  });

  test("View All Articles button navigates to /blog", async () => {
    await home.getViewAllArticlesButton().click();
    await expect(home.page).toHaveURL("/blog");
  });
});

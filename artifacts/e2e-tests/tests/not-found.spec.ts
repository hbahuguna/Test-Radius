import { test, expect } from "../fixtures/test";

test.describe("404 Page", () => {
  test("shows 404 for unknown route", async ({ page }) => {
    await page.goto("/this-does-not-exist");
    await expect(page.getByText("404: Not Found")).toBeVisible();
  });

  test("shows 404 for nonsense path", async ({ page }) => {
    await page.goto("/some/random/path");
    await expect(page.getByText("404: Not Found")).toBeVisible();
  });
});

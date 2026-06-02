import { test, expect } from "../fixtures/test";
import { mockWeb3FormsSuccess, mockWeb3FormsError } from "../fixtures/mocks";
import { FORM_DATA } from "../fixtures/test-data";

test.describe("Early Access Form", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator("#early-access-form").scrollIntoViewIfNeeded();
  });

  test("renders all form fields", async ({ page }) => {
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#company")).toBeVisible();
    await expect(page.locator("#role")).toBeVisible();
    await expect(page.getByRole("button", { name: "Request Early Access" })).toBeVisible();
  });

  test("submit with valid email shows success state", async ({ page }) => {
    await mockWeb3FormsSuccess(page);

    await page.locator("#email").fill(FORM_DATA.validEarlyAccess.email);
    await page.locator("#company").fill(FORM_DATA.validEarlyAccess.company);
    await page.locator("#role").fill(FORM_DATA.validEarlyAccess.role);
    await page.getByRole("button", { name: "Request Early Access" }).click();

    await expect(page.getByText("You're on the list.")).toBeVisible();
  });

  test("submit button is disabled when email is empty", async ({ page }) => {
    const submitBtn = page.getByRole("button", { name: "Request Early Access" });
    await expect(submitBtn).toBeDisabled();
  });

  test("submit with only email works with optional fields empty", async ({ page }) => {
    await mockWeb3FormsSuccess(page);

    await page.locator("#email").fill(FORM_DATA.validEarlyAccess.email);
    await page.getByRole("button", { name: "Request Early Access" }).click();

    await expect(page.getByText("You're on the list.")).toBeVisible();
  });

  test("shows submitting state while processing", async ({ page }) => {
    await page.route("https://api.web3forms.com/submit", async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });

    await page.locator("#email").fill(FORM_DATA.validEarlyAccess.email);
    await page.getByRole("button", { name: "Request Early Access" }).click();

    const submitBtn = page.getByRole("button", { name: "Submitting..." });
    await expect(submitBtn).toBeVisible();
  });

  test("shows error state when API returns error", async ({ page }) => {
    await mockWeb3FormsError(page);

    await page.locator("#email").fill(FORM_DATA.validEarlyAccess.email);
    await page.getByRole("button", { name: "Request Early Access" }).click();

    await expect(page.locator("form")).toContainText("Invalid email address");
  });

  test("reset after success works", async ({ page }) => {
    await mockWeb3FormsSuccess(page);

    await page.locator("#email").fill(FORM_DATA.validEarlyAccess.email);
    await page.getByRole("button", { name: "Request Early Access" }).click();
    await expect(page.getByText("You're on the list.")).toBeVisible();

    await page.getByRole("button", { name: "Submit another" }).click();
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#email")).toHaveValue("");
  });
});

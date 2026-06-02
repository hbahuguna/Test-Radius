import { Page } from "@playwright/test";
import { WEB3FORMS_URL, FORMSPREE_URL } from "./test-data";

export async function mockWeb3FormsSuccess(page: Page) {
  await page.route(WEB3FORMS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });
}

export async function mockWeb3FormsError(page: Page) {
  await page.route(WEB3FORMS_URL, async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ success: false, message: "Invalid email address" }),
    });
  });
}

export async function mockFormspreeSuccess(page: Page) {
  await page.route(FORMSPREE_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

export async function mockFormspreeError(page: Page) {
  await page.route(FORMSPREE_URL, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Server error" }),
    });
  });
}

export async function mockFormspreeNetworkError(page: Page) {
  await page.route(FORMSPREE_URL, async (route) => {
    await route.abort("internetdisconnected");
  });
}

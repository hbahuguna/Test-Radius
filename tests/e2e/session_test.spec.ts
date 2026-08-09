import { test, expect } from '@playwright/test';

test.describe('Form - Positive', () => {
  test('Test Submit Your Application Form, Applying For Freelance Fu', async ({ page }) => {
    await page.goto('https://testradius.dev/jobs');
    await expect(page).toHaveTitle(/./);

    // TODO: Add test steps

    // TODO: Add assertions
  });
});

import { test, expect } from '@playwright/test';

test.describe('Submit Application Form', () => {
  test('should fill and submit the application form for Freelance Full-Stack Developer', async ({ page }) => {
    // Navigate to the jobs page
    await page.goto('https://testradius.dev/jobs');

    // Wait for the application form to be visible
    const applyingForCombobox = page.getByRole('combobox', { name: 'Applying For' });
    await expect(applyingForCombobox).toBeVisible();

    // Select "Freelance Full-Stack Developer" from the Applying For dropdown
    await applyingForCombobox.selectOption({ label: 'Freelance Full-Stack Developer' });

    // Fill in First Name
    const firstNameInput = page.getByRole('textbox', { name: 'First Name' });
    await expect(firstNameInput).toBeVisible();
    await firstNameInput.fill('Himanshu');

    // Fill in Last Name
    const lastNameInput = page.getByRole('textbox', { name: 'Last Name' });
    await expect(lastNameInput).toBeVisible();
    await lastNameInput.fill('Bahuguna');

    // Fill in Email Address
    const emailInput = page.getByRole('textbox', { name: 'Email Address' }).first();
    await expect(emailInput).toBeVisible();
    await emailInput.fill('jdoe@example.com');

    // Fill in LinkedIn / GitHub / Portfolio
    const linkedinInput = page.getByRole('textbox', { name: 'LinkedIn / GitHub / Portfolio' });
    await expect(linkedinInput).toBeVisible();
    await linkedinInput.fill('https://www.linkedin.com/in/himanshu-bahuguna-latest/');

    // Fill in Cover Letter / Note
    const coverLetterInput = page.getByRole('textbox', { name: 'Cover Letter / Note' });
    await expect(coverLetterInput).toBeVisible();
    await coverLetterInput.fill('I am excited to apply for the Freelance Full-Stack Developer position. With extensive experience in both frontend and backend technologies, I am confident in my ability to deliver high-quality work and contribute effectively to your team.');

    // Fill in Link to Resume
    const resumeLinkInput = page.getByRole('textbox', { name: 'Link to Resume' });
    await expect(resumeLinkInput).toBeVisible();
    await resumeLinkInput.fill('https://www.linkedin.com/in/himanshu-bahuguna-latest/resume');

    // Click Submit Application button
    const submitButton = page.getByRole('button', { name: 'Submit Application' });
    await expect(submitButton).toBeVisible();
    await submitButton.click();

    // Assert success state - look for success message or confirmation
    // The page should show some confirmation after submission
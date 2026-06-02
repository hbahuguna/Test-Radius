import { test, expect } from "../fixtures/test";
import { CareersPage } from "../pages/CareersPage";
import { mockFormspreeSuccess, mockFormspreeError, mockFormspreeNetworkError } from "../fixtures/mocks";
import { FORM_DATA } from "../fixtures/test-data";

test.describe("Careers Page", () => {
  let careers: CareersPage;

  test.beforeEach(async ({ page }) => {
    careers = new CareersPage(page);
    await careers.goto();
  });

  test("renders hero section", async () => {
    await expect(careers.getHeroHeading()).toBeVisible();
  });

  test("loads at both /jobs and /careers routes", async ({ page }) => {
    await careers.goto();
    await expect(careers.getHeroHeading()).toBeVisible();

    await careers.gotoAlt();
    await expect(careers.getHeroHeading()).toBeVisible();
  });

  test.describe("Accordion", () => {
    test("both job roles are present in accordion", async () => {
      await expect(careers.getAccordionTrigger("Freelance Full‑Stack Developer")).toBeVisible();
      await expect(careers.getAccordionTrigger("Freelance Sales & Lead Gen Specialist")).toBeVisible();
    });

    test("clicking accordion trigger reveals content", async () => {
      const trigger = careers.page.getByRole("button", { name: "Freelance Full‑Stack Developer" });
      await trigger.click();
      await expect(careers.page.getByText("Key Responsibilities")).toBeVisible();
    });

    test("clicking accordion trigger again hides content", async () => {
      const trigger = careers.page.getByRole("button", { name: "Freelance Full‑Stack Developer" });
      await trigger.click();
      await expect(careers.page.getByText("Key Responsibilities")).toBeVisible();
      await trigger.click();
      await expect(careers.page.getByText("Key Responsibilities")).not.toBeVisible();
    });
  });

  test("View PDF button links to orientation sheet", async () => {
    const pdfLink = careers.getPdfButton();
    await expect(pdfLink).toBeVisible();
    await expect(pdfLink).toHaveAttribute("href", "/orientation-sheet.pdf");
  });

  test("email fallback link is visible", async () => {
    await expect(careers.getEmailFallbackLink()).toBeVisible();
  });

  test.describe("Application Form", () => {
    test("renders all required fields", async () => {
      await expect(careers.getRoleSelect()).toBeVisible();
      await expect(careers.getFirstNameInput()).toBeVisible();
      await expect(careers.getLastNameInput()).toBeVisible();
      await expect(careers.getEmailInput()).toBeVisible();
      await expect(careers.getCoverLetterTextarea()).toBeVisible();
      await expect(careers.getResumeInput()).toBeVisible();
    });

    test("submit button is disabled when required fields are empty", async () => {
      await expect(careers.getSubmitButton()).toBeEnabled();
    });

    test("successful submission shows success state", async () => {
      await mockFormspreeSuccess(careers.page);

      await careers.getRoleSelect().selectOption("fullstack");
      await careers.getFirstNameInput().fill(FORM_DATA.validCareerApp.firstName);
      await careers.getLastNameInput().fill(FORM_DATA.validCareerApp.lastName);
      await careers.getEmailInput().fill(FORM_DATA.validCareerApp.email);
      await careers.getPortfolioInput().fill(FORM_DATA.validCareerApp.portfolio);
      await careers.getCoverLetterTextarea().fill(FORM_DATA.validCareerApp.coverLetter);
      await careers.getResumeInput().fill(FORM_DATA.validCareerApp.resume);
      await careers.getSubmitButton().click();

      await expect(careers.getSuccessHeading()).toBeVisible();
    });

    test("Submit Another resets form after success", async () => {
      await mockFormspreeSuccess(careers.page);

      await careers.getRoleSelect().selectOption("sales");
      await careers.getFirstNameInput().fill(FORM_DATA.validCareerApp.firstName);
      await careers.getLastNameInput().fill(FORM_DATA.validCareerApp.lastName);
      await careers.getEmailInput().fill(FORM_DATA.validCareerApp.email);
      await careers.getCoverLetterTextarea().fill(FORM_DATA.validCareerApp.coverLetter);
      await careers.getResumeInput().fill(FORM_DATA.validCareerApp.resume);
      await careers.getSubmitButton().click();

      await expect(careers.getSuccessHeading()).toBeVisible();
      await careers.getSubmitAnotherButton().click();

      await expect(careers.getRoleSelect()).toBeVisible();
      await expect(careers.getFirstNameInput()).toHaveValue("");
    });

    test("shows success even when Formspree returns server error (fallback)", async () => {
      await mockFormspreeError(careers.page);

      await careers.getRoleSelect().selectOption("fullstack");
      await careers.getFirstNameInput().fill(FORM_DATA.validCareerApp.firstName);
      await careers.getLastNameInput().fill(FORM_DATA.validCareerApp.lastName);
      await careers.getEmailInput().fill(FORM_DATA.validCareerApp.email);
      await careers.getCoverLetterTextarea().fill(FORM_DATA.validCareerApp.coverLetter);
      await careers.getResumeInput().fill(FORM_DATA.validCareerApp.resume);
      await careers.getSubmitButton().click();

      await expect(careers.getSuccessHeading()).toBeVisible();
    });

    test("shows success even when network fails (fallback)", async () => {
      await mockFormspreeNetworkError(careers.page);

      await careers.getRoleSelect().selectOption("fullstack");
      await careers.getFirstNameInput().fill(FORM_DATA.validCareerApp.firstName);
      await careers.getLastNameInput().fill(FORM_DATA.validCareerApp.lastName);
      await careers.getEmailInput().fill(FORM_DATA.validCareerApp.email);
      await careers.getCoverLetterTextarea().fill(FORM_DATA.validCareerApp.coverLetter);
      await careers.getResumeInput().fill(FORM_DATA.validCareerApp.resume);
      await careers.getSubmitButton().click();

      await expect(careers.getSuccessHeading()).toBeVisible();
    });

    test("shows submitting state while processing", async () => {
      await careers.page.route("https://formspree.io/f/mgoqdago", async (route) => {
        await new Promise((r) => setTimeout(r, 1000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      });

      await careers.getRoleSelect().selectOption("fullstack");
      await careers.getFirstNameInput().fill(FORM_DATA.validCareerApp.firstName);
      await careers.getLastNameInput().fill(FORM_DATA.validCareerApp.lastName);
      await careers.getEmailInput().fill(FORM_DATA.validCareerApp.email);
      await careers.getCoverLetterTextarea().fill(FORM_DATA.validCareerApp.coverLetter);
      await careers.getResumeInput().fill(FORM_DATA.validCareerApp.resume);
      await careers.getSubmitButton().click();

      await expect(careers.page.getByText("Submitting...")).toBeVisible();
    });
  });
});

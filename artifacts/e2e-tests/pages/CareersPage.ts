import { Page, Locator } from "@playwright/test";

export class CareersPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto("/jobs");
  }

  async gotoAlt() {
    await this.page.goto("/careers");
  }

  getHeroHeading(): Locator {
    return this.page.getByRole("heading").filter({ hasText: "Build the future" });
  }

  getAccordionTrigger(name: string): Locator {
    return this.page.getByRole("button", { name });
  }

  getPdfButton(): Locator {
    return this.page.getByRole("link", { name: "View PDF" });
  }

  getApplicationForm(): Locator {
    return this.page.locator("form").filter({ hasText: "Submit Application" });
  }

  getRoleSelect(): Locator {
    return this.getApplicationForm().locator("#role");
  }

  getFirstNameInput(): Locator {
    return this.page.locator("#firstName");
  }

  getLastNameInput(): Locator {
    return this.page.locator("#lastName");
  }

  getEmailInput(): Locator {
    return this.getApplicationForm().locator("#email");
  }

  getPortfolioInput(): Locator {
    return this.page.locator("#portfolio");
  }

  getCoverLetterTextarea(): Locator {
    return this.page.locator("#coverLetter");
  }

  getResumeInput(): Locator {
    return this.page.locator("#resume");
  }

  getSubmitButton(): Locator {
    return this.getApplicationForm().getByRole("button", { name: "Submit Application" });
  }

  getSuccessHeading(): Locator {
    return this.page.getByRole("heading", { name: "Application Received!" });
  }

  getSubmitAnotherButton(): Locator {
    return this.page.getByRole("button", { name: "Submit Another" });
  }

  getEmailFallbackLink(): Locator {
    return this.page.getByRole("link", { name: "jobs@testradius.dev" });
  }
}

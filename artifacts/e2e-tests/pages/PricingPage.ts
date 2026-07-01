import { Page, Locator } from "@playwright/test";

export class PricingPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto("/pricing");
  }

  getHeroHeading(): Locator {
    return this.page.getByRole("heading", {
      name: /pricing for teams of every size/,
    });
  }

  getTierCard(tierName: string): Locator {
    return this.page.locator(`[data-tier="${tierName.toLowerCase()}"]`);
  }

  getTierPrice(tierName: string): Locator {
    return this.getTierCard(tierName).locator("span.font-extrabold").first();
  }

  getMostPopularBadge(): Locator {
    return this.page.getByText("Most Popular");
  }

  getCtaButton(tierName: string): Locator {
    return this.getTierCard(tierName).getByRole("button");
  }

  getBillingToggle(): Locator {
    return this.page.locator('button[role="switch"]');
  }

  getSaveBadge(): Locator {
    return this.page.getByText("Save 17%");
  }

  getComparisonTable(): Locator {
    return this.page.locator("table");
  }

  getComparisonRow(feature: string): Locator {
    return this.page.getByRole("cell", { name: feature });
  }

  getCalculatorSlider(): Locator {
    return this.page.locator('[role="slider"]');
  }

  getCalculatorTierRow(tierName: string): Locator {
    return this.page.locator(
      `[data-calculator-tier="${tierName.toLowerCase()}"]`,
    );
  }

  getBestValueBadge(): Locator {
    return this.page.getByText("Best Value");
  }

  getDeveloperCount(): Locator {
    return this.page.locator("text=Developer count:");
  }

  getFaqAccordionTrigger(question: string): Locator {
    return this.page.getByRole("button", { name: question });
  }

  getGuaranteeBadge(): Locator {
    return this.page.getByText("30-day money-back guarantee");
  }
}

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

  getHeroBadge(): Locator {
    return this.page.getByText("Launch pricing");
  }

  getHeroSubtitle(): Locator {
    return this.page.getByText(
      /Stop wasting time on flaky tests/,
    );
  }

  getAnnualPriceText(tierName: string): Locator {
    return this.getTierCard(tierName).getByText(/\/year billed annually/);
  }

  getCalculatorNotInRange(): Locator {
    return this.page.getByText("Not in range").first();
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
    return this.page.getByRole("switch");
  }

  getBillingLabel(period: "monthly" | "annual"): Locator {
    return this.page.getByText(`Pay ${period}`);
  }

  getBillingToggleLabel(): Locator {
    return this.page.getByLabel("Pay monthlyPay annuallySave 17%");
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
    return this.page.getByRole("slider");
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

  getCalculatorSection(): Locator {
    return this.page.getByRole("heading", { name: "Team Cost Calculator" });
  }

  getCalculatorDevCountLabel(): Locator {
    return this.page.getByText("Developer count:");
  }

  getCalculatorDevCountValue(): Locator {
    return this.page.locator("span.text-2xl.font-bold").first();
  }

  getCalculatorTierCost(tierName: string): Locator {
    return this.getCalculatorTierRow(tierName).locator("span.font-bold");
  }

  getCalculatorTierNotInRange(tierName: string): Locator {
    return this.getCalculatorTierRow(tierName).getByText("Not in range");
  }

  async setSliderValue(value: number) {
    const slider = this.getCalculatorSlider();
    const sliderBoundingBox = await slider.boundingBox();
    const min = 1;
    const max = 100;
    const fraction = (value - min) / (max - min);
    if (sliderBoundingBox) {
      const x = sliderBoundingBox.x + sliderBoundingBox.width * fraction;
      const y = sliderBoundingBox.y + sliderBoundingBox.height / 2;
      await this.page.mouse.click(x, y);
    }
  }

  getStartTrialButton(): Locator {
    return this.page.getByRole("button", { name: "Start Trial" }).first();
  }

  getStartTrialByLabel(): Locator {
    return this.page.getByLabel("Start Trial");
  }

  getEmailInput(): Locator {
    return this.page.locator("#email");
  }

  getRequestEarlyAccessButton(): Locator {
    return this.page.getByRole("button", { name: "Request Early Access" });
  }

  getSubmitAnotherButton(): Locator {
    return this.page.getByRole("button", { name: "Submit another" });
  }

  getSuccessMessage(): Locator {
    return this.page.getByText("You're on the list.");
  }
}

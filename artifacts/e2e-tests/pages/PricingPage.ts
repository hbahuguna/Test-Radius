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
    return this.page.getByRole("heading", { name: /Right-sized plans for/ });
  }

  getTierCard(tierName: string): Locator {
    return this.page.getByRole("heading", { name: tierName }).locator("..").locator("..").locator("..");
  }

  getTierCardElement(tierName: string): Locator {
    return this.page.locator("h3:has-text('" + tierName + "')").first().locator("..").locator("..").locator("..");
  }

  getTierPrice(tierName: string): Locator {
    return this.page.locator("h3:has-text('" + tierName + "')").first().locator("..").locator("..").locator("..").locator("span.font-extrabold");
  }

  getMostPopularBadge(): Locator {
    return this.page.getByText("Most Popular");
  }

  getTeamCard(): Locator {
    return this.page.locator("h3:has-text('Team')").first().locator("..").locator("..").locator("..");
  }

  getCtaButton(tierName: string): Locator {
    const card = this.getTierCardElement(tierName);
    return card.getByRole("button");
  }

  getFaqAccordionTrigger(question: string): Locator {
    return this.page.getByRole("button", { name: question });
  }

  getFaqContent(): Locator {
    return this.page.locator('[data-state="open"] [data-radix-collection-item]').first();
  }

  getGuaranteeBadge(): Locator {
    return this.page.getByText("30-day money-back guarantee");
  }
}

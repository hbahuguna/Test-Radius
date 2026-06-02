import { Page, Locator } from "@playwright/test";

export class HomePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto("/");
  }

  getHeroHeading(): Locator {
    return this.page.getByRole("heading").filter({ hasText: "Stop flaky tests" });
  }

  getGetEarlyAccessButton(): Locator {
    return this.page.locator("main").getByRole("button", { name: "Get Early Access" });
  }

  getJoinThePilotButton(): Locator {
    return this.page.getByRole("button", { name: "Join the Pilot" }).first();
  }

  getProblemSection(): Locator {
    return this.page.locator("section").filter({ hasText: "Running the whole suite" });
  }

  getSolutionSteps(): Locator {
    return this.page.locator("text=Map Code Changes,Select Impacted Tests,Eliminate Noise");
  }

  getWhyNotCards(): Locator {
    const section = this.page.locator("section").filter({ hasText: "Why not just use" });
    return section.locator("article");
  }

  getStatDefaultRun(): Locator {
    return this.page.getByText("735").first();
  }

  getStatTestRadius(): Locator {
    return this.page.getByText("42").first();
  }

  getTestimonialCards(): Locator {
    return this.page.locator("section").filter({ hasText: "We tested it on massive codebases" }).locator("article");
  }

  getLatestArticlesSection(): Locator {
    return this.page.locator("section").filter({ hasText: "Latest Articles" });
  }

  getBlogArticleCards(): Locator {
    return this.getLatestArticlesSection().locator("a[href^='/blog/']");
  }

  getViewAllArticlesButton(): Locator {
    return this.page.getByRole("link", { name: "View All Articles" });
  }

  getPrivateBetaBadge(): Locator {
    return this.page.getByText("Currently in private beta");
  }
}

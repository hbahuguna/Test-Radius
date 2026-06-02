import { Page, Locator } from "@playwright/test";

export class BlogIndexPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto("/blog");
  }

  getHeading(): Locator {
    return this.page.getByRole("heading").filter({ hasText: "TestRadius Blog" });
  }

  getBlogCards(): Locator {
    return this.page.locator("a[href^='/blog/']");
  }

  getEmptyState(): Locator {
    return this.page.getByText("No blog posts yet. Check back soon!");
  }

  getBlogCardBySlug(slug: string): Locator {
    return this.page.locator(`a[href="/blog/${slug}"]`);
  }

  getBlogCardTitle(slug: string): Locator {
    return this.getBlogCardBySlug(slug).locator("h3");
  }

  getBlogCardDate(slug: string): Locator {
    return this.getBlogCardBySlug(slug).locator("p").first();
  }
}

import { Page, Locator } from "@playwright/test";

export class BlogPostPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(slug: string) {
    await this.page.goto(`/blog/${slug}`);
  }

  getTitle(): Locator {
    return this.page.locator("article h1");
  }

  getDate(): Locator {
    return this.page.locator("article header p").first();
  }

  getDescription(): Locator {
    return this.page.locator("article header p").nth(1);
  }

  getBody(): Locator {
    return this.page.locator(".markdown-content");
  }

  getBackLink(): Locator {
    return this.page.getByRole("link", { name: "Back to Blog Index" });
  }

  getYouTubeEmbeds(): Locator {
    return this.page.locator("iframe[src*='youtube']");
  }

  getArticleImage(): Locator {
    return this.page.locator("article header img");
  }

  getNotFoundHeading(): Locator {
    return this.page.getByRole("heading", { name: "Article Not Found" });
  }

  getNotFoundBackLink(): Locator {
    return this.page.getByRole("link", { name: "Back to Blog Index" });
  }
}

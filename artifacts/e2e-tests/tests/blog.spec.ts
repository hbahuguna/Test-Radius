import { test, expect } from "../fixtures/test";
import { BlogIndexPage } from "../pages/BlogIndexPage";
import { BlogPostPage } from "../pages/BlogPostPage";
import { BLOG_SLUGS } from "../fixtures/test-data";

const POSTS_WITH_YOUTUBE = [
  "building-AI-native-testing-system-1",
  "building-AI-native-testing-system-2",
  "building-AI-native-testing-system-3",
  "building-AI-native-testing-system-4",
  "siamese-network-training-for-test-impact-analysis",
  "code-coverage-tia-article",
  "build-testradius-github-app",
];

test.describe("Blog", () => {
  test.describe("Blog Index", () => {
    let blogIndex: BlogIndexPage;

    test.beforeEach(async ({ page }) => {
      blogIndex = new BlogIndexPage(page);
      await blogIndex.goto();
    });

    test("renders heading", async () => {
      await expect(blogIndex.getHeading()).toBeVisible();
    });

    test("loads all blog articles", async () => {
      const cards = blogIndex.getBlogCards();
      await expect(cards).toHaveCount(BLOG_SLUGS.length);
    });

    test("each blog card links to correct article", async () => {
      for (const slug of BLOG_SLUGS) {
        const card = blogIndex.getBlogCardBySlug(slug);
        await expect(card).toBeVisible();
      }
    });
  });

  test.describe("Blog Post", () => {
    let blogPost: BlogPostPage;

    test.beforeEach(async ({ page }) => {
      blogPost = new BlogPostPage(page);
    });

    for (const slug of BLOG_SLUGS) {
      test(`renders article content for "${slug}"`, async () => {
        await blogPost.goto(slug);
        await expect(blogPost.getTitle()).toBeVisible();
        await expect(blogPost.getBody()).toBeVisible();
        await expect(blogPost.getBackLink()).toBeVisible();
      });
    }

    test("renders article image when present", async ({ page }) => {
      blogPost = new BlogPostPage(page);
      await blogPost.goto(BLOG_SLUGS[0]);
      await expect(blogPost.getArticleImage()).toBeVisible();
    });

    test("renders description when present", async ({ page }) => {
      blogPost = new BlogPostPage(page);
      await blogPost.goto(BLOG_SLUGS[0]);
      await expect(blogPost.getDescription()).toBeVisible();
    });

    test("renders YouTube embed for YouTube links", async ({ page }) => {
      blogPost = new BlogPostPage(page);
      await blogPost.goto(POSTS_WITH_YOUTUBE[0]);
      await expect(blogPost.getYouTubeEmbeds().first()).toBeVisible();
    });

    for (const slug of POSTS_WITH_YOUTUBE) {
      test(`renders YouTube embed for "${slug}"`, async () => {
        await blogPost.goto(slug);
        await expect(blogPost.getYouTubeEmbeds().first()).toBeVisible();
      });
    }

    test("back link navigates to blog index", async ({ page }) => {
      blogPost = new BlogPostPage(page);
      await blogPost.goto(BLOG_SLUGS[0]);
      await blogPost.getBackLink().click();
      await expect(page).toHaveURL("/blog");
    });

    test("navigating from blog card to article works", async ({ page }) => {
      const index = new BlogIndexPage(page);
      await index.goto();

      await index.getBlogCardBySlug(BLOG_SLUGS[0]).click();
      await expect(page).toHaveURL(`/blog/${BLOG_SLUGS[0]}`);

      const post = new BlogPostPage(page);
      await expect(post.getTitle()).toBeVisible();
    });

    test("invalid slug shows not-found state", async ({ page }) => {
      blogPost = new BlogPostPage(page);
      await blogPost.goto("non-existent-slug");
      await expect(blogPost.getNotFoundHeading()).toBeVisible();
      await expect(blogPost.getNotFoundBackLink()).toBeVisible();
    });
  });
});

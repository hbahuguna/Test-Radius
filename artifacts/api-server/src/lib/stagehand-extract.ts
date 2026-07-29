import { z } from "zod";
import { createStagehand, type StagehandConfig } from "./stagehand-client";
import { logger } from "./logger";

// ============================================================
// Types
// ============================================================

export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; fields: string[] }>;
  images: Array<{ alt: string; src: string }>;
  text: string;
  actionableElements: Array<{
    selector: string;
    description: string;
    method?: string;
    arguments?: string[];
  }>;
  extractedAt: string;
}

export interface SnapshotDiff {
  added: {
    headings: string[];
    links: Array<{ text: string; href: string }>;
    images: Array<{ alt: string; src: string }>;
    actionableElements: Array<{ description: string; method?: string }>;
  };
  removed: {
    headings: string[];
    links: Array<{ text: string; href: string }>;
    images: Array<{ alt: string; src: string }>;
    actionableElements: Array<{ description: string; method?: string }>;
  };
  textChanged: boolean;
  titleChanged: boolean;
  urlChanged: boolean;
}

// ============================================================
// Schema
// ============================================================

const snapshotSchema = z.object({
  title: z.string().describe("The page title"),
  headings: z
    .array(z.string())
    .describe("All heading texts on the page (h1-h6)"),
  links: z
    .array(
      z.object({
        text: z.string().describe("Link text"),
        href: z.string().describe("Link URL"),
      }),
    )
    .describe("All links on the page"),
  forms: z
    .array(
      z.object({
        action: z.string().describe("Form action URL or identifier"),
        fields: z
          .array(z.string())
          .describe("List of field labels or names in the form"),
      }),
    )
    .describe("All forms on the page"),
  images: z
    .array(
      z.object({
        alt: z.string().describe("Image alt text"),
        src: z.string().describe("Image source URL"),
      }),
    )
    .describe("All images on the page"),
  text: z
    .string()
    .describe("The main textual content of the page, excluding navigation"),
});

// ============================================================
// Snapshot Extraction
// ============================================================

/**
 * Take a structured snapshot of a page using Stagehand extract + observe.
 *
 * Opens a fresh browser session, navigates to the URL, and uses the LLM to
 * extract a structured representation of the page state plus all discoverable
 * actionable elements.
 */
export async function takeSnapshot(
  url: string,
  config: StagehandConfig,
): Promise<PageSnapshot> {
  const stagehand = await createStagehand(config);

  try {
    const page = stagehand.context.pages()[0];
    await page.goto(url);

    const result = await stagehand.extract(
      "Extract a structured representation of this page. " +
        "Include the title, all headings, links, forms with their fields, images with alt text, " +
        "and the main textual content (skip navigation menus and footers).",
      snapshotSchema,
    );

    // Discover actionable elements via observe()
    let actionableElements: PageSnapshot["actionableElements"] = [];
    try {
      const observed = await stagehand.observe(
        "find all interactive elements: buttons, links, inputs, dropdowns, and clickable elements",
      );
      actionableElements = (observed ?? []).map((o) => ({
        selector: o.selector,
        description: o.description,
        method: o.method,
        arguments: o.arguments,
      }));
    } catch (observeError) {
      logger.warn({ observeError }, "observe() failed during snapshot, continuing without actionable elements");
    }

    return {
      url: page.url(),
      title: result?.title ?? "",
      headings: result?.headings ?? [],
      links: result?.links ?? [],
      forms: result?.forms ?? [],
      images: result?.images ?? [],
      text: result?.text ?? "",
      actionableElements,
      extractedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error({ error, url }, "Failed to take page snapshot");
    throw error;
  } finally {
    await stagehand.close();
  }
}

// ============================================================
// Snapshot Diffing
// ============================================================

function diffArrays<T extends string>(
  before: T[],
  after: T[],
): { added: T[]; removed: T[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((item) => !beforeSet.has(item)),
    removed: before.filter((item) => !afterSet.has(item)),
  };
}

function diffLinkArrays(
  before: Array<{ text: string; href: string }>,
  after: Array<{ text: string; href: string }>,
): {
  added: Array<{ text: string; href: string }>;
  removed: Array<{ text: string; href: string }>;
} {
  const beforeKeys = new Set(before.map((l) => `${l.text}|||${l.href}`));
  const afterKeys = new Set(after.map((l) => `${l.text}|||${l.href}`));
  return {
    added: after.filter((l) => !beforeKeys.has(`${l.text}|||${l.href}`)),
    removed: before.filter((l) => !afterKeys.has(`${l.text}|||${l.href}`)),
  };
}

function diffImageArrays(
  before: Array<{ alt: string; src: string }>,
  after: Array<{ alt: string; src: string }>,
): {
  added: Array<{ alt: string; src: string }>;
  removed: Array<{ alt: string; src: string }>;
} {
  const beforeKeys = new Set(before.map((i) => `${i.alt}|||${i.src}`));
  const afterKeys = new Set(after.map((i) => `${i.alt}|||${i.src}`));
  return {
    added: after.filter((i) => !beforeKeys.has(`${i.alt}|||${i.src}`)),
    removed: before.filter((i) => !afterKeys.has(`${i.alt}|||${i.src}`)),
  };
}

function diffActionableElements(
  before: Array<{ description: string; method?: string }>,
  after: Array<{ description: string; method?: string }>,
): {
  added: Array<{ description: string; method?: string }>;
  removed: Array<{ description: string; method?: string }>;
} {
  const beforeKeys = new Set(before.map((e) => `${e.description}|||${e.method ?? ""}`));
  const afterKeys = new Set(after.map((e) => `${e.description}|||${e.method ?? ""}`));
  return {
    added: after.filter((e) => !beforeKeys.has(`${e.description}|||${e.method ?? ""}`)),
    removed: before.filter((e) => !afterKeys.has(`${e.description}|||${e.method ?? ""}`)),
  };
}

/**
 * Compare two page snapshots and return a structured diff.
 */
export function diffSnapshots(
  before: PageSnapshot,
  after: PageSnapshot,
): SnapshotDiff {
  const headings = diffArrays(before.headings, after.headings);
  const links = diffLinkArrays(before.links, after.links);
  const images = diffImageArrays(before.images, after.images);
  const actionable = diffActionableElements(
    before.actionableElements.map((e) => ({ description: e.description, method: e.method })),
    after.actionableElements.map((e) => ({ description: e.description, method: e.method })),
  );

  return {
    added: {
      headings: headings.added,
      links: links.added,
      images: images.added,
      actionableElements: actionable.added,
    },
    removed: {
      headings: headings.removed,
      links: links.removed,
      images: images.removed,
      actionableElements: actionable.removed,
    },
    textChanged: before.text !== after.text,
    titleChanged: before.title !== after.title,
    urlChanged: before.url !== after.url,
  };
}

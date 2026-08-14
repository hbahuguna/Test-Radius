/**
 * Accessibility snapshot formatting (Story QF-48).
 *
 * Translates a `Page`'s raw accessibility snapshot into the compact, index-
 * addressable payload the planner prompt needs. Each element gets a 1-based
 * `ref` index used by plan actions (never a raw selector, so plans stay
 * grounded in the current page); the agent resolves the index back to the
 * node's CSS `ref` at execution time.
 */
import type { Page, AccessibilityNode } from "../browser/session.js";

export interface SnapshotElement {
  index: number;
  role: string;
  name: string;
  ref: string;
  expanded?: boolean | null;
  hidden?: boolean;
}

export interface SnapshotPayload {
  url: string;
  title: string;
  elements: SnapshotElement[];
}

export function formatSnapshot(
  url: string,
  title: string,
  nodes: AccessibilityNode[],
): SnapshotPayload {
  return {
    url,
    title,
    elements: nodes.map((n, i) => ({
      index: i + 1,
      role: n.role,
      name: n.name,
      ref: n.ref,
      expanded: n.expanded,
      hidden: n.hidden,
    })),
  };
}

export async function buildSnapshot(
  page: Page,
  nodes: AccessibilityNode[],
): Promise<SnapshotPayload> {
  let url: string;
  let title: string;
  try {
    [url, title] = await Promise.all([
      page.getUrl(),
      page.evaluate<string>(() => document.title),
    ]);
  } catch {
    url = "about:blank";
    title = "";
  }
  return formatSnapshot(url, title, nodes);
}

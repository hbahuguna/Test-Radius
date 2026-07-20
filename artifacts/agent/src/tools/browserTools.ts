/**
 * Browser tools backed by Playwright (TypeScript). Ports the essential
 * surface of the Python sdet_agent.tools.browser_tools used by the agentic
 * executor: start, navigate, snapshot (interactive elements), and actions.
 */

import { chromium, type Browser, type Page, type BrowserContext } from "playwright";

export interface SnapshotElement {
  index: number;
  role: string;
  name: string;
  ref: string;
  /** For inputs: the input type (text/search/email/submit/...). */
  inputType?: string;
  /** True for elements that accept text input (input/textarea). */
  editable?: boolean;
  /** Short hint shown to the planner about what the element is. */
  description?: string;
}

export interface BrowserStartResult {
  status: "ok" | "error";
  error?: string;
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let elementCounter = 0;
/** Handles from the most recent snapshot, so click/type resolve by the same index. */
let lastElements: import("playwright").ElementHandle[] = [];

export async function browserStart(headless = true): Promise<BrowserStartResult> {
  try {
    if (!browser) {
      browser = await chromium.launch({ headless });
    }
    if (!context) {
      context = await browser.newContext();
    }
    if (!page) {
      page = await context.newPage();
    }
    return { status: "ok" };
  } catch (e: any) {
    return { status: "error", error: e?.message ?? String(e) };
  }
}

export async function browserNavigate(url: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return { ok: true, url: page.url() };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function summarizeRole(tag: string): string {
  const t = tag.toLowerCase();
  if (t === "a") return "link";
  if (t === "button") return "button";
  if (t === "input") return "textbox";
  if (t === "textarea") return "textbox";
  if (t === "select") return "combobox";
  if (t === "img") return "image";
  return t;
}

/** Rank so the planner's low indices are the most actionable elements. */
function rank(el: SnapshotElement): number {
  if (el.editable) return 0; // text fields first — usually the goal target
  if (el.role === "combobox") return 1;
  if (el.role === "button") return 2;
  if (el.role === "link") return 3;
  return 4;
}

export async function browserSnapshot(): Promise<{ ok: boolean; url?: string; interactive_elements?: SnapshotElement[]; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  try {
    const raw = await page.$$("a, button, input, textarea, select, [role], img");
    type Pair = { handle: import("playwright").ElementHandle; el: SnapshotElement };
    // Skip elements nested inside a modal dialog — the executor dismisses those
    // first and re-snapshots, so they should never be plan targets.
    const inDialog = (h: import("playwright").ElementHandle): Promise<boolean> =>
      h.evaluate((el) => !!el.closest('[role="dialog"], [aria-modal="true"]')).catch(() => false);
    const pairs: Pair[] = [];
    for (const h of raw) {
      if (await inDialog(h)) continue;
      const tag = (await h.evaluate((el) => el.tagName)).toLowerCase();
      const role = (await h.getAttribute("role")) || summarizeRole(tag);
      const editable = tag === "input" || tag === "textarea";
      // Prefer the most specific semantic label; only fall back to visible
      // text, and never let a giant text blob become the "name".
      const ariaLabel = (await h.getAttribute("aria-label")) || "";
      const nameAttr = (await h.getAttribute("name")) || "";
      const placeholder = (await h.getAttribute("placeholder")) || "";
      const title = (await h.getAttribute("title")) || "";
      const alt = (await h.getAttribute("alt")) || "";
      let name = ariaLabel || nameAttr || placeholder || title || alt;
      if (!name) {
        const txt = (await h.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        // Skip elements whose only signal is long body copy (not a control).
        if (txt.length > 0 && txt.length <= 40 && (role === "button" || role === "link" || role === "image")) {
          name = txt;
        } else if (editable) {
          name = `${role}`;
        } else {
          continue; // noisy non-interactive element; exclude from snapshot
        }
      }
      const inputType = editable ? (await h.getAttribute("type")) || "text" : undefined;
      let description: string;
      if (editable) description = `text field${inputType && inputType !== "text" ? ` (${inputType})` : ""}`;
      else if (role === "button") description = `button`;
      else if (role === "link") description = `link`;
      else if (role === "combobox") description = `dropdown`;
      else description = role;
      pairs.push({
        handle: h,
        el: {
          index: 0,
          role,
          name: String(name).slice(0, 60).trim(),
          ref: "",
          inputType,
          editable,
          description,
        },
      });
    }

    // Rank: editable fields first, then dropdowns, buttons, links, others.
    pairs.sort((a, b) => rank(a.el) - rank(b.el) || a.el.name.localeCompare(b.el.name));

    // Assign stable 1-based indices; keep handles in the same final order so
    // click/type resolve by index against this exact list.
    lastElements = pairs.map((p) => p.handle);
    const interactive: SnapshotElement[] = [];
    elementCounter = 0;
    for (const p of pairs) {
      const ref = `[${++elementCounter}]`;
      interactive.push({ ...p.el, index: elementCounter, ref });
    }
    return { ok: true, url: page.url(), interactive_elements: interactive };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function browserClick(ref: string): Promise<{ ok: boolean; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  const idx = Number(ref.replace(/[\[\]]/g, ""));
  const target = lastElements[idx - 1];
  if (!target) return { ok: false, error: `no element at ${ref}` };
  try {
    await target.click({ timeout: 10000, noWaitAfter: true });
    // Give any navigation triggered by the click time to settle so the
    // next snapshot reflects the new page rather than a half-loaded DOM.
    await page!.waitForLoadState("domcontentloaded").catch(() => {});
    return { ok: true };
  } catch (e: any) {
    const msg = (e?.message ?? String(e)) as string;
    // If the element detached because the click navigated the page, the
    // action succeeded — the page simply moved out from under the handle.
    if (/not attached|detached|navigated|navigation/i.test(msg)) {
      await page!.waitForLoadState("domcontentloaded").catch(() => {});
      return { ok: true, error: "navigation" };
    }
    return { ok: false, error: msg };
  }
}

export async function browserType(ref: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  const idx = Number(ref.replace(/[\[\]]/g, ""));
  const target = lastElements[idx - 1];
  if (!target) return { ok: false, error: `no element at ${ref}` };
  try {
    await target.fill(text, { timeout: 10000 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function browserScroll(direction: "up" | "down" = "down"): Promise<{ ok: boolean; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  try {
    await page.mouse.wheel(0, direction === "down" ? 600 : -600);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function browserScreenshot(): Promise<{ ok: boolean; screenshot?: string; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  try {
    const buf = await page.screenshot({ fullPage: false });
    return { ok: true, screenshot: buf.toString("base64") };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Wait for navigation/network to settle (or a fixed delay as a fallback).
 */
export async function browserWait(ms = 1500): Promise<{ ok: boolean; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  try {
    await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Try to close a visible modal / pop-up overlay. Many sites (Booking, etc.)
 * show an intercepting dialog on load. We try, in order:
 *   1. a visible [aria-label*="close"], [aria-label*="dismiss"], or button with
 *      text Close / Accept / X / ✕
 *   2. pressing Escape
 * Returns ok:true if it thinks it dismissed something (best-effort).
 */
export async function browserDismissOverlay(): Promise<{ ok: boolean; dismissed: boolean; error?: string }> {
  if (!page) return { ok: false, dismissed: false, error: "browser not started" };
  try {
    const selectors = [
      '[aria-label*="close" i]',
      '[aria-label*="dismiss" i]',
      '[aria-label*="Close" i]',
      'button[class*="close"]',
      'div[role="dialog"] button',
    ];
    for (const sel of selectors) {
      const btn = page.locator(sel).filter({ visible: true }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        return { ok: true, dismissed: true };
      }
    }
    // Fall back to Escape; if a dialog was open this closes it.
    await page.keyboard.press("Escape").catch(() => {});
    return { ok: true, dismissed: false };
  } catch (e: any) {
    return { ok: false, dismissed: false, error: e?.message ?? String(e) };
  }
}

/**
 * Detect whether an overlay/dialog is currently intercepting the page.
 */
export async function hasOverlay(): Promise<boolean> {
  if (!page) return false;
  try {
    const dialog = page.locator('[role="dialog"]').filter({ visible: true }).first();
    if (await dialog.count()) return true;
    const trap = page.locator('[data-bui-trap-root], [data-testid*="overlay"], [aria-modal="true"]')
      .filter({ visible: true })
      .first();
    return (await trap.count()) > 0;
  } catch {
    return false;
  }
}

export async function browserClose(): Promise<void> {
  try {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  } finally {
    page = null;
    context = null;
    browser = null;
    lastElements = [];
  }
}

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
  description?: string;
  context?: string;
}

export interface BrowserStartResult {
  status: "ok" | "error";
  error?: string;
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let elementCounter = 0;

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

export async function browserSnapshot(): Promise<{ ok: boolean; url?: string; interactive_elements?: SnapshotElement[]; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  try {
    const elements = await page.$$("a, button, input, textarea, select, [role], img");
    const interactive: SnapshotElement[] = [];
    elementCounter = 0;
    for (const h of elements) {
      const tag = (await h.evaluate((el) => el.tagName)).toLowerCase();
      const role = (await h.getAttribute("role")) || summarizeRole(tag);
      const name =
        (await h.getAttribute("aria-label")) ||
        (await h.getAttribute("name")) ||
        (await h.getAttribute("placeholder")) ||
        (await h.getAttribute("title")) ||
        (await h.getAttribute("alt")) ||
        (await h.innerText().catch(() => "")).slice(0, 60) ||
        tag;
      const ref = `[${++elementCounter}]`;
      interactive.push({ index: elementCounter, role, name: String(name).trim(), ref });
    }
    return { ok: true, url: page.url(), interactive_elements: interactive };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function browserClick(ref: string): Promise<{ ok: boolean; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  const idx = Number(ref.replace(/[\[\]]/g, ""));
  const els = await page.$$("a, button, input, textarea, select, [role], img");
  const target = els[idx - 1];
  if (!target) return { ok: false, error: `no element at ${ref}` };
  try {
    await target.click({ timeout: 10000 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function browserType(ref: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  const idx = Number(ref.replace(/[\[\]]/g, ""));
  const els = await page.$$("a, button, input, textarea, select, [role], img");
  const target = els[idx - 1];
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
  }
}

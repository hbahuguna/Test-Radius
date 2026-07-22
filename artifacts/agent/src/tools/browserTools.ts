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
    if (!page || page.isClosed()) {
      page = await context.newPage();
    }
    return { status: "ok" };
  } catch (e: any) {
    return { status: "error", error: e?.message ?? String(e) };
  }
}

/** Check if the current page is still alive and responsive. */
export async function browserIsAlive(): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  try {
    await page.evaluate(() => 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover from a dead page/browser. If the context is still alive, get
 * the current page from it (Google Flights SPA navigation replaces pages).
 * Only re-launch if the context is also dead.
 */
export async function browserRecover(url: string, headless = true): Promise<boolean> {
  try {
    // Check if context is still alive — SPA navigations kill the page but
    // the context (and browser) remain. Get the active page from it.
    if (context) {
      try {
        const pages = context.pages();
        if (pages.length > 0) {
          page = pages[pages.length - 1]; // use the most recent page
          if (!page.isClosed()) {
            return true;
          }
        }
      } catch {}
    }
    // Context is dead too — full re-launch
    page = null;
    context = null;
    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
    }
    const start = await browserStart(headless);
    if (start.status !== "ok") return false;
    const nav = await browserNavigate(url);
    return nav.ok;
  } catch {
    return false;
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
  if (el.editable) return 0; // text fields and dialog inputs — highest priority
  if (el.role === "combobox") return 1;
  if (el.role === "option") return 2; // dropdown suggestions — click AFTER typing
  if (el.role === "button") return 3;
  if (el.role === "link") return 4;
  return 5;
}

export async function browserSnapshot(): Promise<{ ok: boolean; url?: string; interactive_elements?: SnapshotElement[]; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  try {
    const raw = await page.$$("a, button, input, textarea, select, [role], img");
    type Pair = { handle: import("playwright").ElementHandle; el: SnapshotElement };
    const pairs: Pair[] = [];
    // When a dialog is open (e.g. Google Flights origin picker), only show
    // elements INSIDE the dialog. Background elements ( Departure, Return,
    // etc.) are non-interactive and would confuse the planner.
    const dialogOpen = await page.locator('[role="dialog"]:visible').count() > 0;
    for (const h of raw) {
      // Skip elements that have zero dimensions (hidden behind dropdowns,
      // collapsed, or offscreen). Use bounding box rather than isVisible()
      // because isVisible() checks CSS display/visibility which can be
      // overly aggressive for elements that are technically visible but
      // have zero size (e.g. hidden comboboxes behind a dialog).
      try {
        const box = await h.boundingBox();
        if (!box || box.width === 0 || box.height === 0) continue;
      } catch {
        continue; // detached or errored — skip
      }
      // When a dialog is open, skip elements that are NOT inside it.
      // They're background UI and non-interactive.
      if (dialogOpen) {
        const inDialog = await h.evaluate((el) => !!el.closest('[role="dialog"]')).catch(() => false);
        if (!inDialog) continue;
      }
      const tag = (await h.evaluate((el) => el.tagName)).toLowerCase();
      const role = (await h.getAttribute("role")) || summarizeRole(tag);
      const editable = tag === "input" || tag === "textarea";
      // ARIA comboboxes (e.g. Google Flights) are editable too — they accept
      // typed input after a click opens the dropdown.
      const isCombobox = role === "combobox";
      if (isCombobox) { /* comboboxes are interactable even if not native inputs */ }
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
        if (txt.length > 0 && txt.length <= 40 && (role === "button" || role === "link" || role === "image" || role === "option")) {
          name = txt;
        } else if (editable || isCombobox) {
          name = `${role}`;
        } else {
          continue; // noisy non-interactive element; exclude from snapshot
        }
      }
      // Filter out noise: timestamps ("2 hours ago") and comment counts
      // ("139 comments") clutter the snapshot without helping the planner.
      if (role === "link" && name) {
        if (/^\d+\s+(?:hour|minute|second|day|week|month|year)s?\s+ago$/i.test(name)) continue;
        if (/^\d+\s+comments?$/i.test(name)) continue;
        // Domain-only links ("github.com", "nytimes.com") are source indicators,
        // not primary story links — annotate so the planner doesn't click them.
        if (/^[a-z0-9-]+(?:\.[a-z]{2,})+$/i.test(name)) {
          name = `${name} (source domain)`;
        }
      }
      // Filter out popular-route suggestion buttons on sites like Google Flights.
      // These are pre-filled "Find flights from X to Y" buttons that clutter the
      // snapshot and distract the planner from the actual form fields.
      if (role === "button" && name) {
        if (/^Find flights from/i.test(name)) continue;
        if (/^Flights from/i.test(name)) continue;
      }
      const inputType = editable ? (await h.getAttribute("type")) || "text" : undefined;
      let description: string;
      if (isCombobox) description = `combobox (click to open, then type)`;
      else if (role === "option") description = `suggestion (click to select)`;
      else if (editable) description = `text field${inputType && inputType !== "text" ? ` (${inputType})` : ""}`;
      else if (role === "button") description = `button`;
      else if (role === "link") description = `link`;
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
    // Cap at 25 elements to keep the planner focused — the sorted order puts
    // editable fields and comboboxes first, so the most important targets are
    // always within this window.
    const cap = Math.min(pairs.length, 25);
    for (let i = 0; i < cap; i++) {
      const ref = `[${++elementCounter}]`;
      interactive.push({ ...pairs[i].el, index: elementCounter, ref });
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
    if (/not attached|detached|navigated|navigation|Target page|has been closed/i.test(msg)) {
      await page!.waitForLoadState("domcontentloaded").catch(() => {});
      return { ok: true, error: "navigation" };
    }
    // If an overlay/backdrop is intercepting the click, dismiss it and retry
    // once before giving up. Covers search-autocomplete backdrops, modals, etc.
    if (/intercepts pointer events|overlay|backdrop|is not clickable/i.test(msg)) {
      await browserDismissOverlay().catch(() => {});
      await page!.waitForTimeout(400).catch(() => {});
      try {
        await target.click({ timeout: 5000, noWaitAfter: true, force: true });
        await page!.waitForLoadState("domcontentloaded").catch(() => {});
        return { ok: true };
      } catch {
        return { ok: false, error: msg };
      }
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
    const tag = await target.evaluate((el) => el.tagName).catch(() => "");
    if (tag === "INPUT" || tag === "TEXTAREA") {
      // Native input — use fill() which is fast and reliable, then dispatch
      // an input event so dynamic widgets (React, etc.) pick up the change.
      await target.fill(text, { timeout: 5000 });
      await target.dispatchEvent("input").catch(() => {});
    } else {
      // Non-native element (combobox wrapper, contenteditable, etc.) — use
      // keyboard simulation which triggers all the proper events.
      await target.click({ timeout: 5000, noWaitAfter: true });
      await page!.waitForLoadState("domcontentloaded").catch(() => {});
      await page!.keyboard.press("Meta+A").catch(() => page!.keyboard.press("Control+A"));
      await page!.keyboard.press("Backspace");
      await page!.keyboard.type(text, { delay: 30 });
    }
    // Brief pause so dynamic dropdowns have time to render.
    await page!.waitForTimeout(600).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    const msg = (e?.message ?? String(e)) as string;
    // If the element/page navigated or was closed during the click, treat as success.
    if (/not attached|detached|navigated|navigation|Target page|has been closed/i.test(msg)) {
      await page!.waitForLoadState("domcontentloaded").catch(() => {});
      return { ok: true, error: "navigation" };
    }
    return { ok: false, error: msg };
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

/**
 * Select a dropdown option using keyboard navigation (ArrowDown + Enter).
 * This avoids clicking option elements which can trigger page navigation
 * that crashes the browser (e.g. Google Flights SPA).
 */
export async function browserKeyboardSelect(): Promise<{ ok: boolean; error?: string }> {
  if (!page) return { ok: false, error: "browser not started" };
  try {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300).catch(() => {});
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    const msg = (e?.message ?? String(e)) as string;
    if (/not attached|detached|navigated|navigation|Target page|has been closed/i.test(msg)) {
      await page!.waitForLoadState("domcontentloaded").catch(() => {});
      return { ok: true, error: "navigation" };
    }
    return { ok: false, error: msg };
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
      '[data-testid*="autocomplete-backdrop"]',
    ];
    for (const sel of selectors) {
      const btn = page.locator(sel).filter({ visible: true }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        return { ok: true, dismissed: true };
      }
    }
    // Backdrops often have no close button — remove the intercepting overlay
    // element directly so it stops blocking pointer events. This runs in the
    // browser context; cast to any to avoid pulling DOM types into the build.
    // IMPORTANT: Do NOT remove dialogs that contain form inputs (comboboxes,
    // text fields) — those are part of the UI flow (e.g. Google Flights origin
    // picker), not popups to dismiss.
    const removed = await page.evaluate((): boolean => {
      const doc = (globalThis as any).document;
      if (!doc) return false;
      const candidates = Array.from(
        doc.querySelectorAll(
          '[data-testid*="backdrop"], [class*="backdrop"], [data-bui-trap-root], [aria-modal="true"]',
        ),
      ).filter((el: any) => {
        const s = (globalThis as any).getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const isVisible = r.width > 0 && r.height > 0 && s.pointerEvents !== "none" && (Number(s.zIndex) > 0 || s.position === "fixed");
        if (!isVisible) return false;
        // Skip dialogs that contain input fields or comboboxes — they're
        // interactive UI, not overlays to dismiss.
        if (el.querySelector && el.querySelector('input, textarea, [role="combobox"]')) return false;
        return true;
      });
      candidates.forEach((el: any) => el.remove());
      return candidates.length > 0;
    }).catch(() => false);
    if (removed) return { ok: true, dismissed: true };
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
    const trap = page.locator('[data-bui-trap-root], [data-testid*="overlay"], [aria-modal="true"], [data-testid*="backdrop"], [class*="backdrop"]')
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

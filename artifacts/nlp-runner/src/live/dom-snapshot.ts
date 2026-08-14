/**
 * Pragmatic DOM serialization for the live agent (PLAN-live-agent.md Phase 2)
 * — a reduced-fidelity port of browser-use `dom/serializer/serializer.py`.
 *
 * Deliberately skipped: `DOMSnapshot.captureSnapshot`, paint-order rect
 * unions, shadow-DOM traversal, cross-origin iframes. Kept: clickable-index
 * assignment with a `selectorMap`, viewport filtering, JS click-listener
 * detection (DevTools command-line API), and the browser-use text format
 * `[index]<tag attr=value />`.
 */

export interface DomEntry {
  depth: number;
  tag: string;
  /** Rendered attribute string for interactive elements, e.g. `type=text`. */
  attrs: string;
  /** Trimmed leaf text (null for containers). */
  text: string | null;
  /** CSS selector usable with `querySelector` (interactive only). */
  ref: string | null;
  interactive: boolean;
  scrollable: boolean;
}

export interface DomSnapshot {
  url: string;
  title: string;
  text: string;
  selectorMap: Map<number, string>;
  /** Present only when `screenshot: true` (base64 PNG). */
  screenshot?: string;
}

/**
 * Raw, self-contained JS evaluated in the page to collect the visible
 * interactive elements and leaf text as flat entries (main frame only).
 *
 * Written as a plain string literal (not a compiled function) so esbuild's
 * `keepNames` transform can never inject a `__name(...)` wrapper into code
 * that runs inside the page — the page has no `__name` helper. Iterative
 * walk, no recursion, no imports.
 */
export const collectDomSnippet = `(() => {
  const MAX_DEPTH = 24;
  const MAX_ENTRIES = 600;
  const MAX_JS_LISTENER_SCAN = 100;
  const SKIP_TAGS = new Set(["script","style","link","meta","template","noscript","svg","head"]);
  const INTERACTIVE_SELECTOR = [
    "a[href]","button","input","select","textarea","summary",
    '[role="button"]','[role="link"]','[role="checkbox"]','[role="radio"]',
    '[role="combobox"]','[role="tab"]','[role="textbox"]','[contenteditable="true"]'
  ].join(",");
  const ATTR_KEEP = ["id","class","type","name","role","aria-label","title","data-testid","placeholder","href"];

  const interactive = new Set();
  const candidates = document.querySelectorAll(INTERACTIVE_SELECTOR);
  for (let i = 0; i < candidates.length; i++) interactive.add(candidates[i]);

  const gl = globalThis;
  if (typeof gl.getEventListeners === "function") {
    const all = document.querySelectorAll("*");
    let found = 0;
    for (let i = 0; i < all.length && found < MAX_JS_LISTENER_SCAN; i++) {
      const el = all[i];
      if (interactive.has(el)) continue;
      const tag = el.localName;
      if (SKIP_TAGS.has(tag) || tag === "html" || tag === "body") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      let hasClick = false;
      try { const l = gl.getEventListeners(el); hasClick = !!(l && l.click && l.click.length > 0); } catch (e) { hasClick = false; }
      if (hasClick) { interactive.add(el); found++; }
    }
  }

  const entries = [];
  const stack = [{ el: document.body, depth: 0 }];
  while (stack.length > 0 && entries.length < MAX_ENTRIES) {
    const top = stack.pop();
    const el = top.el;
    const depth = top.depth;
    if (depth > MAX_DEPTH) continue;

    const tag = el.localName;
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.top < window.innerHeight
      && rect.right > 0 && rect.left < window.innerWidth;
    const isInteractive = visible && interactive.has(el);
    const hasElementChildren = el.children.length > 0;

    if (!SKIP_TAGS.has(tag)) {
      if (isInteractive) {
        const testid = el.getAttribute("data-testid");
        let ref = null;
        if (testid) {
          ref = '[data-testid="' + CSS.escape(testid) + '"]';
        } else if (el.id) {
          ref = "#" + CSS.escape(el.id);
        } else {
          const path = [];
          let node = el;
          while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
            const parent = node.parentElement;
            let nth = 1;
            if (parent) {
              let same = 0;
              for (let i = 0; i < parent.children.length; i++) {
                if (parent.children[i] === node) break;
                if (parent.children[i].localName === node.localName) same++;
              }
              nth = same + 1;
            }
            path.unshift(node.localName + ":nth-of-type(" + nth + ")");
            node = parent;
          }
          ref = path.join(">");
        }

        const attrParts = [];
        for (let a = 0; a < ATTR_KEEP.length; a++) {
          const name = ATTR_KEEP[a];
          const v = el.getAttribute(name);
          if (v) {
            let shown = v.replace(/\\s+/g, " ").trim();
            if (shown.length > 80) shown = shown.slice(0, 80) + "\\u2026";
            if (shown) attrParts.push(name + "=" + shown);
          }
        }
        if (tag === "input" && el.value) {
          const shown = String(el.value).slice(0, 40);
          if (shown) attrParts.push("value=" + shown);
        }

        const scrollable = el.scrollHeight > el.clientHeight + 1
          && (() => {
            const s = window.getComputedStyle(el);
            return s.overflowY === "auto" || s.overflowY === "scroll" || s.overflow === "auto" || s.overflow === "scroll";
          })();

        entries.push({ depth, tag, attrs: attrParts.join(" "), text: null, ref, interactive: true, scrollable });
      } else if (visible && !hasElementChildren) {
        const text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200);
        if (text.length > 1) {
          entries.push({ depth, tag, attrs: "", text, ref: null, interactive: false, scrollable: false });
        }
      }
    }

    for (let i = el.children.length - 1; i >= 0; i--) {
      stack.push({ el: el.children[i], depth: depth + 1 });
    }
  }
  return entries;
})()`;

export interface FormattedDom {
  text: string;
  selectorMap: Map<number, string>;
}

const MAX_TEXT_LENGTH = 12_000;

/**
 * Assign 1-based indices to interactive entries, mark `*` on elements that
 * weren't in the previous snapshot, and render the browser-use text format.
 * Pure function — unit-testable without Chrome.
 */
export function formatDom(
  entries: DomEntry[],
  previousRefs: ReadonlySet<string> = new Set(),
  maxTextLength = MAX_TEXT_LENGTH,
): FormattedDom {
  const selectorMap = new Map<number, string>();
  const lines: string[] = [];

  let index = 0;
  for (const entry of entries) {
    const tabs = "\t".repeat(entry.depth);
    if (entry.interactive && entry.ref) {
      index++;
      selectorMap.set(index, entry.ref);
      const newMark = previousRefs.has(entry.ref) ? "" : "*";
      const scrollMark = entry.scrollable ? "|SCROLL|" : "";
      const attrs = entry.attrs ? ` ${entry.attrs}` : "";
      lines.push(`${tabs}${newMark}${scrollMark}[${index}]<${entry.tag}${attrs} />`);
    } else if (entry.text) {
      lines.push(`${tabs}\t${entry.text}`);
    }
  }

  let body = lines.join("\n");
  if (body.length > maxTextLength) {
    body = `${body.slice(0, maxTextLength)}\n… [truncated]`;
  }
  return { text: `[Start of page]\n${body}\n[End of page]`, selectorMap };
}

export interface CaptureDomOptions {
  /** Include a base64 PNG screenshot in the snapshot. */
  screenshot?: boolean;
  /** Previous snapshot (for `*` new-element markers). */
  previous?: DomSnapshot;
  maxTextLength?: number;
}

export async function captureDomSnapshot(
  page: {
    getUrl(): Promise<string>;
    evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
    evaluateWithCommandLine<T>(
      fn: string | ((...args: unknown[]) => T),
      ...args: unknown[]
    ): Promise<T>;
    screenshot(): Promise<string>;
  },
  options: CaptureDomOptions = {},
): Promise<DomSnapshot> {
  const [url, title, entries] = await Promise.all([
    page.getUrl(),
    page.evaluate<string>(() => document.title),
    page.evaluateWithCommandLine<DomEntry[]>(collectDomSnippet),
  ]);

  const previousRefs = new Set(
    options.previous ? [...options.previous.selectorMap.values()] : [],
  );
  const { text, selectorMap } = formatDom(
    entries,
    previousRefs,
    options.maxTextLength,
  );

  const snapshot: DomSnapshot = { url, title, text, selectorMap };
  if (options.screenshot) {
    snapshot.screenshot = await page.screenshot();
  }
  return snapshot;
}

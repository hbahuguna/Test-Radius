import { writeFile } from "node:fs/promises";
import {
  CdpClient,
  connect,
  type CdpEventHandler,
} from "./cdp.js";
import { launch, type LaunchedBrowser, type LaunchOptions } from "./launch.js";
import { fnv1a } from "../util/hash.js";

export class NavigationError extends Error {
  override name = "NavigationError";
}

export class EvaluationError extends Error {
  override name = "EvaluationError";
}

export class ElementNotFoundError extends Error {
  override name = "ElementNotFoundError";
}

export class WaitTimeoutError extends Error {
  override name = "WaitTimeoutError";
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
}

interface ExceptionDetails {
  text: string;
  exception?: RemoteObject;
}

interface AXValue {
  type: string;
  value?: string | number | boolean;
  description?: string;
  sources?: unknown[];
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: unknown[];
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  properties?: { name: string; value: AXValue }[];
  backendDOMNodeId?: number;
  childIds?: string[];
  frameId?: string;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "summary",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function describeInteractiveElement(this: Element): {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const testid = this.getAttribute("data-testid");
  let ref: string;
  if (testid) {
    ref = `[data-testid="${CSS.escape(testid)}"]`;
  } else if (this.id) {
    ref = `#${CSS.escape(this.id)}`;
  } else {
    ref = this.localName;
    for (let i = 0; i < this.classList.length; i++) {
      ref += `.${CSS.escape(this.classList.item(i) ?? "")}`;
    }
    const parent = this.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child) => child.localName === this.localName,
      );
      if (siblings.length > 1) {
        ref += `:nth-of-type(${siblings.indexOf(this) + 1})`;
      }
    }
  }
  const rect = this.getBoundingClientRect();
  return { ref, x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

export class Page {
  constructor(
    private readonly client: CdpClient,
    readonly sessionId: string,
    readonly targetId: string,
  ) {}

  send<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId);
  }

  on(method: string, handler: CdpEventHandler): () => void {
    return this.client.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) handler(params, sessionId);
    });
  }

  once<T = unknown>(method: string, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let off: () => void;
      const timer = setTimeout(() => {
        off();
        reject(
          new Error(
            `Timed out waiting for CDP event "${method}" on page ${this.targetId}`,
          ),
        );
      }, timeoutMs);
      timer.unref();
      off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params as T);
      });
    });
  }

  async navigate(
    url: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ url: string }> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const loaded = this.once("Page.loadEventFired", timeoutMs);
    loaded.catch(() => {});

    let navResult: { errorText?: string; frameId: string };
    try {
      navResult = await this.send<{ errorText?: string; frameId: string }>(
        "Page.navigate",
        { url },
      );
    } catch (err) {
      throw new NavigationError(
        `Navigation to "${url}" failed: ${reasonText(err)}`,
      );
    }

    try {
      await loaded;
    } catch {
      throw new NavigationError(
        `Navigation to "${url}" timed out after ${timeoutMs}ms (no Page.loadEventFired)`,
      );
    }

    if (navResult.errorText) {
      throw new NavigationError(
        `Navigation to "${url}" failed: ${navResult.errorText}`,
      );
    }
    const currentUrl = await this.getUrl();
    if (currentUrl.startsWith("chrome-error://")) {
      throw new NavigationError(
        `Navigation to "${url}" failed: browser displayed an error page (${currentUrl})`,
      );
    }
    return { url: currentUrl };
  }

  /**
   * Navigate back one page in the browser history.
   * Uses CDP's Page.navigate with the previous URL from the session history.
   */
  async goBack(): Promise<{ url: string }> {
    const loaded = this.once("Page.loadEventFired", 30_000);
    loaded.catch(() => {});

    await this.send("Page.goBack");

    try {
      await loaded;
    } catch {
      throw new NavigationError(
        "GoBack timed out after 30000ms (no Page.loadEventFired)",
      );
    }

    return { url: await this.getUrl() };
  }

  async getUrl(): Promise<string> {
    const { frameTree } = await this.send<{
      frameTree: { frame: { url: string } };
    }>("Page.getFrameTree");
    return frameTree.frame.url;
  }

  /**
   * Evaluate a function or expression in the page's main frame.
   *
   * Functions are stringified and invoked with the given JSON-serializable
   * `args`. Promises are awaited. JS exceptions are surfaced as
   * `EvaluationError` with the original exception message (not a protocol
   * error), and non-serializable results are rejected.
   */
  async evaluate<T = unknown>(
    fn: string | ((...args: unknown[]) => T),
    ...args: unknown[]
  ): Promise<T> {
    return this.evaluateImpl(fn, false, args);
  }

  /**
   * Like `evaluate`, but enables the DevTools command-line API in the page so
   * the evaluated code can use helpers such as `getEventListeners` (used by
   * the live-agent DOM serializer to detect JS-bound click handlers).
   */
  async evaluateWithCommandLine<T = unknown>(
    fn: string | ((...args: unknown[]) => T),
    ...args: unknown[]
  ): Promise<T> {
    return this.evaluateImpl(fn, true, args);
  }

  private async evaluateImpl<T>(
    fn: string | ((...args: unknown[]) => T),
    includeCommandLineAPI: boolean,
    args: unknown[],
  ): Promise<T> {
    const body = fn.toString();
    const expression =
      typeof fn === "string"
        ? fn
        : args.length
          ? `(${body})(...${JSON.stringify(args)})`
          : `(${body})()`;

    const { result, exceptionDetails } = await this.send<{
      result: RemoteObject;
      exceptionDetails?: ExceptionDetails;
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      includeCommandLineAPI,
    });

    if (exceptionDetails) {
      const detail =
        exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new EvaluationError(`Evaluation failed: ${detail}`);
    }
    if (result.type === "undefined") return undefined as T;
    if (result.type === "object" && !("value" in result)) {
      throw new EvaluationError(
        `Evaluation result is not serializable (${result.description ?? result.subtype ?? result.type})`,
      );
    }
    return result.value as T;
  }

  /**
   * Locate the first element matching `selector` and resolve its bounding box
   * in viewport coordinates. Multi-match selectors use the first match.
   * Coordinates are returned as-is even if the element is off-screen (no
   * automatic scrolling here; `click` scrolls into view before clicking).
   */
  async queryElement(selector: string): Promise<ElementLocation> {
    const loc = await this.evaluate<{
      found: boolean;
      left: number;
      top: number;
      width: number;
      height: number;
    }>(
      (sel: string) => {
        let el: Element | null;
        if (sel.startsWith('text="')) {
          const needle = sel.slice(6, -1);
          const all = document.querySelectorAll('button,a,summary,input[type="submit"],input[type="button"],input[type="reset"],[role="tab"],[role="button"],[role="link"],[role="menuitem"],[role="option"],li');
          el = null;
          for (let i = 0; i < all.length; i++) {
            const candidate = all[i] as Element;
            if ((candidate.textContent ?? "").trim() === needle) { el = candidate; break; }
            if (candidate instanceof HTMLInputElement && (candidate.value ?? "").trim() === needle) { el = candidate; break; }
          }
          if (!el) {
            const needleLower = needle.toLowerCase();
            for (let i = 0; i < all.length; i++) {
              const candidate = all[i] as Element;
              if ((candidate.textContent ?? "").trim().toLowerCase() === needleLower) { el = candidate; break; }
              if (candidate instanceof HTMLInputElement && (candidate.value ?? "").trim().toLowerCase() === needleLower) { el = candidate; break; }
            }
          }
        } else {
          try { el = document.querySelector(sel); } catch { el = null; }
        }
        if (!el) return { found: false, left: 0, top: 0, width: 0, height: 0 };
        const r = el.getBoundingClientRect();
        return {
          found: true,
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
        };
      },
      selector,
    );

    if (!loc.found) {
      throw new ElementNotFoundError(
        `No element matches selector "${selector}"`,
      );
    }
    return {
      x: loc.left,
      y: loc.top,
      width: loc.width,
      height: loc.height,
      centerX: loc.left + loc.width / 2,
      centerY: loc.top + loc.height / 2,
    };
  }

  /**
   * Click the first element matching `selector` by dispatching real
   * `Input.dispatchMouseEvent` mouse events at its center. The element is
   * scrolled into view first.
   */
  async click(selector: string): Promise<void> {
    await this.scrollIntoView(selector);
    const { centerX, centerY } = await this.queryElement(selector);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: centerX,
      y: centerY,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: centerX,
      y: centerY,
      button: "left",
      clickCount: 1,
    });
  }

  /**
   * Scroll the first element matching `selector` into view using an INSTANT
   * scroll, overriding any CSS `scroll-behavior: smooth`. Smooth scrolling
   * animates the position, so a rect read immediately afterwards is
   * mid-animation and a subsequent viewport-coordinate click would miss the
   * element (e.g. anchor links in a sticky nav).
   */
  private async scrollIntoView(
    selector: string,
    block: ScrollLogicalPosition = "center",
  ): Promise<void> {
    await this.evaluate((sel: string, b: ScrollLogicalPosition) => {
      let el: Element | null;
      if (sel.startsWith('text="')) {
        const needle = sel.slice(6, -1);
        const all = document.querySelectorAll('button,a,summary,input[type="submit"],input[type="button"],input[type="reset"],[role="tab"],[role="button"],[role="link"],[role="menuitem"],[role="option"],li');
        el = null;
        for (let i = 0; i < all.length; i++) {
          const candidate = all[i] as Element;
          if ((candidate.textContent ?? "").trim() === needle) { el = candidate; break; }
          if (candidate instanceof HTMLInputElement && (candidate.value ?? "").trim() === needle) { el = candidate; break; }
        }
        if (!el) {
          const needleLower = needle.toLowerCase();
          for (let i = 0; i < all.length; i++) {
            const candidate = all[i] as Element;
            if ((candidate.textContent ?? "").trim().toLowerCase() === needleLower) { el = candidate; break; }
            if (candidate instanceof HTMLInputElement && (candidate.value ?? "").trim().toLowerCase() === needleLower) { el = candidate; break; }
          }
        }
      } else {
        try { el = document.querySelector(sel); } catch { el = null; }
      }
      if (el) (el as HTMLElement).scrollIntoView({ behavior: "instant", block: b, inline: "center" });
    }, selector, block);
  }

  /**
   * Focus the first element matching `selector`, select any existing value
   * (so fills replace rather than append), then type via real
   * `Input.insertText` events.
   */
  async fill(selector: string, text: string): Promise<void> {
    await this.scrollIntoView(selector);
    await this.evaluate((sel: string) => {
      let el: HTMLInputElement | HTMLTextAreaElement | null;
      if (sel.startsWith('text="')) {
        const needle = sel.slice(6, -1);
        const all = document.querySelectorAll('button,a,summary,input[type="submit"],input[type="button"],input[type="reset"],[role="tab"],[role="button"],[role="link"],[role="menuitem"],[role="option"],input,textarea');
        el = null;
        for (let i = 0; i < all.length; i++) {
          const candidate = all[i] as Element;
          if ((candidate.textContent ?? "").trim() === needle) { el = candidate as HTMLInputElement; break; }
          if (candidate instanceof HTMLInputElement && (candidate.value ?? "").trim() === needle) { el = candidate; break; }
        }
        if (!el) {
          const needleLower = needle.toLowerCase();
          for (let i = 0; i < all.length; i++) {
            const candidate = all[i] as Element;
            if ((candidate.textContent ?? "").trim().toLowerCase() === needleLower) { el = candidate as HTMLInputElement; break; }
            if (candidate instanceof HTMLInputElement && (candidate.value ?? "").trim().toLowerCase() === needleLower) { el = candidate; break; }
          }
        }
      } else {
        try { el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null; } catch { el = null; }
      }
      if (!el) throw new Error(`fill: no element matches selector "${sel}"`);
      el.focus();
      el.select();
    }, selector);
    await this.send("Input.insertText", { text });
  }

  /**
   * Select an option in the first `<select>` matching `selector` by setting
   * its value and dispatching `input` + `change` events.
   */
  async select(selector: string, value: string): Promise<void> {
    await this.scrollIntoView(selector);
    await this.evaluate((sel: string, val: string) => {
      let el: HTMLSelectElement | null;
      if (sel.startsWith('text="')) {
        const needle = sel.slice(6, -1);
        const all = document.querySelectorAll("select");
        el = null;
        for (let i = 0; i < all.length; i++) {
          if ((all[i].textContent ?? "").trim() === needle) { el = all[i] as HTMLSelectElement; break; }
        }
        if (!el) {
          const needleLower = needle.toLowerCase();
          for (let i = 0; i < all.length; i++) {
            if ((all[i].textContent ?? "").trim().toLowerCase() === needleLower) { el = all[i] as HTMLSelectElement; break; }
          }
        }
      } else {
        try { el = document.querySelector(sel) as HTMLSelectElement | null; } catch { el = null; }
      }
      if (!el) throw new Error(`select: no element matches selector "${sel}"`);
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, selector, value);
  }

  /**
   * Scroll the first element matching `selector` into view (centered by
   * default, honoring `block`).
   */
  async scroll(
    selector: string,
    options: { block?: ScrollLogicalPosition } = {},
  ): Promise<void> {
    await this.scrollIntoView(selector, options.block ?? "center");
  }

  /**
   * Capture a PNG screenshot of the page. Returns the base64-encoded image;
   * optionally writes the decoded PNG to `file`. With `fullPage`, the whole
   * scrollable document is captured.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
    const params: Record<string, unknown> = { format: "png" };
    if (options.fullPage) {
      const size = await this.evaluate<{ width: number; height: number }>(() => ({
        width: Math.max(
          document.body.scrollWidth,
          document.documentElement.scrollWidth,
        ),
        height: Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
        ),
      }));
      params.clip = {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
        scale: 1,
      };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.send<{ data: string }>(
      "Page.captureScreenshot",
      params,
    );
    if (options.file) {
      await writeFile(options.file, Buffer.from(data, "base64"));
    }
    return data;
  }

  /**
   * Wait until the page has finished loading and rendering settles before a
   * final screenshot is taken. Polls `document.readyState` until "complete"
   * (tolerating transient evaluation failures while a navigation is in
   * flight), then waits `extraMs` for lazy content to render.
   */
  async waitForSettled(
    extraMs = 1200,
    timeoutMs = 15_000,
  ): Promise<void> {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const state = await this.evaluate<string>(() => document.readyState);
        if (state === "complete") break;
      } catch {
        /* frame navigating; keep waiting */
      }
      if (Date.now() >= deadline) break;
      await delay(250);
    }
    await delay(extraMs);
  }

  /**
   * Snapshot the page's accessible, interactive elements from
   * `Accessibility.getFullAXTree`. Returns one entry per element, pruned to
   * interactive/visible roles (button, textbox, link, checkbox, …): the
   * `ref` is a CSS selector usable with `queryElement`/`click`/`fill`, and
   * `bounds` are the element's viewport box.
   */
  async getAccessibilitySnapshot(): Promise<AccessibilityNode[]> {
    await this.send("DOM.enable");
    const { nodes } = await this.send<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
    );

    const byBackend = new Map<number, AXNode>();
    for (const node of nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      const role = node.role?.value;
      if (typeof role !== "string" || !INTERACTIVE_ROLES.has(role)) continue;
      if (!byBackend.has(node.backendDOMNodeId)) {
        byBackend.set(node.backendDOMNodeId, node);
      }
    }

    const snapshot: AccessibilityNode[] = [];
    const hidden: AccessibilityNode[] = [];
    const entries = [...byBackend.entries()];
    const CONCURRENCY = 8;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      const resolved = await Promise.all(
        batch.map(([backendId, node]) =>
          this.resolveInteractiveNode(backendId, node),
        ),
      );
      for (const item of resolved) {
        if (!item) continue;
        if (item.bounds.width > 0 && item.bounds.height > 0) {
          snapshot.push(item);
        } else {
          item.hidden = true;
          hidden.push(item);
        }
      }
    }
    return [...snapshot, ...hidden];
  }

  private async resolveInteractiveNode(
    backendNodeId: number,
    ax: AXNode,
  ): Promise<AccessibilityNode | null> {
    try {
      const { object } = await this.send<{ object: { objectId?: string } }>(
        "DOM.resolveNode",
        { backendNodeId },
      );
      const objectId = object?.objectId;
      if (!objectId) return null;
      const { result } = await this.send<{ result: RemoteObject }>(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: describeInteractiveElement.toString(),
          returnByValue: true,
        },
      );
      if (result.type !== "object" || result.value === undefined) return null;
      const { ref, x, y, width, height } = result.value as {
        ref: string;
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const expanded = ax.properties?.find((p) => p.name === "expanded")?.value?.value;
      const hidden = width <= 0 || height <= 0;
      return {
        ref,
        role: String(ax.role?.value ?? ""),
        name: String(ax.name?.value ?? ""),
        bounds: { x, y, width, height },
        expanded: typeof expanded === "boolean" ? expanded : null,
        hidden,
      };
    } catch {
      return null;
    }
  }

  /**
   * Deterministic hash of the page's current state: URL (origin + path +
   * search), title, landmark structure (roles + labels), headings, the
   * interactive-element structure (tag/type/role/testid/id/name/label in
   * document order), the current values of form controls, and the visible
   * rendered text. Identical loads produce identical signatures; changing
   * any captured aspect changes it — including filling a field or revealing
   * text (e.g. an in-page "welcome" message after a submit).
   *
   * Note: the in-page function avoids nested function assignments — tsx's
   * esbuild `keepNames` transform wraps those with a `__name(...)` call that
   * would leak into `.toString()` and fail in the page context.
   */
  async pageSignature(): Promise<string> {
    const structure = await this.evaluate<string>(() => {
      const landmarkSel = [
        "header",
        "nav",
        "main",
        "footer",
        "aside",
        '[role="banner"]',
        '[role="navigation"]',
        '[role="main"]',
        '[role="contentinfo"]',
        '[role="complementary"]',
        '[role="region"]',
      ].join(",");
      const interactiveSel = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        "summary",
        "details",
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="combobox"]',
        '[role="tab"]',
        '[contenteditable="true"]',
      ].join(",");

      const labels = new Map<Element, string>();
      const labeled = document.querySelectorAll(
        `${landmarkSel},${interactiveSel}`,
      );
      for (let i = 0; i < labeled.length; i++) {
        const el = labeled[i];
        if (labels.has(el)) continue;
        labels.set(
          el,
          ((node: Element): string => {
            const ariaLabel = node.getAttribute("aria-label");
            if (ariaLabel) return ariaLabel;
            const labelledby = node.getAttribute("aria-labelledby");
            if (labelledby) {
              const ref = document.getElementById(labelledby);
              if (ref) return ref.textContent.trim().slice(0, 80);
            }
            const labeledEl = node as HTMLInputElement;
            if (labeledEl.labels && labeledEl.labels.length) {
              return labeledEl.labels[0].textContent.trim().slice(0, 80);
            }
            if (
              node.localName === "a" ||
              node.localName === "button" ||
              node.localName === "summary"
            ) {
              return node.textContent.trim().slice(0, 80);
            }
            return "";
          })(el),
        );
      }

      const parts: string[] = [];
      parts.push(`${location.origin}${location.pathname}${location.search}`);
      parts.push(document.title);

      const landmarkParts: string[] = [];
      const landmarks = document.querySelectorAll(landmarkSel);
      for (let i = 0; i < landmarks.length; i++) {
        const el = landmarks[i];
        landmarkParts.push(
          `${el.localName}|${el.getAttribute("role") ?? ""}|${labels.get(el) ?? ""}`,
        );
      }
      parts.push(`L:${landmarkParts.join(";")}`);

      const headingParts: string[] = [];
      const headings = document.querySelectorAll("h1,h2,h3,h4,h5,h6");
      for (let i = 0; i < headings.length; i++) {
        headingParts.push(
          `${headings[i].localName}:${headings[i].textContent.trim()}`,
        );
      }
      parts.push(`H:${headingParts.join(";")}`);

      const interactiveParts: string[] = [];
      const interactives = document.querySelectorAll(interactiveSel);
      for (let i = 0; i < interactives.length; i++) {
        const el = interactives[i];
        const expanded = el.getAttribute("aria-expanded")
          ?? (el.localName === "details" && el.hasAttribute("open") ? "true" : null)
          ?? "";
        interactiveParts.push(
          `${el.localName}|${el.getAttribute("type") ?? ""}|${el.getAttribute("role") ?? ""}|${el.getAttribute("data-testid") ?? ""}|${el.id ?? ""}|${el.getAttribute("name") ?? ""}|${el.getAttribute("aria-selected") ?? ""}|${el.getAttribute("data-state") ?? ""}|${expanded}|${labels.get(el) ?? ""}`,
        );
      }
      parts.push(`I:${interactiveParts.join(";")}`);

      const controlParts: string[] = [];
      const controls = document.querySelectorAll("input,select,textarea");
      for (let i = 0; i < controls.length; i++) {
        const el = controls[i] as HTMLInputElement;
        controlParts.push(
          `${el.localName}|${el.getAttribute("type") ?? ""}|${el.getAttribute("data-testid") ?? ""}|${el.id ?? ""}|${el.getAttribute("name") ?? ""}|${labels.get(el) ?? ""}|${el.value}`,
        );
      }
      parts.push(`V:${controlParts.join(";")}`);

      parts.push(
        `T:${(document.body ? document.body.innerText : "").replace(/\s+/g, " ").trim()}`,
      );

      return parts.join("|");
    });
    return fnv1a(structure);
  }

  /**
   * Deterministic hash of an element's identity: tag name, all attributes
   * (sorted by name), and its structural path (ancestor tags + child index
   * from root). Stable across reloads; changes when any attribute or the
   * element's position changes. Throws if `selector` matches nothing.
   */
  async fingerprint(selector: string): Promise<string> {
    const structure = await this.evaluate<string>(
      (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) {
          throw new Error(
            `fingerprint: no element matches selector "${sel}"`,
          );
        }

        const parts: string[] = [];
        parts.push(el.localName);

        const attrs: string[] = [];
        for (let i = 0; i < el.attributes.length; i++) {
          const attr = el.attributes[i];
          attrs.push(`${attr.name}="${attr.value}"`);
        }
        attrs.sort();
        parts.push(attrs.join(","));

        const pathParts: string[] = [];
        let node: Element | null = el;
        while (node && node.nodeType === 1) {
          const parent: Element | null = node.parentElement;
          let index = 1;
          if (parent) {
            const kids = parent.children;
            for (let i = 0; i < kids.length; i++) {
              if (kids[i] === node) {
                index = i + 1;
                break;
              }
            }
          }
          pathParts.unshift(`${node.localName}:${index}`);
          node = parent;
        }
        parts.push(pathParts.join(">"));

        return parts.join("|");
      },
      selector,
    );
    return fnv1a(structure);
  }

  /**
   * Poll `predicate` (an in-page function or expression) until it returns a
   * truthy value, then resolve with that value. Checks immediately, then
   * every `pollMs`. Throws `WaitTimeoutError` if it never becomes truthy
   * within `timeoutMs`. Errors thrown inside the predicate propagate
   * immediately.
   */
  async waitFor<T = unknown>(
    predicate: string | ((...args: unknown[]) => T),
    opts: WaitForOptions = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const pollMs = opts.pollMs ?? 200;
    const deadline = Date.now() + timeoutMs;

    let result = await this.evaluate<T>(predicate);
    if (result) return result;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const desc =
          opts.desc ??
          (typeof predicate === "string"
            ? predicate
            : predicate.toString());
        throw new WaitTimeoutError(
          `Timed out after ${timeoutMs}ms waiting for: ${desc}`,
        );
      }
      await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
      result = await this.evaluate<T>(predicate);
      if (result) return result;
    }
  }
}

export interface PageInfo {
  targetId: string;
  url: string;
  title: string;
}

export interface WaitForOptions {
  timeoutMs?: number;
  pollMs?: number;
  desc?: string;
}

export interface ElementLocation {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface ScreenshotOptions {
  file?: string;
  fullPage?: boolean;
}

export interface AccessibilityNode {
  ref: string;
  role: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
  expanded?: boolean | null;
  hidden?: boolean;
}

export class BrowserSession {
  readonly client: CdpClient;
  readonly browser: LaunchedBrowser;
  private closed = false;
  private readonly viewportWidth: number;
  private readonly viewportHeight: number;

  private constructor(browser: LaunchedBrowser, client: CdpClient, viewportWidth: number, viewportHeight: number) {
    this.browser = browser;
    this.client = client;
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
  }

  static async launch(options: LaunchOptions = {}): Promise<BrowserSession> {
    const browser = await launch(options);
    const client = await connect(browser.wsUrl);
    return new BrowserSession(browser, client, options.viewportWidth ?? 1280, options.viewportHeight ?? 720);
  }

  /**
   * Create a BrowserSession from an existing CDP connection (e.g. connecting to
   * a browser-use-launched Chrome via its debug port). The returned session does
   * NOT own the browser lifecycle — call `client.close()` on disconnect, but do
   * NOT kill the browser process.
   */
  static fromCdpClient(
    client: CdpClient,
    viewportWidth = 1280,
    viewportHeight = 720,
  ): BrowserSession {
    const stubBrowser: LaunchedBrowser = {
      wsUrl: "",
      pid: 0,
      port: 0,
      headless: true,
      close: async () => {},
    };
    return new BrowserSession(stubBrowser, client, viewportWidth, viewportHeight);
  }

  async newPage(url = "about:blank"): Promise<Page> {
    const { targetId } = await this.client.send<{ targetId: string }>(
      "Target.createTarget",
      { url },
    );
    return this.attachPage(targetId);
  }

  async attachPage(targetId: string): Promise<Page> {
    const { sessionId } = await this.client.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    const page = new Page(this.client, sessionId, targetId);
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: this.viewportWidth,
      height: this.viewportHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Drain the initial load event (about:blank or the createTarget URL) so
    // later navigate() calls match their own Page.loadEventFired.
    await page.once("Page.loadEventFired", 150).catch(() => {});
    return page;
  }

  async pages(): Promise<PageInfo[]> {
    const { targetInfos } = await this.client.send<{
      targetInfos: {
        targetId: string;
        type: string;
        url: string;
        title: string;
      }[];
    }>("Target.getTargets");
    return targetInfos
      .filter((info) => info.type === "page")
      .map(({ targetId, url, title }) => ({ targetId, url, title }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
    await this.browser.close();
  }
}

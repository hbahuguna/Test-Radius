/**
 * In-page helper functions used by the recorder. Each is stringified and
 * evaluated inside the page, so it must be self-contained (no imports, no
 * closure over module state). Nested helpers are arrow functions only —
 * named function assignments get wrapped with `__name(...)` by tsx's
 * `keepNames` transform and fail in the page context.
 */

export interface ElementCapture {
  found: boolean;
  locators: string[];
  fingerprintSource: string;
  label: string;
}

export function captureElementInfo(sel: string): ElementCapture {
  const el = document.querySelector(sel);
  if (!el) return { found: false, locators: [], fingerprintSource: "", label: "" };

  const locators: string[] = [];
  const testid = el.getAttribute("data-testid");
  if (testid) {
    locators.push(`[data-testid="${CSS.escape(testid)}"]`);
  }
  if (el.id) {
    locators.push(`#${CSS.escape(el.id)}`);
  }
  const pathParts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    const parent: Element | null = node.parentElement;
    let nth = 1;
    if (parent) {
      const kids = parent.children;
      let i = 0;
      for (; i < kids.length; i++) {
        if (kids[i] === node) {
          nth = i + 1;
          break;
        }
      }
    }
    pathParts.unshift(`${node.localName}:nth-of-type(${nth})`);
    node = parent;
  }
  if (pathParts.length) {
    locators.push(pathParts.join(">"));
  }
  const text = (el.textContent ?? "").trim();
  if (el.localName === "button" || el.localName === "a" || el.localName === "summary") {
    if (text) {
      locators.push(`text="${text.slice(0, 80)}"`);
    }
  }

  const fpParts: string[] = [];
  fpParts.push(el.localName);
  const attrs: string[] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    attrs.push(`${el.attributes[i].name}="${el.attributes[i].value}"`);
  }
  attrs.sort();
  fpParts.push(attrs.join(","));
  const path: string[] = [];
  let n2: Element | null = el;
  while (n2 && n2.nodeType === 1) {
    const parent: Element | null = n2.parentElement;
    let index = 1;
    if (parent) {
      const kids = parent.children;
      for (let i = 0; i < kids.length; i++) {
        if (kids[i] === n2) {
          index = i + 1;
          break;
        }
      }
    }
    path.unshift(`${n2.localName}:${index}`);
    n2 = parent;
  }
  fpParts.push(path.join(">"));

  let label = text.slice(0, 120);
  if (!label) {
    const labeledEl = el as HTMLInputElement;
    if (labeledEl.labels && labeledEl.labels.length) {
      label = labeledEl.labels[0].textContent.trim().slice(0, 120);
    } else {
      label = el.getAttribute("placeholder") ?? "";
    }
  }
  return { found: true, locators, fingerprintSource: fpParts.join("|"), label };
}

export function collectVisibleRefs(): string[] {
  const refs: string[] = [];
  const all = document.querySelectorAll("[id],[data-testid]");
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const testid = el.getAttribute("data-testid");
      refs.push(
        testid ? `[data-testid="${CSS.escape(testid)}"]` : `#${CSS.escape(el.id)}`,
      );
    }
  }
  return refs;
}

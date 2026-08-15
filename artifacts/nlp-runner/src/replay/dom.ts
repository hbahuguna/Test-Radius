/**
 * In-page locator resolution for the replay engine. Stringified and evaluated
 * inside the page via `Page.evaluate`, so `resolveElement` must be fully
 * self-contained: no imports, no closure over module state, and no nested
 * function definitions (esbuild annotates nested functions with an `__name`
 * helper that is not defined inside the page). The fingerprint algorithm
 * mirrors `BrowserSession.fingerprint` so recorded fingerprints compare equal.
 */

export interface ResolveResult {
  found: boolean;
  /** CSS selector that re-resolves to the chosen element (usable with click/fill/select/scroll). */
  selector: string | null;
  /** The fingerprint computed for the chosen element (drift signal). */
  fingerprint: string | null;
  /** Whether the fingerprint matches the expected (recorded) one. */
  fingerprintMatch: boolean;
  /** The locator string that resolved (for diagnostics). */
  matchedLocator: string | null;
}

/**
 * Resolve the ordered locator candidates for a recorded element. Prefers the
 * first candidate whose fingerprint matches the recorded one; falls back to
 * the first candidate that resolves at all (with `fingerprintMatch: false`)
 * so a removed stable attribute still replays via a fallback locator.
 */
export function resolveElement(
  locators: string[],
  expectedFingerprint: string | null,
): ResolveResult {
  let firstFound: {
    el: Element;
    locator: string;
    fingerprint: string;
    selector: string;
  } | null = null;

  // Interactive elements eligible for text-based matching. Kept broad so tabs,
  // menu items, and custom roles are found in addition to plain links/buttons.
  // Submit/button inputs are included too: an `<input type="submit" value="SUBSCRIBE">`
  // has no textContent, so without value-matching the text="..." locator could
  // never resolve it.
  const TEXT_SEARCH_SEL = 'button,a,summary,input[type="submit"],input[type="button"],input[type="reset"],[role="tab"],[role="button"],[role="link"],[role="menuitem"],[role="option"],li';

  for (const loc of locators) {
    let el: Element | null = null;
    if (loc.startsWith('text="')) {
      const needle = loc.slice(6, -1);
      const all = document.querySelectorAll(TEXT_SEARCH_SEL);
      for (let i = 0; i < all.length; i++) {
        const candidate = all[i] as Element;
        if ((candidate.textContent ?? "").trim() === needle) {
          el = candidate;
          break;
        }
        if (
          candidate instanceof HTMLInputElement &&
          (candidate.value ?? "").trim() === needle
        ) {
          el = candidate;
          break;
        }
      }
      if (!el) {
        const needleLower = needle.toLowerCase();
        for (let i = 0; i < all.length; i++) {
          const candidate = all[i] as Element;
          if ((candidate.textContent ?? "").trim().toLowerCase() === needleLower) {
            el = candidate;
            break;
          }
          if (
            candidate instanceof HTMLInputElement &&
            (candidate.value ?? "").trim().toLowerCase() === needleLower
          ) {
            el = candidate;
            break;
          }
        }
      }
    } else {
      try {
        el = document.querySelector(loc);
      } catch {
        el = null;
      }
    }
    if (!el) continue;

    // For text locators, keep the `text="..."` form as the replay selector.
    // session.ts understands this format natively and resolves it at click-time,
    // which avoids the race condition caused by converting to a brittle nth-child
    // path here (in evaluate A) and then querying that path in evaluate B.
    const selector = loc;

    // Fingerprint source: `localName|sorted-attrs|ancestor-path`, then FNV-1a.
    const attrs: string[] = [];
    for (let i = 0; i < el.attributes.length; i++) {
      attrs.push(`${el.attributes[i].name}="${el.attributes[i].value}"`);
    }
    attrs.sort();

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

    const source = `${el.localName}|${attrs.join(",")}|${pathParts.join(">")}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    const fingerprint = (hash >>> 0).toString(16).padStart(8, "0");

    if (expectedFingerprint && fingerprint === expectedFingerprint) {
      return {
        found: true,
        selector,
        fingerprint,
        fingerprintMatch: true,
        matchedLocator: loc,
      };
    }
    if (!firstFound) {
      firstFound = { el, locator: loc, fingerprint, selector };
    }
  }

  if (firstFound) {
    return {
      found: true,
      selector: firstFound.selector,
      fingerprint: firstFound.fingerprint,
      fingerprintMatch: false,
      matchedLocator: firstFound.locator,
    };
  }
  return {
    found: false,
    selector: null,
    fingerprint: null,
    fingerprintMatch: false,
    matchedLocator: null,
  };
}

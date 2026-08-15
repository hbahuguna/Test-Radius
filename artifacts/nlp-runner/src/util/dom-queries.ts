/**
 * Generic in-page DOM queries shared by the recorder and the replay engine.
 * Each is stringified and evaluated inside the page, so it must be
 * self-contained (no imports, no closure over module state).
 *
 * All functions handle `text="<needle>"` locators (produced by the replay
 * engine's resolveElement when an element was matched by visible text) in
 * addition to plain CSS selectors. The text-search logic is inlined in each
 * function rather than shared via a helper so that stringified evaluations
 * remain fully self-contained.
 */

export function elementText(sel: string): string {
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
  if (!el) return "";
  return (el.textContent ?? "").trim();
}

export function elementValue(sel: string): string {
  let el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  if (sel.startsWith('text="')) {
    const needle = sel.slice(6, -1);
    const all = document.querySelectorAll("input,textarea,select");
    el = null;
    for (let i = 0; i < all.length; i++) {
      if ((all[i].textContent ?? "").trim() === needle) { el = all[i] as HTMLInputElement; break; }
    }
  } else {
    try { el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null; } catch { el = null; }
  }
  if (!el) return "";
  return "value" in el ? String(el.value) : "";
}

export function elementIsVisible(sel: string): boolean {
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
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

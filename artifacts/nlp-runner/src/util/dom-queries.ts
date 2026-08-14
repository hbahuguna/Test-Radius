/**
 * Generic in-page DOM queries shared by the recorder and the replay engine.
 * Each is stringified and evaluated inside the page, so it must be
 * self-contained (no imports, no closure over module state).
 */

export function elementText(sel: string): string {
  const el = document.querySelector(sel);
  if (!el) return "";
  return (el.textContent ?? "").trim();
}

export function elementValue(sel: string): string {
  const el = document.querySelector(sel) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement
    | null;
  if (!el) return "";
  return "value" in el ? String(el.value) : "";
}

export function elementIsVisible(sel: string): boolean {
  const el = document.querySelector(sel);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

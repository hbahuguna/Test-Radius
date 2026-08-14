const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NAME_RE = /\b[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,2}\b/g;
const NUMBER_RE = /\d[\d.,]*/g;
const PUNCT_RE = /[^\p{L}\p{N}\s{}@]/gu;

const NON_NAME_WORDS = new Set([
  "about", "account", "add", "admin", "blog", "browse", "cancel", "careers",
  "cart", "checkout", "contact", "create", "delete", "edit", "faq", "help",
  "home", "in", "jobs", "log", "login", "new", "out", "page", "pages",
  "pricing", "privacy", "product", "products", "profile", "register",
  "save", "search", "settings", "sign", "submit", "support", "terms",
  "update", "view",
]);

export type SlotKind = "email" | "name" | "number";

export interface DetectedSlot {
  kind: SlotKind;
  value: string;
  index: number;
  end: number;
}

export function normalizeQuery(text: string): string {
  const emails: string[] = [];
  const masked = text.replace(EMAIL_RE, (m) => {
    emails.push(m);
    return "@";
  });
  let out = masked.replace(PUNCT_RE, " ").replace(/\s+/g, " ").trim().toLowerCase();
  for (const email of emails) {
    out = out.replace("@", email);
  }
  return out;
}

function matchAll(re: RegExp, text: string, kind: SlotKind): DetectedSlot[] {
  const out: DetectedSlot[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ kind, value: m[0], index: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/**
 * Detect slot values present in `text`, mirroring `slotNormalize` exactly so
 * the two never diverge. Returns matches sorted by position; overlapping
 * matches are de-duplicated (earlier/longer wins). Name matches are dropped
 * when every word is a non-name word (e.g. "Sign In").
 */
export function detectQuerySlots(text: string): DetectedSlot[] {
  const raw = [
    ...matchAll(EMAIL_RE, text, "email"),
    ...matchAll(NAME_RE, text, "name"),
    ...matchAll(NUMBER_RE, text, "number"),
  ].sort((a, b) => a.index - b.index || a.end - b.end);

  const accepted: DetectedSlot[] = [];
  for (const slot of raw) {
    const last = accepted[accepted.length - 1];
    if (last && slot.index < last.end) continue; // overlaps an accepted match
    if (slot.kind === "name") {
      const words = slot.value.toLowerCase().split(/\s+/);
      if (words.every((w) => NON_NAME_WORDS.has(w))) continue;
    }
    accepted.push(slot);
  }
  return accepted;
}

export function slotNormalize(text: string): string {
  const slots = detectQuerySlots(text);
  if (slots.length === 0) return normalizeQuery(text);
  let out = text;
  for (const slot of [...slots].reverse()) {
    out = out.slice(0, slot.index) + "{" + slot.kind + "}" + out.slice(slot.end);
  }
  return normalizeQuery(out);
}

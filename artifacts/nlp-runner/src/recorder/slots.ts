import type { SlotKind } from "../cache/types.js";

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const NUMBER_RE = /^\d[\d.,]*$/;
const NAME_RE = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/;

export function detectSlotKind(value: string): SlotKind | null {
  const trimmed = value.trim();
  if (EMAIL_RE.test(trimmed)) return "email";
  if (NUMBER_RE.test(trimmed)) return "number";
  if (NAME_RE.test(trimmed)) return "name";
  return null;
}

export interface DetectedSlot {
  name: string;
  kind: SlotKind;
}

export function detectSlot(value: string): DetectedSlot | null {
  const kind = detectSlotKind(value);
  if (!kind) return null;
  return { name: kind, kind };
}

/**
 * Query slot extraction (Story QF-53).
 *
 * At record start the agent scans the natural-language query for concrete
 * slot values (emails, person names, numbers) and canonicalises the query by
 * replacing them with `{email}` / `{name}` / `{number}` placeholders. The
 * detected slots are stored alongside the recorded test so the same flow can
 * be replayed with new values, and the canonical form is used as the
 * normalised query for similarity matching.
 *
 * Detection reuses `detectQuerySlots` from the embeddings module so the
 * canonical query and the extracted slots are always consistent.
 */
import { detectQuerySlots, type SlotKind } from "../embeddings/normalize.js";
import { slotNormalize } from "../embeddings/normalize.js";

export interface QuerySlot {
  name: SlotKind;
  kind: SlotKind;
  defaultValue: string;
}

export interface SlotResult {
  slots: QuerySlot[];
  canonicalQuery: string;
}

export function canonicalizeQuery(query: string): string {
  return slotNormalize(query);
}

export function extractQuerySlots(query: string): SlotResult {
  const detected = detectQuerySlots(query);
  const seen = new Set<string>();
  const slots: QuerySlot[] = [];
  for (const d of detected) {
    if (seen.has(d.kind)) continue;
    seen.add(d.kind);
    slots.push({ name: d.kind, kind: d.kind, defaultValue: d.value });
  }
  return { slots, canonicalQuery: slotNormalize(query) };
}

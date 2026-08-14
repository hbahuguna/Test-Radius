/**
 * Site memory (Story QF-54 / QF-59).
 *
 * After a test is recorded on a domain, persist a *skeleton* (entry URL, step
 * count, slot kinds, milestones, canonical query) plus a memory per slot kind
 * into `site_memory`. When recording a new query on the SAME domain, the most
 * recent skeleton is offered to the planner as reusable context so it can emit
 * fewer fresh steps. Memory is cleared per-site (or globally) from the CLI.
 */
import type { DataStore } from "../cache/queries.js";
import type { Test, Step, Slot } from "../cache/types.js";

export interface Skeleton {
  testId: number;
  entryUrl: string | null;
  site: string;
  normalizedQuery: string | null;
  slotKinds: string[];
  stepCount: number;
  milestones: string[];
}

export function siteFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/[^/]*$/, "/")}`;
  } catch {
    return "unknown";
  }
}

export function seedSiteMemory(
  store: DataStore,
  test: Test,
  steps: Step[],
  slots: Array<Pick<Slot, "kind" | "defaultValue">>,
  milestones: string[],
): void {
  const skeleton: Skeleton = {
    testId: test.id,
    entryUrl: test.entryUrl,
    site: siteFromUrl(test.entryUrl ?? ""),
    normalizedQuery: test.normalizedQuery,
    slotKinds: slots.map((s) => s.kind),
    stepCount: steps.length,
    milestones,
  };
  store.upsertMemory({
    site: skeleton.site,
    kind: "skeleton",
    key: test.normalizedQuery ?? `test-${test.id}`,
    value: skeleton,
  });
  for (const slot of slots) {
    store.upsertMemory({
      site: skeleton.site,
      kind: "slot",
      key: slot.kind,
      value: { defaultValue: slot.defaultValue, testId: test.id },
      confidence: 0.8,
    });
  }
}

export function getSkeleton(store: DataStore, site: string): Skeleton | null {
  const rows = store
    .listMemory(site, "skeleton")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const row of rows) {
    const v = row.value as Skeleton | undefined;
    if (v && v.entryUrl) return { ...v, site };
  }
  return null;
}

export function clearSiteMemory(store: DataStore, site?: string): number {
  return site === undefined ? store.clearAllMemory() : store.deleteMemory(site);
}

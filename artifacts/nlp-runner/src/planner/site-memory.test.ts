import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../cache/db.js";
import { DataStore } from "../cache/queries.js";
import { seedSiteMemory, getSkeleton, clearSiteMemory, siteFromUrl } from "./site-memory.js";
import type { Step, Test } from "../cache/types.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "qf-mem-"));
  const db = openDatabase(dir);
  return { dir, store: new DataStore(db) };
}

const testRow = (id: number, url: string, q: string): Test => ({
  id, name: "t", source: "recorder", query: q, normalizedQuery: q, queryEmbedding: null,
  entryUrl: url, stepHash: "h", description: null, createdAt: "", updatedAt: "",
});

const step = (id: number, action: Step["action"]): Step => ({
  id, testId: 1, idx: 0, action, selector: "s", value: null, locators: [],
  elementFingerprint: "fp", pageSignatureBefore: "a", pageSignatureAfter: "b",
  waitCondition: null, assertion: null,
});

describe("site-memory (QF-59 helpers)", () => {
  it("seeds a skeleton retrievable by site", () => {
    const { store, dir } = makeStore();
    seedSiteMemory(store, testRow(1, "https://example.com/signup", "register {email}"),
      [step(1, "navigate"), step(2, "click")],
      [{ kind: "email", defaultValue: "bob@x.com" }],
      ["open", "submit"]);
    const sk = getSkeleton(store, "https://example.com/");
    expect(sk?.testId).toBe(1);
    expect(sk?.slotKinds).toEqual(["email"]);
    expect(sk?.stepCount).toBe(2);
    expect(sk?.normalizedQuery).toBe("register {email}");
    rmSync(dir, { recursive: true, force: true });
  });

  it("same-origin different paths share site memory", () => {
    const { store, dir } = makeStore();
    seedSiteMemory(store, testRow(1, "https://example.com/login", "sign in"), [step(1, "click")], [], ["m"]);
    expect(getSkeleton(store, "https://example.com/")).toBeTruthy(); // login and signup share origin root
    rmSync(dir, { recursive: true, force: true });
  });

  it("clearSiteMemory(site) removes only that site's entries", () => {
    const { store, dir } = makeStore();
    seedSiteMemory(store, testRow(1, "https://a.com/x", "q1"), [step(1, "click")], [], ["m"]);
    seedSiteMemory(store, testRow(2, "https://b.com/y", "q2"), [step(1, "click")], [], ["m"]);
    expect(clearSiteMemory(store, "https://a.com/")).toBe(1); // one skeleton entry (no slots seeded)
    expect(getSkeleton(store, "https://a.com/")).toBeNull();
    expect(getSkeleton(store, "https://b.com/")).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("clearSiteMemory() with no site clears everything", () => {
    const { store, dir } = makeStore();
    seedSiteMemory(store, testRow(1, "https://a.com/x", "q1"), [step(1, "click")], [{ kind: "email", defaultValue: "a@b.c" }], ["m"]);
    seedSiteMemory(store, testRow(2, "https://b.com/y", "q2"), [step(1, "click")], [], ["m"]);
    const count = clearSiteMemory(store);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(getSkeleton(store, "https://a.com/")).toBeNull();
    expect(getSkeleton(store, "https://b.com/")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("siteFromUrl normalises to origin + path root", () => {
    expect(siteFromUrl("https://example.com/signup")).toBe("https://example.com/");
    expect(siteFromUrl("https://example.com/login?x=1")).toBe("https://example.com/");
    expect(siteFromUrl("https://example.com/app/page")).toBe("https://example.com/app/");
    expect(siteFromUrl("not a url")).toBe("unknown");
  });
});

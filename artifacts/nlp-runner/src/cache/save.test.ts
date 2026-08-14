import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { DataStore } from "./queries.js";

const tempDirs: string[] = [];
const openDbs: import("better-sqlite3").Database[] = [];

function makeStore(): DataStore {
  const dir = mkdtempSync(join(tmpdir(), "qf-save-"));
  tempDirs.push(dir);
  const db = openDatabase(dir);
  openDbs.push(db);
  return new DataStore(db);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function baseSteps() {
  return [
    { action: "navigate" as const, value: "/signup", selector: null },
    {
      action: "fill" as const,
      selector: "[data-testid=signup-email]",
      value: "bob@x.com",
      locators: ["[data-testid=signup-email]", "#signup-email"],
      elementFingerprint: "fp1",
      pageSignatureBefore: "sig-before",
      pageSignatureAfter: "sig-after",
      waitCondition: { kind: "element" as const, ref: "[data-testid=signup-email]" },
    },
  ];
}

describe("saveTest", () => {
  it("creates a test with steps and slots atomically", () => {
    const store = makeStore();
    const result = store.saveTest({
      name: "signup flow",
      source: "recorder",
      entryUrl: "http://127.0.0.1:3123/signup",
      stepHash: "abc123",
      description: "recorded",
      steps: baseSteps(),
      slots: [{ name: "email", kind: "email", defaultValue: "bob@x.com" }],
    });
    expect(result.created).toBe(true);
    const test = store.getTestWithSteps(result.id);
    expect(test?.name).toBe("signup flow");
    expect(test?.entryUrl).toBe("http://127.0.0.1:3123/signup");
    expect(test?.stepHash).toBe("abc123");
    expect(test?.steps).toHaveLength(2);
    expect(test?.steps[1].locators).toEqual([
      "[data-testid=signup-email]",
      "#signup-email",
    ]);
    const slots = store.listSlotsByTest(result.id);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ name: "email", kind: "email", defaultValue: "bob@x.com" });
  });

  it("re-saving with the same entry_url + step_hash updates in place", () => {
    const store = makeStore();
    const input = {
      name: "signup flow",
      source: "recorder" as const,
      entryUrl: "http://127.0.0.1:3123/signup",
      stepHash: "abc123",
      steps: baseSteps(),
      slots: [{ name: "email", kind: "email" as const, defaultValue: "bob@x.com" }],
    };
    const first = store.saveTest(input);
    const second = store.saveTest({ ...input, name: "signup flow v2" });
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(store.listTests()).toHaveLength(1);
    expect(store.getTest(first.id)?.name).toBe("signup flow v2");
  });

  it("a different step_hash creates a new test even with the same entry_url", () => {
    const store = makeStore();
    const base = {
      name: "signup flow",
      source: "recorder" as const,
      entryUrl: "http://127.0.0.1:3123/signup",
      steps: baseSteps(),
      slots: [] as { name: string; kind: "email"; defaultValue: string }[],
    };
    const first = store.saveTest({ ...base, stepHash: "aaa" });
    const second = store.saveTest({ ...base, stepHash: "bbb" });
    expect(second.id).not.toBe(first.id);
    expect(store.listTests()).toHaveLength(2);
  });

  it("persists entry_url and step_hash columns", () => {
    const store = makeStore();
    const test = store.createTest({
      name: "manual",
      source: "recorder",
      entryUrl: "http://127.0.0.1:3123/login",
      stepHash: "deadbeef",
    });
    expect(store.getTest(test.id)).toMatchObject({
      entryUrl: "http://127.0.0.1:3123/login",
      stepHash: "deadbeef",
    });
  });
});

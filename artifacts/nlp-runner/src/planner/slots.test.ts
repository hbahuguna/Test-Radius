import { describe, expect, it } from "vitest";
import { canonicalizeQuery, extractQuerySlots } from "./slots.js";

describe("extractQuerySlots (QF-53)", () => {
  it("extracts an email slot from the query", () => {
    const { slots, canonicalQuery } = extractQuerySlots("register bob@x.com");
    expect(slots).toEqual([
      { name: "email", kind: "email", defaultValue: "bob@x.com" },
    ]);
    expect(canonicalQuery).toBe("register {email}");
  });

  it("extracts a person-name slot", () => {
    const { slots, canonicalQuery } = extractQuerySlots("register John Smith as an admin");
    expect(slots).toEqual([
      { name: "name", kind: "name", defaultValue: "John Smith" },
    ]);
    expect(canonicalQuery).toBe("register {name} as an admin");
  });

  it("extracts a number slot", () => {
    const { slots, canonicalQuery } = extractQuerySlots("add 3 items to the cart");
    expect(slots).toEqual([
      { name: "number", kind: "number", defaultValue: "3" },
    ]);
    expect(canonicalQuery).toBe("add {number} items to the cart");
  });

  it("returns zero slots for a query with no variables", () => {
    const { slots, canonicalQuery } = extractQuerySlots("check the pricing page");
    expect(slots).toEqual([]);
    expect(canonicalQuery).toBe("check the pricing page");
  });

  it("deduplicates slots by kind (first wins)", () => {
    const { slots } = extractQuerySlots("send bob@x.com to alice@y.com and cc the team");
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ kind: "email", defaultValue: "bob@x.com" });
  });

  it("canonicalizeQuery equals slotNormalize for mixed slots", () => {
    expect(canonicalizeQuery("register John Smith bob@x.com with 5 guests")).toBe(
      "register {name} {email} with {number} guests",
    );
  });

  it("does not treat action labels like 'Sign In' as a name slot", () => {
    const { slots } = extractQuerySlots("click the Sign In button");
    expect(slots).toEqual([]);
  });
});

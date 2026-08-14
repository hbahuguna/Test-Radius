import { describe, expect, it } from "vitest";
import { normalizeQuery, slotNormalize } from "./normalize.js";

describe("normalizeQuery", () => {
  it("strips punctuation and collapses whitespace", () => {
    expect(normalizeQuery("HELLO,   World!!")).toBe("hello world");
  });

  it("lowercases but keeps emails intact", () => {
    expect(normalizeQuery("Register a user bob@x.com!")).toBe(
      "register a user bob@x.com",
    );
  });

  it("keeps slot placeholders", () => {
    expect(normalizeQuery("register a user {email}")).toBe(
      "register a user {email}",
    );
  });
});

describe("slotNormalize", () => {
  it("replaces an email with {email}", () => {
    expect(slotNormalize("Register a user bob@x.com!")).toBe(
      "register a user {email}",
    );
  });

  it("replaces a number with {number}", () => {
    expect(slotNormalize("add 3 items")).toBe("add {number} items");
  });

  it("replaces a person name inside a sentence with {name}", () => {
    expect(slotNormalize("register John Smith as an admin")).toBe(
      "register {name} as an admin",
    );
  });

  it("does not treat action labels like 'Sign In' as a name", () => {
    expect(slotNormalize("click the Sign In button")).toBe(
      "click the sign in button",
    );
  });

  it("leaves a plain sentence without slots untouched", () => {
    expect(slotNormalize("check the pricing page")).toBe(
      "check the pricing page",
    );
  });
});

import { describe, expect, it } from "vitest";
import type { LLMClient } from "../llm/client.js";
import {
  MAX_NAME_CHARS,
  MAX_NAME_WORDS,
  summarizeTestName,
  summarizeTestNameFallback,
  uniqueTestName,
} from "./test-name.js";

function fakeLlm(text: string, shouldThrow = false): LLMClient {
  return {
    chat: async () => {
      if (shouldThrow) throw new Error("llm down");
      return { text };
    },
  } as LLMClient;
}

describe("summarizeTestNameFallback", () => {
  it("truncates a long query to the first few words", () => {
    const q = "register a new user on the signup page with email and password and verify the welcome message appears";
    const name = summarizeTestNameFallback(q);
    expect(name.split(" ").length).toBeLessThanOrEqual(MAX_NAME_WORDS);
    expect(name).toBe("register a new user on the signup");
  });

  it("caps the length", () => {
    const q = "x".repeat(200);
    expect(summarizeTestNameFallback(q).length).toBeLessThanOrEqual(MAX_NAME_CHARS);
  });

  it("returns a placeholder for empty input", () => {
    expect(summarizeTestNameFallback("   ")).toBe("untitled test");
  });
});

describe("summarizeTestName", () => {
  it("uses the LLM summary when available", async () => {
    const llm = fakeLlm('"Signup flow"');
    expect(await summarizeTestName(llm, "register a user on the signup page")).toBe("Signup flow");
  });

  it("caps the LLM name length", async () => {
    const llm = fakeLlm("one two three four five six seven eight nine");
    const name = await summarizeTestName(llm, "query");
    expect(name.split(" ").length).toBeLessThanOrEqual(MAX_NAME_WORDS);
  });

  it("falls back when the LLM response is empty", async () => {
    const llm = fakeLlm("   ");
    expect(await summarizeTestName(llm, "check the pricing page")).toBe("check the pricing page");
  });

  it("falls back when the LLM throws", async () => {
    const llm = fakeLlm("ignored", true);
    expect(await summarizeTestName(llm, "log in with email and password")).toBe(
      "log in with email and password",
    );
  });

  it("falls back without an LLM", async () => {
    expect(await summarizeTestName(undefined, "join the pricing waitlist")).toBe(
      "join the pricing waitlist",
    );
  });
});

describe("uniqueTestName", () => {
  it("keeps the base name when unique", () => {
    expect(uniqueTestName(["a", "b"], "Signup flow")).toBe("Signup flow");
  });

  it("appends an incrementing suffix on collision", () => {
    expect(uniqueTestName(["Signup flow", "Signup flow (2)"], "Signup flow")).toBe(
      "Signup flow (3)",
    );
  });

  it("handles repeated identical names", () => {
    const names = ["Checkout", "Checkout (2)", "Checkout (3)"];
    expect(uniqueTestName(names, "Checkout")).toBe("Checkout (4)");
  });

  it("falls back for a blank base", () => {
    expect(uniqueTestName([], "   ")).toBe("untitled test");
  });
});

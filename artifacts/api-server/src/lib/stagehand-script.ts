import type { Assertion } from "./stagehand-client";

// ============================================================
// Types
// ============================================================

/**
 * Normalised action coming out of either browser-auto or browser-agent
 * step events.  The frontend should flatten both formats into this shape
 * before calling `generateScript`.
 */
export interface ScriptAction {
  type: string;
  target?: string;
  value?: string;
  url?: string;
  description?: string;
}

// ============================================================
// Action → Script Line
// ============================================================

function escapeTS(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function formatAction(action: ScriptAction): string {
  const desc = action.description ? `  // ${action.description}` : "";

  switch (action.type) {
    case "click": {
      const target = action.target ?? "the element";
      return `    await stagehand.act("click ${escapeTS(target)}");${desc}`;
    }

    case "type":
    case "input": {
      const target = action.target ?? "the input field";
      const value = action.value ?? "";
      return `    await stagehand.act("type '${escapeTS(value)}' into ${escapeTS(target)}");${desc}`;
    }

    case "navigate":
    case "goto": {
      const url = action.url ?? action.target ?? "";
      return `    await page.goto("${escapeTS(url)}");${desc}`;
    }

    case "scroll":
      return `    await stagehand.act("scroll down the page");${desc}`;

    case "wait":
      return `    await stagehand.act("wait for the page to load");${desc}`;

    case "extract":
      return `    await stagehand.extract("extract data from the page", z.object({ data: z.string() }));${desc}`;

    default:
      return `    // TODO: ${action.type} — ${action.description ?? action.target ?? ""}`;
  }
}

// ============================================================
// Assertion → Script Lines
// ============================================================

function formatAssertion(a: Assertion, index: number): string {
  switch (a.type) {
    case "visibility": {
      const target = a.target ?? "element";
      return [
        `    // Assertion ${index + 1}: visibility`,
        `    {`,
        `      const r = await stagehand.extract("check if ${escapeTS(target)} is visible on the page", z.object({ visible: z.boolean() }));`,
        `      if (!r.visible) throw new Error("Assertion ${index + 1} failed: ${escapeTS(target)} not visible");`,
        `    }`,
      ].join("\n");
    }

    case "text": {
      const expected = a.expected ?? "";
      return [
        `    // Assertion ${index + 1}: text`,
        `    {`,
        `      const r = await stagehand.extract("check if the page contains the text '${escapeTS(expected)}'", z.object({ found: z.boolean() }));`,
        `      if (!r.found) throw new Error("Assertion ${index + 1} failed: text '${escapeTS(expected)}' not found");`,
        `    }`,
      ].join("\n");
    }

    case "url": {
      const pattern = a.pattern ?? "";
      return [
        `    // Assertion ${index + 1}: url`,
        `    if (!page.url().includes("${escapeTS(pattern)}"))`,
        `      throw new Error("Assertion ${index + 1} failed: URL does not contain '${escapeTS(pattern)}'");`,
      ].join("\n");
    }

    default:
      return `    // Assertion ${index + 1}: unknown type`;
  }
}

// ============================================================
// Script Generation
// ============================================================

/**
 * Generate a self-contained Stagehand TypeScript test script from a
 * browser-auto / browser-agent action history.
 *
 * The returned string is a valid `.ts` file that can be run with
 * `npx tsx <file>`.
 */
export function generateScript(
  url: string,
  goal: string,
  actions: ScriptAction[],
  assertions: Assertion[],
): string {
  const ts = new Date().toISOString();

  const steps = actions.map((a) => formatAction(a)).join("\n\n");
  const assertionLines = assertions.map((a, i) => formatAssertion(a, i)).join("\n\n");

  return `/**
 * Auto-generated TestRadius test script
 * Goal: ${goal}
 * URL: ${url}
 * Generated: ${ts}
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

async function test() {
  const stagehand = new Stagehand({
    env: "LOCAL",
    model: "openai/gpt-4o-mini", // change to your provider/model
  });

  await stagehand.init();

  try {
    const page = stagehand.context.pages()[0];

    // Navigate to the target URL
    await page.goto("${escapeTS(url)}");

    // --- Agent steps ---
${steps || "    // (no steps recorded)"}

    // --- Assertions ---
${assertionLines || "    // (no assertions)"}

    console.log("Test passed!");
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  } finally {
    await stagehand.close();
  }
}

test();
`;
}

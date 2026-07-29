import { test as baseTest, expect as baseExpect, type Page } from "@playwright/test";
import { Stagehand, type StagehandMetrics } from "@browserbasehq/stagehand";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RAW_COVERAGE_DIR = path.resolve(__dirname, "../.coverage-raw");
const STAGEHAND_CACHE_DIR = path.resolve(__dirname, "../.stagehand-cache");

async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

// ============================================================
// Variable Interpolation
// ============================================================

interface VariableMap {
  [key: string]: string | number;
}

function interpolateVariables(action: string, variables: VariableMap): string {
  return action.replace(/\{(\w+)\}/g, (match, key) => {
    if (key in variables) return String(variables[key]);
    if (key === "timestamp") return String(Date.now());
    if (key === "email") return `test+${Date.now()}@testradius.dev`;
    return match;
  });
}

// ============================================================
// Stagehand Test Fixture
// ============================================================

/**
 * Custom Playwright fixture that provides Stagehand integration for self-healing tests.
 *
 * - `stagehand`: the Stagehand instance (null if disabled or no API key)
 * - `stagehandPage`: Stagehand's internal Playwright Page (use for navigation + assertions)
 * - `stagehandAct()`: perform self-healing act() via LLM
 * - `stagehandFill()`: convenience wrapper for fill actions
 * - `stagehandExtract()`: extract structured data via LLM
 * - `coverage`: code coverage collection (unchanged from original)
 *
 * IMPORTANT: `stagehandPage` and `page` are DIFFERENT browser instances.
 * - `page` = Playwright's page (use for route mocking, native assertions)
 * - `stagehandPage` = Stagehand's page (use for self-healing interactions)
 * Tests that need mocking should use `page`; tests that need self-healing should use `stagehandPage`.
 */
interface StagehandFixtures {
  stagehand: Stagehand | null;
  stagehandPage: Page;
  stagehandAct: (instruction: string, variables?: VariableMap) => Promise<void>;
  stagehandFill: (instruction: string, value: string) => Promise<void>;
  stagehandExtract: <T>(instruction: string, schema: import("zod").ZodType<T>) => Promise<T>;
}

export const test = baseTest.extend<
  StagehandFixtures & { coverage: void }
>({
  stagehand: async ({}, use, testInfo) => {
    if (
      process.env.STAGEHAND_DISABLED === "true" ||
      !process.env.STAGEHAND_API_KEY
    ) {
      await use(null);
      return;
    }

    const cacheDir = path.join(
      STAGEHAND_CACHE_DIR,
      testInfo.file.replace(/.*\/tests\//, "").replace(/\.spec\.ts$/, ""),
    );
    await ensureDir(cacheDir);

    const stagehand = new Stagehand({
      env: "LOCAL",
      model: process.env.STAGEHAND_MODEL ?? "openai/gpt-4o-mini",
      cacheDir,
      domSettleTimeout: 5000,
    });

    await stagehand.init();

    try {
      await use(stagehand);
    } finally {
      try {
        const metrics: StagehandMetrics | undefined = await stagehand.metrics;
        if (metrics) {
          testInfo.annotations.push({
            type: "stagehand:metrics",
            description: JSON.stringify({
              promptTokens: metrics.totalPromptTokens,
              completionTokens: metrics.totalCompletionTokens,
              reasoningTokens: metrics.totalReasoningTokens,
              inferenceTimeMs: metrics.totalInferenceTimeMs,
            }),
          });
        }
      } catch {
        // metrics not available
      }
      await stagehand.close();
    }
  },

  stagehandPage: async ({ stagehand }, use) => {
    if (!stagehand) {
      // Return a dummy page — tests should check stagehand before using stagehandPage
      await use(null as unknown as Page);
      return;
    }
    const page = stagehand.context.pages()[0];
    await use(page as unknown as Page);
  },

  stagehandAct: async ({ stagehand }, use) => {
    const act = async (instruction: string, variables: VariableMap = {}) => {
      if (!stagehand) {
        throw new Error(
          "Stagehand not available — set STAGEHAND_API_KEY and ensure STAGEHAND_DISABLED is not 'true'",
        );
      }
      const resolved = interpolateVariables(instruction, variables);
      await stagehand.act(resolved);
    };
    await use(act);
  },

  stagehandFill: async ({ stagehand }, use) => {
    const fill = async (instruction: string, value: string) => {
      if (!stagehand) {
        throw new Error("Stagehand not available");
      }
      await stagehand.act(`Fill "${instruction}" with "${value}"`);
    };
    await use(fill);
  },

  stagehandExtract: async ({ stagehand }, use) => {
    const extract = async <T>(instruction: string, schema: import("zod").ZodType<T>): Promise<T> => {
      if (!stagehand) {
        throw new Error("Stagehand not available — cannot extract without LLM");
      }
      return stagehand.extract(instruction, schema);
    };
    await use(extract);
  },

  coverage: [
    async ({ page }, use, testInfo) => {
      let collect: (() => Promise<void>) | undefined;

      collect = async () => {
        try {
          const coverage = await page.evaluate(() =>
            JSON.stringify((window as any).__coverage__),
          );
          if (coverage) {
            await ensureDir(RAW_COVERAGE_DIR);
            const filePath = path.join(
              RAW_COVERAGE_DIR,
              `${testInfo.testId}-${crypto.randomUUID()}.json`,
            );
            await fs.promises.writeFile(filePath, coverage, "utf-8");
          }
        } catch {
          // __coverage__ not available (instrumentation not active)
        }
      };

      await use();

      if (collect) {
        await collect();
      }
    },
    { auto: true },
  ],
});

export const expect = baseExpect;

import { test as baseTest, expect as baseExpect } from "@playwright/test";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RAW_COVERAGE_DIR = path.resolve(__dirname, "../.coverage-raw");

async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

export const test = baseTest.extend<{ coverage: void }>({
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

import type { Reporter } from "@playwright/test/reporter";
import { CoverageReport, CoverageReportOptions } from "monocart-coverage-reports";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RAW_COVERAGE_DIR = path.resolve(__dirname, ".coverage-raw");
const COVERAGE_OUTPUT_DIR = path.resolve(__dirname, "coverage");

class CoverageReporter implements Reporter {
  async onEnd() {
    if (!fs.existsSync(RAW_COVERAGE_DIR)) {
      console.log("\nNo raw coverage data found.");
      return;
    }

    const files = fs.readdirSync(RAW_COVERAGE_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("urls-debug"));
    if (files.length === 0) {
      console.log("\nNo coverage JSON files found.");
      return;
    }

    console.log(`\nMerging ${files.length} coverage files...`);

    const options: CoverageReportOptions = {
      outputDir: COVERAGE_OUTPUT_DIR,
      reports: ["v8", "html", "lcovonly", "json-summary"],
      name: "TestRadius E2E Coverage",
      sourceFilter: (filePath: string) =>
        filePath.includes("/src/") || filePath.includes("artifacts/testradius/src"),
    };

    const mcr = new CoverageReport(options);

    for (const file of files) {
      const filePath = path.join(RAW_COVERAGE_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        await mcr.add(data);
      } catch (e) {
        console.warn(`Skipping invalid coverage file: ${file}`);
      }
    }

    await mcr.generate();
    fs.rmSync(RAW_COVERAGE_DIR, { recursive: true, force: true });

    const reportPath = path.join(COVERAGE_OUTPUT_DIR, "index.html");
    console.log(`\nCoverage report: ${reportPath}`);
  }
}

export default CoverageReporter;

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    watch: false,
    reporters: [
      "default",
      ["@workspace/report-gen/vitest-reporter", { outputDir: "test-reports" }],
    ],
  },
});

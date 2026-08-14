import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    watch: false,
    // Integration tests each spawn their own headless Chrome; running test files
    // in parallel causes cold-launch contention (and navigate timeouts) on
    // resource-limited machines. Serial execution keeps the suite deterministic.
    fileParallelism: false,
    // One browser is launched per integration test; give cold starts headroom.
    testTimeout: 90_000,
  },
});

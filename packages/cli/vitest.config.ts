import { defineConfig } from "vitest/config";

const defaultMaxWorkers = 1;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(1, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    maxWorkers,
    // build-exe and build-exe-cross suites both operate on packages/cli/dist/
    // and can race when run in parallel workers.
    fileParallelism: false,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
    },
  },
});

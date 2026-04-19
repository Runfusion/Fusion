import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const defaultMaxWorkers = 1;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(1, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    maxWorkers,
    fileParallelism: true,
    pool: "threads",
    // Enable isolate to allow parallel execution of tests with conflicting mocks
    isolate: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
    },
  },
});

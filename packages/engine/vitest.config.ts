import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

const defaultMaxWorkers = Math.max(1, Math.min(4, Math.ceil(availableParallelism() / 8)));
const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);

export default defineConfig({
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

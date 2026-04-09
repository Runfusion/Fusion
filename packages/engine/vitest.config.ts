import { defineConfig } from "vitest/config";

const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "16", 10);

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

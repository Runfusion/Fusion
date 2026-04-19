import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const defaultMaxWorkers = 2;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(2, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/test-utils": resolve(__dirname, "./src/__test-utils__/workspace.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "./src/__tests__/setup-test-isolation.ts",
      "./src/__test-utils__/vitest-setup.ts",
    ],
    globalSetup: ["./src/__test-utils__/vitest-teardown.ts"],
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    fileParallelism: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
    },
  },
});

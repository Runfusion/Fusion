import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const defaultMaxWorkers = 2;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(4, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

export default defineConfig({
  resolve: {
    // Use ordered aliases so the subpath match is resolved before @fusion/core.
    alias: [
      { find: "@fusion/core/gh-cli", replacement: resolve(__dirname, "../core/src/gh-cli.ts") },
      { find: "@fusion/core", replacement: resolve(__dirname, "../core/src/index.ts") },
      { find: "@fusion/dashboard/planning", replacement: resolve(__dirname, "../dashboard/src/planning.ts") },
      { find: "@fusion/dashboard", replacement: resolve(__dirname, "../dashboard/src/index.ts") },
      { find: "@fusion/engine", replacement: resolve(__dirname, "../engine/src/index.ts") },
      { find: "@fusion/test-utils", replacement: resolve(__dirname, "../core/src/__test-utils__/workspace.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "./src/__tests__/setup-test-isolation.ts",
      resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts"),
    ],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
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

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const defaultMaxWorkers = Math.max(1, cpus().length - 1);
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers);
process.env.VITEST_MAX_WORKERS = String(maxWorkers);
const coreSourceEntry = fileURLToPath(new URL("../core/src/index.ts", import.meta.url));
const testUtilsEntry = fileURLToPath(new URL("../core/src/__test-utils__/workspace.ts", import.meta.url));
const testSetupEntry = fileURLToPath(new URL("../core/src/__test-utils__/vitest-setup.ts", import.meta.url));
const testTeardownEntry = fileURLToPath(new URL("../core/src/__test-utils__/vitest-teardown.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": coreSourceEntry,
      "@fusion/test-utils": testUtilsEntry,
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: [testSetupEntry],
    globalSetup: [testTeardownEntry],
    passWithNoTests: true,
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    fileParallelism: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts", "dist/**"],
    },
  },
});

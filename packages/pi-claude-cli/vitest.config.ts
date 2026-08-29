import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  test: {
    globals: true,
    setupFiles: [
      "./src/__tests__/setup-test-isolation.ts",
      resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts"),
    ],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
    fileParallelism: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "index.ts"],
      exclude: ["src/mcp-schema-server.cjs"],
      thresholds: {
        lines: 92,
        functions: 92,
        branches: 88,
        statements: 92,
      },
    },
  },
});

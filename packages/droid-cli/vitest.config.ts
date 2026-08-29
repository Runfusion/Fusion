import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  resolve: {
    alias: {
      /*
      FNXC:PluginTests 2026-07-04-09:30:
      droid-cli's index.test.ts imports @fusion-plugin-examples/droid-runtime, but without a source alias Vite tries to resolve the package's dist/ exports which don't exist in a source checkout, causing every droid-cli test to fail with 'Failed to resolve entry for package'.
      */
      "@fusion-plugin-examples/droid-runtime/probe": resolve(__dirname, "../../plugins/fusion-plugin-droid-runtime/src/probe.ts"),
      "@fusion-plugin-examples/droid-runtime": resolve(__dirname, "../../plugins/fusion-plugin-droid-runtime/src/index.ts"),
    },
  },
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

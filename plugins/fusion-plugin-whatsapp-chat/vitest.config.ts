import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@fusion/plugin-sdk": fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    /*
    FNXC:PluginPgTestTimeout 2026-07-23-22:15:
    The shared PG test harness (packages/core/src/__test-utils__/pg-test-harness.ts) pays its
    golden-schema-template cold start inside the FIRST pg test of a vitest invocation, which is
    budgeted for the 15s testTimeout its home package (@fusion/core) configures. Plugin packages
    ran at vitest's 5s default, so persistence.pg.test.ts timed out on loaded CI runners
    (full-suite shard 4, 2026-07-24). Align every pg-harness-consuming plugin with core's budget.
    */
    testTimeout: 15_000,
  },
});

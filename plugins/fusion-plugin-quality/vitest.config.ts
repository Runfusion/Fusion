import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fusion-plugin-examples\/quality\/dashboard-view$/,
        replacement: fileURLToPath(new URL("./src/dashboard-view.tsx", import.meta.url)),
      },
      {
        find: /^@fusion-plugin-examples\/quality\/qa-tab$/,
        replacement: fileURLToPath(new URL("./src/qa-tab.tsx", import.meta.url)),
      },
      {
        find: /^@fusion-plugin-examples\/quality$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      {
        find: "@fusion/core",
        replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      },
      {
        find: "@fusion/plugin-sdk",
        replacement: fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Quarantine ledger: scripts/lib/test-quarantine.json — async-quality-store.pg.test.ts (2026-07-18).
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/async-quality-store.pg.test.ts"],
    environment: "node",
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
  },
});

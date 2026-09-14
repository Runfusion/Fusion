import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  resolve: {
    alias: {
      /*
      FNXC:VitestAliases 2026-09-13-22:40:
      The standardized cooperative header is imported through its dashboard subpath and transitively pulls the
      browser-safe core leaves. String aliases match by PREFIX, so every subpath precedes its package alias.
      */
      "@fusion/core/task-delete-attribution": fileURLToPath(new URL("../../packages/core/src/task-delete-attribution.ts", import.meta.url)),
      "@fusion/core/column-roles": fileURLToPath(new URL("../../packages/core/src/column-roles.ts", import.meta.url)),
      "@fusion/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@fusion/plugin-sdk": fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
      "@fusion/dashboard/app/plugins/PluginDashboardViewHeader": fileURLToPath(new URL("../../packages/dashboard/app/plugins/PluginDashboardViewHeader.tsx", import.meta.url)),
      "@fusion/dashboard/app/plugins/types": fileURLToPath(new URL("../../packages/dashboard/app/plugins/types.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    projects: [
      {
        extends: true,
        test: {
          name: "linear-import-dashboard",
          environment: "jsdom",
          include: ["src/**/__tests__/**/*.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "linear-import-node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.ts"],
        },
      },
    ],
  },
});

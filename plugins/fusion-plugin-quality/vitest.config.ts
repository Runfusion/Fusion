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
        find: "@fusion/dashboard/app/api/tasks/task-content",
        replacement: fileURLToPath(new URL("../../packages/dashboard/app/api/tasks/task-content.ts", import.meta.url)),
      },
      {
        find: "@fusion/dashboard/app/plugins/PluginDashboardViewHeader",
        replacement: fileURLToPath(new URL("../../packages/dashboard/app/plugins/PluginDashboardViewHeader.tsx", import.meta.url)),
      },
      /*
      FNXC:VitestAliases 2026-09-13-22:40:
      The cooperative plugin header pulls the dashboard API client, which imports this browser-safe core leaf.
      String aliases match by PREFIX, so the subpath entries must precede the `@fusion/core` package alias.
      */
      {
        find: "@fusion/core/task-delete-attribution",
        replacement: fileURLToPath(new URL("../../packages/core/src/task-delete-attribution.ts", import.meta.url)),
      },
      {
        find: "@fusion/core/column-roles",
        replacement: fileURLToPath(new URL("../../packages/core/src/column-roles.ts", import.meta.url)),
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
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
  },
});

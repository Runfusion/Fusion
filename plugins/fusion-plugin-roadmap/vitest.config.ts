import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

/*
FNXC:RoadmapTests 2026-06-25-16:30:
The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, PHASE A)
quarantines plugin test files that construct a SQLite-backed store (new TaskStore(...,
{inMemoryDb: true}) / new Database(...)). The SQLite runtime code is being deleted
in this feature. Per the AGENTS.md flaky-test deletion ratchet, these tests are
quarantined on sight. Mirrored in scripts/lib/test-quarantine.json.
*/
const quarantinedRoadmapTests = [
];

export default defineConfig({
  resolve: {
    alias: {
      /*
      FNXC:VitestAliases 2026-09-13-22:40:
      Roadmaps paints the standardized cooperative header through its dashboard subpath, which transitively pulls
      the browser-safe core leaves. String aliases match by PREFIX, so subpaths precede their package alias.
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
    /*
    FNXC:PluginPgTestTimeout 2026-07-23-22:15:
    The shared PG test harness (packages/core/src/__test-utils__/pg-test-harness.ts) pays its
    golden-schema-template cold start inside the FIRST pg test of a vitest invocation, which is
    budgeted for the 15s testTimeout its home package (@fusion/core) configures. Plugin packages
    ran at vitest's 5s default, so the whatsapp-chat persistence.pg.test.ts timed out on loaded
    CI runners (full-suite shard 4, 2026-07-24). Align every pg-harness-consuming plugin with
    core's budget.
    */
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "roadmap-dashboard",
          environment: "jsdom",
          include: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
          setupFiles: [
            fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url)),
            fileURLToPath(new URL("./src/dashboard/test-setup.ts", import.meta.url)),
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "roadmap-node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
          exclude: [
            "src/dashboard/**/__tests__/**/*.test.{ts,tsx}",
            "src/dashboard/**/*.test.{ts,tsx}",
            ...quarantinedRoadmapTests,
          ],
        },
      },
    ],
  },
});

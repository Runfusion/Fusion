import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

const coreSetup = fileURLToPath(
  new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url),
);
const dashboardSetup = fileURLToPath(
  new URL("./src/dashboard/test-setup.ts", import.meta.url),
);

/*
FNXC:ReportsTests 2026-06-25-16:30:
The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, PHASE A)
quarantines plugin test files that construct a SQLite-backed store (new TaskStore(...,
{inMemoryDb: true}) / new Database(...)). The SQLite runtime code is being deleted
in this feature. Per the AGENTS.md flaky-test deletion ratchet, these tests are
quarantined on sight. Mirrored in scripts/lib/test-quarantine.json.
*/
const quarantinedReportsTests = [
];

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      // FNXC:Clipboard 2026-07-12-00:00: The reports plugin imports the dashboard clipboard helper through its package subpath export; keep this exact alias ahead of the package root alias so vitest does not collapse the subpath to src/index.ts.
      "@fusion/dashboard/app/utils/copyToClipboard": fileURLToPath(new URL("../../packages/dashboard/app/utils/copyToClipboard.ts", import.meta.url)),
      "@fusion/dashboard": fileURLToPath(new URL("../../packages/dashboard/src/index.ts", import.meta.url)),
      "@fusion/plugin-sdk": fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // coreSetup runs for all projects via extends: true inheritance
    setupFiles: [coreSetup],
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
          name: "reports-dashboard",
          environment: "jsdom",
          include: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
          // coreSetup is inherited from root via extends: true.
          // Only add dashboardSetup which is jsdom-specific.
          setupFiles: [dashboardSetup],
        },
      },
      {
        extends: true,
        test: {
          name: "reports-node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
          exclude: [
            "src/dashboard/**/__tests__/**/*.test.{ts,tsx}",
            "src/dashboard/**/*.test.{ts,tsx}",
            ...quarantinedReportsTests,
          ],
        },
      },
    ],
  },
});

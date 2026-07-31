import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

/*
FNXC:CliPrintingPressTests 2026-06-25-16:30:
The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, PHASE A)
quarantines plugin test files that construct a SQLite-backed store (new TaskStore(...,
{inMemoryDb: true}) / new Database(...)) or use the sync SQLite data path. The SQLite
runtime code is being deleted in this feature. Per the AGENTS.md flaky-test deletion
ratchet, these tests are quarantined on sight (not migrated to PG) because they
exercise code that will be deleted. Mirrored in scripts/lib/test-quarantine.json.
*/
const quarantinedCliPrintingPressTests = [
  /*
  FNXC:CliPrintingPressTests 2026-06-25-18:00:
  The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, SESSION 3 PHASE A)
  quarantines plugin tests importing fixtures/registry.ts which constructs
  new Database({inMemory:true}). SQLite runtime being deleted. Mirrored in ledger.
  */
];

export default defineConfig({
  resolve: {
    alias: {
      /*
      FNXC:VitestAliases 2026-07-30-13:10:
      Must precede the broader `@fusion/core` alias: Vite string aliases match by PREFIX, so that key
      rewrites this subpath to `index.ts/task-delete-attribution` and resolution fails. Reached here
      transitively — this project aliases `@fusion/dashboard`, and `app/api/client.ts` imports the
      browser-safe delete-attribution leaf.
      */
      "@fusion/core/column-roles": fileURLToPath(new URL("../../packages/core/src/column-roles.ts", import.meta.url)),
      "@fusion/core/task-delete-attribution": fileURLToPath(new URL("../../packages/core/src/task-delete-attribution.ts", import.meta.url)),
      "@fusion/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@fusion/plugin-sdk": fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
      "@fusion/dashboard": fileURLToPath(new URL("../../packages/dashboard/app/index.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...quarantinedCliPrintingPressTests,
    ],
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
  },
});

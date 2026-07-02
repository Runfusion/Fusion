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
  },
});

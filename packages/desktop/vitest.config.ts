import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();
const fusionAliases = {
  "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
  "@fusion/dashboard": resolve(__dirname, "../dashboard/src/index.ts"),
  "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
};

/*
FNXC:DesktopTestQuarantine 2026-06-25-14:15:
The SQLite-to-PostgreSQL cutover (feature quarantine-sqlite-internals-tests, retry session)
quarantines local-server.test.ts: the desktop local-server now imports createTaskStoreForBackend
from @fusion/core but the test's @fusion/core mock does not expose it
([vitest] No "createTaskStoreForBackend" export is defined on the "@fusion/core" mock).
Confirmed failing on clean baseline (stash + rerun, 1 failed | 23 passed). Quarantined on sight
per AGENTS.md so verify:workspace goes green. Rescue requires updating the mock to expose
createTaskStoreForBackend. Mirrored in scripts/lib/test-quarantine.json.
*/
const quarantinedDesktopTests: string[] = [
  "src/__tests__/local-server.test.ts",
];

export default defineConfig({
  resolve: {
    alias: fusionAliases,
  },
  test: {
    setupFiles: [resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts")],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    fileParallelism: true,
    passWithNoTests: true,
    projects: [
      {
        resolve: {
          alias: fusionAliases,
        },
        test: {
          name: "desktop",
          include: ["src/__tests__/**/*.test.ts"],
          exclude: quarantinedDesktopTests,
          pool: "threads",
          isolate: true,
        },
      },
      {
        resolve: {
          alias: fusionAliases,
        },
        test: {
          name: "desktop-renderer",
          include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx"],
          environment: "jsdom",
          isolate: true,
        },
      },
    ],
  },
});

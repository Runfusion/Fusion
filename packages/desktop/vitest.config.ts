import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();
const fusionAliases = {
  /*
  FNXC:VitestAliases 2026-07-30-13:10:
  Must precede the broader `@fusion/core` alias: Vite string aliases match by PREFIX, so that key
  rewrites this subpath to `index.ts/task-delete-attribution` and resolution fails. Reached here
  transitively — this project aliases `@fusion/dashboard`, and `app/api/client.ts` imports the
  browser-safe delete-attribution leaf.
  */
  "@fusion/core/column-roles": resolve(__dirname, "../core/src/column-roles.ts"),
  "@fusion/core/task-delete-attribution": resolve(__dirname, "../core/src/task-delete-attribution.ts"),
  "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
  "@fusion/dashboard": resolve(__dirname, "../dashboard/src/index.ts"),
  "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
};

/* FNXC:DesktopTestQuarantine 2026-07-14-19:10: Restore local-server.test.ts after fixing its startup-factory mock. The suite exercises real desktop startup, rollback, provider, plugin, and PostgreSQL ownership regressions, and no quarantine ledger entry remains. */
const quarantinedDesktopTests: string[] = [];

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

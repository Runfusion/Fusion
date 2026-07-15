import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

/*
FNXC:CompoundEngineeringTests 2026-06-17-17:02:
Direct CE plugin test commands must behave like the central pnpm test runner even when the caller's shell exports NODE_ENV=production. Force test mode before Vitest resolves React Testing Library so jsdom tests use React's act-capable test path.
*/
process.env.NODE_ENV = "test";

const coreSetup = fileURLToPath(
  new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url),
);
const dashboardSetup = fileURLToPath(new URL("./src/dashboard/test-setup.ts", import.meta.url));

/*
FNXC:CompoundEngineeringTests 2026-06-17-12:35:
FN-6587 quarantines the CE broad-pnpm-test timeout flakes without timeout appeasement. Keep these excludes mirrored in scripts/lib/test-quarantine.json and remove or delete the files when the 14-day ratchet resolves.

FNXC:CompoundEngineeringTests 2026-06-17-16:20:
FN-6593 deletes orchestrator-flow.test.ts and skill-wiring.test.ts under the ratchet because the broad-workflow-only 5000ms timeout could not be tied to a narrow non-appeasement root cause.
Keep the ledger entries and excludes removed together; git history remains the archive for this dropped CE orchestrator/skill-wiring coverage.

FNXC:CompoundEngineeringTests 2026-06-17-19:56:
FN-6606 re-ran the loaded CE node/package lane with sync.test.ts and work-bridge.test.ts temporarily unexcluded and could not reproduce either the 5000ms test timeout or the later 10000ms hook timeout.
The current HEAD's shared test-isolation fixes now keep the broad lane stable, so restore both files to active coverage and clear the stale quarantine in lockstep with scripts/lib/test-quarantine.json.

FNXC:CompoundEngineeringTests 2026-07-13-22:37:
The PostgreSQL session-store port uses getAsyncLayer with a safe SQLite fallback, so the six session/orchestrator files previously excluded for stale TaskStore mocks are active coverage again. The quarantine ledger contains no matching entries; configuration and coverage must remain aligned.
*/
const nodeOnlyDashboardTests = [
  "src/dashboard/__tests__/theme-tokens.test.ts",
];

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fusion-plugin-examples\/compound-engineering\/dashboard-view$/,
        replacement: fileURLToPath(new URL("./src/dashboard-view.tsx", import.meta.url)),
      },
      {
        find: /^@fusion-plugin-examples\/compound-engineering$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      { find: "@fusion/core", replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)) },
      {
        find: "@fusion/test-utils/pg-test-harness",
        replacement: fileURLToPath(new URL("../../packages/core/src/__test-utils__/pg-test-harness.ts", import.meta.url)),
      },
      {
        find: "@fusion/plugin-sdk",
        replacement: fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
      },
      { find: "@fusion/dashboard", replacement: fileURLToPath(new URL("../../packages/dashboard", import.meta.url)) },
      {
        find: "lucide-react",
        replacement: fileURLToPath(new URL("../../packages/dashboard/node_modules/lucide-react", import.meta.url)),
      },
    ],
  },
  test: {
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    projects: [
      {
        extends: true,
        test: {
          name: "compound-engineering-dashboard",
          environment: "jsdom",
          include: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
          exclude: nodeOnlyDashboardTests,
          globalSetup: [],
          /*
          FNXC:CompoundEngineeringTests 2026-06-17-16:50:
          Dashboard tests run in jsdom and must not inherit the core Node-only isolation setup. That setup imports node:module/node:worker_threads and makes Vite externalize built-ins during browser-style setup, which regressed the CE test lane into slow startup followed by ERR_UNKNOWN_BUILTIN_MODULE.

          FNXC:CompoundEngineeringTests 2026-06-17-16:54:
          File-inspection dashboard tests that read CSS from disk are Node tests even though they live beside React tests. Keep them out of the jsdom project so fs/path/url imports are not browser-externalized.

          FNXC:CompoundEngineeringTests 2026-06-17-17:10:
          Projects that do not run the core isolation setup must not inherit its global teardown. Otherwise a completed dashboard project can remove FUSION_TEST_WORKER_ROOT while the CE Node project is still redirecting tmpdir writes there.
          */
          setupFiles: [dashboardSetup],
        },
      },
      {
        extends: true,
        test: {
          name: "compound-engineering-node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
          setupFiles: [coreSetup],
          exclude: [
            "src/dashboard/**/__tests__/**/*.test.{ts,tsx}",
            "src/dashboard/**/*.test.{ts,tsx}",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "compound-engineering-dashboard-node",
          environment: "node",
          include: nodeOnlyDashboardTests,
          globalSetup: [],
          setupFiles: [],
        },
      },
    ],
  },
});

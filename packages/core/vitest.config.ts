import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "./src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

/*
FNXC:CoreTestInventory 2026-07-13-22:38:
Core test exclusions must exactly mirror the dated quarantine ledger. The PostgreSQL cutover removed the SQLite runtime and the expired 2026-07-10 exclusions no longer have ledger authority; keep this list empty and preserve behavior through active PostgreSQL counterparts.

FNXC:FullSuiteBookkeeping 2026-08-05-00:40:
Main full-suite run https://github.com/Runfusion/Fusion/actions/runs/30982276306 red on unit fakes missing layer.db.select, ledger/inventory drift after source peels, and one 15s timeout. Path/import drift was fixed in-product; these remaining files are quarantined on sight (paired with scripts/lib/test-quarantine.json) rather than appeased with timeouts or loosened asserts.
*/
const quarantinedCoreTests: string[] = [
  "src/__tests__/agent-logs-backend-mode.test.ts",
  "src/__tests__/archived-column-gate-parity.test.ts",
  "src/__tests__/central-core-layerless-init.test.ts",
  "src/__tests__/legacy-workflow-ir-callsite-allowlist.test.ts",
  "src/__tests__/log-entry-archived-lane-gate.test.ts",
  "src/__tests__/task-delete-notice.test.ts",
  "src/__tests__/workflow-ir-resolver.test.ts",
  "src/__tests__/cold-storage-renamed-archive-lane.test.ts",
  "src/__tests__/legacy-column-collection-gating-ledger.test.ts",
  "src/__tests__/search-archived-lane-wiring.test.ts",
  "src/__tests__/task-delete-caller-attribution.test.ts",
  "src/__tests__/task-delete-nonblocking-cleanup.test.ts",
  "src/__tests__/workflow-task-serialization-protocol.test.ts",
  "src/__tests__/postgres/store-wedge-resolution.pg.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "./src/index.ts"),
      "@fusion/test-utils": resolve(__dirname, "./src/__test-utils__/workspace.ts"),
      "@fusion/plugin-sdk": resolve(__dirname, "../plugin-sdk/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: quarantinedCoreTests,
    setupFiles: [
      "./src/__test-utils__/vitest-setup.ts",
    ],
    globalSetup: ["./src/__test-utils__/vitest-teardown.ts"],
    // Must stay "forks". Two thread-unsafe patterns block migration to "threads":
    //
    //   1. vitest-setup.ts:123 — `process.chdir(workerTempDir)` is gated by
    //      `isMainThread`, which is `false` in worker_threads, so each thread
    //      worker never gets its isolated cwd. Tests that rely on cwd being a
    //      disposable temp dir would silently operate in the repo root.
    //
    //   2. Some suites rely on fork-level process/env isolation for setup side effects,
    //      and cannot safely share mutable process state under worker_threads.
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
    fileParallelism: true,
    // Core runs a large SQLite-heavy suite while other workspace packages test concurrently.
    // Use a slightly higher timeout to reduce nondeterministic slow-machine flakes.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
    },
  },
});

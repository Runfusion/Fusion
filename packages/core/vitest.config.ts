import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "./src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

const quarantinedCoreTests = [
  /*
  FNXC:CoreTests 2026-06-13-17:43:
  The full workspace suite must not fail on suite-load-sensitive tests that pass standalone or only fail after excessive wall time. Quarantine observed core offenders after package-lane hook timeouts instead of appeasing them with wider hook timeouts.

  FNXC:CoreTests 2026-06-14-02:14:
  FN-6433 re-ran the core quarantine batch after FN-6430's shared fixture cleanup and rescued all five files without timeout or assertion changes. Keep this array empty unless a future quarantine is mirrored in scripts/lib/test-quarantine.json in the same commit.

  FNXC:CoreTests 2026-06-15-03:13:
  FN-6481 observed the disk-backed concurrent write test fail in the changed-package workspace lane with a transient SQLite BEGIN IMMEDIATE lock after the gate had already passed. Quarantine the flaky file instead of widening lock-recovery timeouts or weakening assertions.

  FNXC:CoreTests 2026-06-15-07:39:
  FN-6486 rescued store-concurrent-writes by making the transient lock helper release independent of event-loop timer scheduling, then removed the quarantine in lockstep with scripts/lib/test-quarantine.json. Keep this array empty unless a future observed flake is mirrored in the ledger in the same commit.

  FNXC:CoreTests 2026-06-17-17:21:
  FN-6596 verification observed task-list-format and test-project timing out only in the broad changed-package core lane after the merge gate had passed; both files passed immediate isolated reruns. Quarantine the suite-load flakes without widening timeouts or weakening assertions.

  FNXC:CoreTests 2026-06-17-17:55:
  FN-6592 rescued mission-integration by closing every reopened TaskStore handle and strengthening restart-fidelity assertions across mission hierarchy read paths. Keep the quarantine absent in both this exclude list and scripts/lib/test-quarantine.json unless a future observed flake is mirrored in both files.

  FNXC:CoreTests 2026-06-17-19:03:
  FN-6600 re-ran the core quarantine candidates under the broad-run worker budget and rescued the current core ledger entries without timeout, retry, assertion, or worker-budget appeasement.
  Keep core quarantines mirrored here only when a loaded run still fails after shared teardown cleanup has been ruled out.

  FNXC:CoreTests 2026-06-19-10:00:
  FN-6705 verification observed these five files fail only in the broad changed-package core lane with hook/test timeouts, ENOTEMPTY cleanup, or a missed deferred hook after the same files passed an immediate targeted rerun. Quarantine the suite-load flakes instead of widening timeouts, adding retries, or weakening assertions.

  FNXC:CoreTests 2026-06-19-10:24:
  FN-6705 verification then observed settings-export time out in beforeEach only under the broad changed-package core lane while the targeted file rerun passed in 5.1s. Quarantine the suite-load hook flake instead of increasing hookTimeout.

  FNXC:CoreTests 2026-06-19-14:31:
  FN-6741 reloaded the six 2026-06-19 core quarantine files under the broad @fusion/core lane and rescued them in lockstep with scripts/lib/test-quarantine.json. Keep this array empty; future core suite-load flakes must prove a remaining shared worker-root/temp-redirect or fixture close-order gap before re-quarantining.

  FNXC:CoreTests 2026-06-19-15:05:
  Merge verification for FN-6741 observed store-concurrent-writes fail again under the broad @fusion/core lane with SQLite BEGIN IMMEDIATE lock exhaustion. Re-quarantine that single suite-load lock flake in lockstep with the ledger; keep the other rescued core files loaded.
  */
  "src/__tests__/store-concurrent-writes.test.ts",
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

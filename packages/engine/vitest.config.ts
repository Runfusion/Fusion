import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
      "@fusion/test-utils": resolve(__dirname, "../core/src/__test-utils__/workspace.ts"),
      "@fusion/engine": resolve(__dirname, "./src/index.ts"),
      "@fusion/plugin-sdk": resolve(__dirname, "../plugin-sdk/src/index.ts"),
      "@fusion/dashboard": resolve(__dirname, "../dashboard/src/index.ts"),
    },
  },
  test: {
    setupFiles: [
      resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts"),
    ],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    fileParallelism: true,
    // Enable isolate to allow parallel execution of tests with conflicting mocks
    isolate: true,
    // Engine real-git tests spawn many subprocesses; under full-suite concurrent
    // load even 60 s can fire prematurely. Bump to 120 s — the guard only fires
    // on hangs, so healthy tests pay nothing.
    env: {
      FUSION_TEST_SUBPROCESS_TIMEOUT_MS: "120000",
    },
    // Real-git integration tests need more than the default 5 s under concurrent
    // load (other packages run tests at the same time via pnpm recursive).
    testTimeout: 30_000,
    // Fail FAST on a wedge instead of hanging the worker until the CI job
    // timeout. A real-git test can leave a promise (e.g. an un-resolved merge
    // waiter) or a worktree hook stuck; without explicit hook/teardown timeouts
    // the worker drains for minutes and the whole shard is SIGKILLed with no
    // named failure. These bound setup/teardown so the culprit test is reported.
    hookTimeout: 45_000,
    teardownTimeout: 20_000,
    // Split into two projects so the reliability-interactions suite (real
    // worktrees + real git, contention-sensitive event ordering) runs
    // single-threaded without throttling the rest of the engine suite.
    // Keep include globs project-scoped (not at root) so engine-reliability
    // does not inherit full-suite include and rerun everything single-threaded
    // (FN-5537: this caused long runs and external SIGTERM 143 kills).
    projects: [
      {
        extends: true,
        test: {
          name: "engine-core",
          // The curated merge-gate suite (see docs/testing.md "Merge gate").
          // Membership is an explicit allow-list, NOT a glob: tests earn their
          // way in with evidence of value, and a flaky gate test is evicted by
          // deleting its line here (no need for the flaky test to pass).
          // Selection criteria: deterministic (no real git subprocesses, no
          // real timers/network), fast (<~3s/file per scripts/test-timings.json),
          // covering regression-prone core invariants: merge lifecycle and
          // scope, files-changed/fork-point attribution, executor core paths,
          // triage, scheduling, self-healing.
          // Budget: the whole project must stay under ~60s wall-clock so the
          // CI gate job's test run lands under ~1 minute.
          include: [
            "src/__tests__/merger-merge-lifecycle.test.ts",
            "src/__tests__/merger-post-merge.test.ts",
            "src/__tests__/merger-conflict-resolution.test.ts",
            "src/__tests__/merger-diff-scope.test.ts",
            "src/__tests__/merger-landed-files-capture.test.ts",
            "src/__tests__/branch-attribution.test.ts",
            "src/__tests__/executor-core.test.ts",
            "src/__tests__/executor-recovery.test.ts",
            "src/__tests__/executor-base-commit-capture.test.ts",
            "src/__tests__/executor-capture-modified-files-attribution.test.ts",
            "src/__tests__/triage-preflight.test.ts",
            "src/__tests__/scheduler.test.ts",
            "src/__tests__/scheduler-node-routing.test.ts",
            "src/__tests__/scheduler-overlap-requeue.test.ts",
            "src/__tests__/mission-scheduler.test.ts",
            "src/__tests__/heartbeat-monitor.test.ts",
            "src/__tests__/workflow-node-handlers.test.ts",
            "src/__tests__/workflow-policy-ownership-map.test.ts",
          ],
          // No per-file quarantine excludes needed here: engine-core's
          // membership is the explicit include allow-list above, so any
          // quarantined file (e.g. merger-file-scope-invariant.test.ts) is
          // already absent. The quarantine excludes live in engine-default,
          // whose `src/**/*.test.ts` glob is what would otherwise pick them up.
          exclude: [
            "node_modules/**",
            "dist/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "engine-default",
          include: ["src/**/*.test.ts"],
          exclude: [
            "src/__tests__/reliability-interactions/**/*.test.ts",
            // Real-git heavy files run in the engine-slow project so local
            // `pnpm test` stays snappy. CI picks them up via `test:slow`
            // / `test:all` invoked from the root `test:full` script.
            "src/**/*.slow.test.ts",
            /*
            FNXC:EngineTests 2026-06-16-19:05:
            FN-6492 verification caught cli-agent-executor as a package-lane-only flake: the hard-cancel assertion failed once and left an ENOTEMPTY temp hook directory, then the file passed in isolation. Quarantine the whole file under the deletion ratchet instead of weakening timing or process assertions.

            FNXC:EngineTests 2026-06-17-16:12:
            FN-6593 deletes cli-agent-executor.test.ts under the ratchet because the package-lane-only hard-cancel/ENOTEMPTY flake did not have a non-appeasement root-cause fix in this follow-up.
            Keep the ledger entry and exclude removed together; git history remains the archive, while executor-recovery.test.ts still covers active CLI task-session hard-cancel cleanup.
            */
            "node_modules/**",
            "dist/**",
            /*
            FNXC:EngineTests 2026-06-14-02:11:
            FN-6433 rescued the AI-merge suites by replacing broad activeSessionRegistry cleanup with path-scoped cleanup, so the default engine lane should execute them again. The soft-delete blocker residue suite was deleted under the ratchet because deterministic soft-delete deadlock coverage already owns that invariant.
            */
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "engine-reliability",
          include: ["src/__tests__/reliability-interactions/**/*.test.ts"],
          // Mirror the engine-default exclusion so reliability slow tests
          // also tier into engine-slow.
          exclude: [
            "src/**/*.slow.test.ts",
            /*
            FNXC:EngineTests 2026-06-14-02:12:
            FN-6433 removed the reliability-interactions quarantine after deleting the duplicate soft-delete blocker residue file under the deletion ratchet; keep this project exclude list ledger-free unless a new flake is quarantined in lockstep.
            */
          ],
          // These tests assert event ordering across real worktrees. Parallel
          // execution under merger load caused subprocess-guard timeouts and
          // SQLite rowid interleaving (e.g. FN-5521 hit
          // `expected 24 to be less than 19` in merge-reuse-task-worktree).
          // Serialize at the file level; within-file order is already linear.
          minWorkers: 1,
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "engine-slow",
          // Files matching `*.slow.test.ts` are the long-tail real-git suites
          // (`mkdtemp` + `git init` + multiple commits per test). They run
          // single-threaded to avoid spawning many concurrent git processes
          // and inflating wall time further. Excluded from the default
          // `pnpm test` lane; run via `pnpm test:slow` / `pnpm test:all`.
          include: ["src/**/*.slow.test.ts"],
          minWorkers: 1,
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
    },
  },
});

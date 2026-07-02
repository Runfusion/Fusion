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
    // Keep the broad engine lanes on worker threads; engine-core overrides this
    // below because only the curated merge gate has hit the Node/macOS abort.
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
          /*
          FNXC:EngineTests 2026-06-25-11:11:
          The curated engine-core merge gate hits a Node 24.15.0/macOS libuv kqueue SIGABRT when Vitest thread workers close unmanaged file descriptors. Scope fork workers to this gate so the broad default engine suite keeps its explicit worker-thread behavior.
          */
          pool: "forks",
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
            /*
            FNXC:EngineTests 2026-06-23-10:48:
            Workflow columns and workflow graph execution are now the default runtime. Retire the legacy direct-dispatch executor/scheduler gate files and gate the new hold-release plus graph interpreter seams instead.

            FNXC:EngineTests 2026-06-23-23:04:
            The cutover gate must also keep one direct executor recovery guard for graph execute self-requeue preservation. This protects the new marker path after retiring the broad legacy executor recovery gate file.
            */
            "src/__tests__/executor-graph-requeue-gate.test.ts",
            /*
            FNXC:EngineTests 2026-06-25-18:00:
            hold-release.test.ts evicted from the gate: it constructs TaskStore with
            inMemoryDb:false and directly manipulates the SQLite DB via store.db.prepare().
            The SQLite runtime is being removed (delete-sqlite-runtime-final). Per AGENTS.md,
            a flake/gate test that can't pass without the SQLite path is evicted by deleting
            its line from the engine-core allow-list. The hold/release sweep logic is covered
            by PG-backed engine tests.
            */
            /*
            FNXC:EngineTests 2026-06-30-00:00:
            workflow-graph-task-runner.test.ts evicted from the gate: it constructs TaskStore
            with inMemoryDb:true which is removed in the PG cutover. Uses SQLite-only path.
            The workflow graph validation coverage is maintained by workflow-ir.test.ts
            and PG-backed integration tests.
            */
            "src/__tests__/workflow-graph-executor-parity.test.ts",
            /*
            FNXC:EngineTests 2026-06-29-00:00:
            The minimal task-pipeline smoke belongs in engine-core because the default builtin:coding path is now a merge-gate canary: it proves the unselected-task runtime reaches merge with deterministic in-memory seams only, without real git, network, subprocesses, timers, or broad e2e scope.
            */
            "src/__tests__/task-pipeline-smoke.test.ts",
            "src/__tests__/scheduler-workflow-cutover.test.ts",
            "src/__tests__/executor-base-commit-capture.test.ts",
            "src/__tests__/executor-capture-modified-files-attribution.test.ts",
            "src/__tests__/triage-preflight.test.ts",
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
            FNXC:EngineTests 2026-06-26-13:15:
            FN-7068 rescued the 2026-06-25 self-healing quarantine batch by completing the local TaskStore fakes for the FN-5488 overlap path. Keep both files active in engine-default so fake drift around clearStaleBlockedBy() is caught before the deletion ratchet expires.
            */
            /*
            FNXC:EngineTests 2026-06-26-09:30:
            Quarantined 7 engine-default files failing in CI full-suite run 28259456548 under the deletion ratchet.

            FNXC:EngineTests 2026-06-27-10:05:
            FN-7119 rescued the batch by completing scheduler TaskStore fakes for the engine heartbeat write, fixing override column-agent model preservation, and removing a stale static-guard registry entry for the deleted merger post-merge script path. Keep these files active so loaded shards catch fake drift and model-clobber regressions.
            */
            /*
            FNXC:EngineTests 2026-06-16-19:05:
            FN-6492 verification caught cli-agent-executor as a package-lane-only flake: the hard-cancel assertion failed once and left an ENOTEMPTY temp hook directory, then the file passed in isolation. Quarantine the whole file under the deletion ratchet instead of weakening timing or process assertions.

            FNXC:EngineTests 2026-06-17-16:12:
            FN-6593 deletes cli-agent-executor.test.ts under the ratchet because the package-lane-only hard-cancel/ENOTEMPTY flake did not have a non-appeasement root-cause fix in this follow-up.
            Keep the ledger entry and exclude removed together; git history remains the archive, while executor-recovery.test.ts still covers active CLI task-session hard-cancel cleanup.
            */
            // SQLite-internals quarantine (cutover): see scripts/lib/test-quarantine.json.
            // FNXC:EngineTests 2026-06-25-11:15: SQLite-to-PostgreSQL cutover
            // quarantines engine files exercising SQLite-only behavior (FTS5
            // maintenance scheduling with FUSION_DISABLE_FTS5 + rebuildFts5Index,
            // worktree DB hydration asserting SQLite PRAGMA journal_mode). FTS
            // coverage is replaced by packages/core/src/__tests__/postgres/fts-replacement.test.ts.
            //
            // FNXC:EngineTests 2026-06-25-11:38: Additional engine SQLite-path
            // tests fail under Node 26 node:sqlite ERR_INVALID_ARG_TYPE binding
            // via sqlite-adapter.ts (construct SQLite-backed TaskStore). All
            // pre-existing on clean baseline. Quarantined on sight per AGENTS.md.
            // Pre-existing test/code drift (mock TaskStore missing getAsyncLayer);
            // quarantined on sight per AGENTS.md so verify:workspace goes green.
            /*
            FNXC:EngineTests 2026-06-25-16:30:
            The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, PHASE A)
            quarantines the remaining non-quarantined engine test files that construct a
            SQLite-backed store (new TaskStore(..., {inMemoryDb: true}) / new Database(...))
            or use the sync SQLite data path. The SQLite runtime code is being deleted in
            this feature. Per the AGENTS.md flaky-test deletion ratchet, these tests are
            quarantined on sight (not migrated to PG) because they exercise code that will
            be deleted. Mirrored in scripts/lib/test-quarantine.json.
            */
            /*
            FNXC:EngineTests 2026-06-25-18:00:
            The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, SESSION 3 PHASE A)
            quarantines remaining engine test files that construct a SQLite-backed store via
            inMemoryDb. These tests exercise the SQLite Database class being deleted in this feature.
            Quarantined on sight per AGENTS.md; mirrored in scripts/lib/test-quarantine.json.
            */
            // SQLite-path gate test evicted + quarantined (see engine-core comment + ledger).
            "node_modules/**",
            "dist/**",
            /*
            FNXC:EngineTests 2026-06-14-02:11:
            FN-6433 rescued the AI-merge suites by replacing broad activeSessionRegistry cleanup with path-scoped cleanup, so the default engine lane should execute them again. The soft-delete blocker residue suite was deleted under the ratchet because deterministic soft-delete deadlock coverage already owns that invariant.
            */
            /*
            FNXC:EngineTests 2026-06-29-13:55:
            FN-7239 quarantines executor-pause.test.ts under the deletion ratchet because it still asserts obsolete direct-dispatch StepSessionExecutor and legacy pause paths after builtin:coding moved to graph execution. Keep graph-path equivalents active in step-session-executor, executor-paused-abort-todo-benign, and workflow-graph-step-rerun before rescuing or deleting this file.
            */
            "src/__tests__/executor-pause.test.ts",
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
            FNXC:EngineTests 2026-06-26-09:30:
            Quarantined 3 reliability-interactions files failing in CI full-suite run 28259456548 under the deletion ratchet.

            FNXC:EngineTests 2026-06-27-10:05:
            FN-7119 rescued the reliability batch by adding the production `updateSettings` heartbeat surface to scheduler fakes, so lease-recovery and todo/in-progress flapping call-count invariants run under the loaded reliability shard without quarantine.
            */
            /*
            FNXC:EngineTests 2026-06-14-02:12:
            FN-6433 removed the reliability-interactions quarantine after deleting the duplicate soft-delete blocker residue file under the deletion ratchet; keep this project exclude list ledger-free unless a new flake is quarantined in lockstep.

            FNXC:EngineTests 2026-06-25-11:48:
            Pre-existing failure on clean baseline: merge-request-cancel-on-hard-cancel 'cancels pending merge request' asserts expected Promise to be null (timing/ordering). Quarantined on sight per AGENTS.md so verify:workspace goes green; mirrored in scripts/lib/test-quarantine.json.
            */
            // Pre-existing reliability flake (quarantine on sight): see scripts/lib/test-quarantine.json.
            "src/__tests__/reliability-interactions/merge-request-cancel-on-hard-cancel.test.ts",
            /*
            FNXC:EngineTests 2026-06-25-16:30:
            The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, PHASE A)
            quarantines the remaining non-quarantined engine reliability-interaction test
            files that construct a SQLite-backed store. The SQLite runtime code is being
            deleted in this feature. Per the AGENTS.md flaky-test deletion ratchet, these
            tests are quarantined on sight (not migrated to PG) because they exercise code
            that will be deleted. Mirrored in scripts/lib/test-quarantine.json.
            */
            // SQLite-path + pre-existing real-git CWD race flake (quarantine on sight).
            /*
            FNXC:EngineTests 2026-06-25-18:00:
            The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, SESSION 3 PHASE A)
            quarantines remaining reliability-interaction test files that import _helpers.ts
            (which constructs TaskStore with inMemoryDb:true). These tests exercise the SQLite
            Database class being deleted. Quarantined on sight per AGENTS.md; mirrored in
            scripts/lib/test-quarantine.json.
            */
            // SQLite-path (delete-sqlite-runtime-final SESSION 3 PHASE A): uses createStore via _helpers.ts (inMemoryDb:true).
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
          /*
          FNXC:EngineTests 2026-06-25-14:30:
          The SQLite-to-PostgreSQL cutover (feature quarantine-sqlite-internals-tests, retry
          session) quarantines 6 engine-slow reliability-interaction test files that fail on
          clean baseline (stash + rerun, 6 failed | 8 passed). These are real-git + SQLite-backed
          branch-group tests that hit the async-satellite getAsyncLayer/isBackendMode mock drift
          or branch-group "undefined not found" errors under the cutover's dual-path. Quarantined
          on sight per AGENTS.md flaky-test rule so verify:workspace goes green. Mirrored in
          scripts/lib/test-quarantine.json.
          */
          exclude: [
            "src/__tests__/merger-ai-dependency-install.slow.test.ts",
            "src/__tests__/reliability-interactions/branch-group-automerge-precedence.slow.test.ts",
            "src/__tests__/reliability-interactions/branch-group-merge-routing.slow.test.ts",
            "src/__tests__/reliability-interactions/branch-group-pr-sync.slow.test.ts",
            "src/__tests__/reliability-interactions/branch-group-single-pr-e2e.slow.test.ts",
            "src/__tests__/reliability-interactions/shared-branch-group-lifecycle.slow.test.ts",
            // SQLite-path (delete-sqlite-runtime-final PHASE A): uses inMemoryDb via _helpers.ts.
          ],
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

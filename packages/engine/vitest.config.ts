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
        resolve: {
          /*
          FNXC:EngineTests 2026-07-08-03:00:
          FN-7667: scope the gate-safe @fusion/core barrel (packages/core/src/index.gate.ts)
          to THIS project only. It must not leak to the root resolve.alias — that would
          silently narrow the module graph for engine-default/engine-reliability/engine-slow
          too. Project-level resolve.alias merges over (does not replace) the root map
          inherited via extends:true, so @fusion/test-utils/@fusion/plugin-sdk/@fusion/dashboard
          stay on their root aliases and only @fusion/core is overridden here.

          FNXC:EngineTests 2026-07-08-04:50:
          FN-7669: the @fusion/core alias now points at a PRE-BUNDLED single ESM
          file (packages/core/.gate-bundle/core.mjs — a SIBLING of
          packages/core/node_modules/, deliberately NOT nested inside it; nesting
          inside node_modules triggers Vite's SSR external-dep heuristic and
          silently defeats vi.mock interception for imports nested inside the
          bundle, see scripts/build-engine-core-gate-bundle.mjs for the full repro)
          instead of directly at index.gate.ts's source. FN-7668 profiled the
          gate's dominant wall-time cost as vitest/Vite SSR's import-phase — each
          of the 18 pool:"forks" processes independently re-resolving+evaluating
          the ~430-file barrel closure with zero cross-fork sharing. esbuild-
          bundling the index.gate.ts closure (220 first-party files, the
          @fusion/core slice of that ~430) into one file
          (scripts/build-engine-core-gate-bundle.mjs, wired below via globalSetup
          so it is rebuilt fresh before every gate invocation — never a hand-
          maintained/stale artifact) collapses that to a single file load per
          fork. See the task's docs document for the full A/B measurement,
          coverage-parity proof, and land/no-land rationale.
          @fusion/engine is deliberately left on the full barrel, unbundled: none
          of the 18 curated gate files import "@fusion/engine" at all (verified by
          grep across all 18 files), so bundling it would be zero-benefit
          churn/risk — and it would additionally risk double-registering or
          dead-locking the core↔engine circular-import DI
          (`void import("@fusion/core").then(setCreateFnAgent...)` in
          packages/engine/src/index.ts) for no measured gain.

          FNXC:EngineTests 2026-07-08-06:20:
          FN-7670 prototyped extending this same lever to the @fusion/engine
          RELATIVE-import production graph (`../merger.js`, `../hold-release.js`,
          `../scheduler.js`, `../workflow-node-handlers.js`, ...) that the 18 gate
          files reach directly — NOT the barrel above, which stays untouched per
          the paragraph above regardless. It built a fully working, coverage-
          parity-preserving, mock-safe bundle (171 first-party files → 35 output
          files via esbuild multi-entry splitting) but an interleaved, host-load-
          controlled A/B showed NO clear incremental wall-time win over this
          @fusion/core-only bundle (delta within this host's own ~2.5x run-to-run
          noise band) — the byte-size growth of 14 separate large root bundles
          (e.g. one alone reached 1.3MB) offset the per-file-dispatch savings that
          made the single-file @fusion/core bundle above pay off. NOT landed; the
          wiring was reverted to this @fusion/core-only state. See FN-7670's task
          docs document for the full closure/mock-boundary analysis, the A/B
          methodology and data, and the negative-result rationale, before
          re-attempting this lever with a different bundle shape (e.g. a single
          combined engine-graph entry rather than 14 separate root entries).
          */
          alias: {
            "@fusion/core": resolve(__dirname, "../core/.gate-bundle/core.mjs"),
          },
        },
        test: {
          name: "engine-core",
          /*
          FNXC:EngineTests 2026-07-08-04:50:
          FN-7669: prepend the gate-bundle builder to this project's globalSetup so
          the @fusion/core bundle above is rebuilt before any of the 18 forks spawn
          and resolve the alias. REBUILD-EVERY-RUN is the invalidation model — the
          builder's own esbuild dependency graph (not a hand list) determines what
          gets bundled, and because it reruns on every gate invocation there is no
          drift surface. The original root-level vitest-teardown.ts worker-root
          cleanup hook is preserved (both entries run; order does not matter, they
          are independent) rather than replaced, since `extends:true` does not
          array-merge test.globalSetup across project/root the way resolve.alias
          object-merges.
          */
          globalSetup: [
            resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts"),
            resolve(__dirname, "../../scripts/build-engine-core-gate-bundle.mjs"),
          ],
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
          /*
          FNXC:EngineTests 2026-07-08-00:00:
          Removed merger-post-merge.test.ts — retired by FN-7039 (graph is sole post-merge owner); it matched zero files. Graph post-merge is covered by workflow-graph-post-merge.test.ts in engine-default; no gate replacement needed.
          */
          include: [
            "src/__tests__/merger-merge-lifecycle.test.ts",
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
            "src/__tests__/hold-release.test.ts",
            "src/__tests__/workflow-graph-task-runner.test.ts",
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
            FNXC:EngineTests 2026-06-26-09:30:
            Quarantined 3 reliability-interactions files failing in CI full-suite run 28259456548 under the deletion ratchet.

            FNXC:EngineTests 2026-06-27-10:05:
            FN-7119 rescued the reliability batch by adding the production `updateSettings` heartbeat surface to scheduler fakes, so lease-recovery and todo/in-progress flapping call-count invariants run under the loaded reliability shard without quarantine.
            */
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

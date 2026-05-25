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
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers } },
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
          name: "engine-default",
          include: ["src/**/*.test.ts"],
          exclude: [
            "src/__tests__/reliability-interactions/**/*.test.ts",
            // Real-git heavy files run in the engine-slow project so local
            // `pnpm test` stays snappy. CI picks them up via `test:slow`
            // / `test:all` invoked from the root `test:full` script.
            "src/**/*.slow.test.ts",
            "node_modules/**",
            "dist/**",
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
          exclude: ["src/**/*.slow.test.ts"],
          // These tests assert event ordering across real worktrees. Parallel
          // execution under merger load caused subprocess-guard timeouts and
          // SQLite rowid interleaving (e.g. FN-5521 hit
          // `expected 24 to be less than 19` in merge-reuse-task-worktree).
          // Serialize at the file level; within-file order is already linear.
          poolOptions: { threads: { singleThread: true } },
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
          poolOptions: { threads: { singleThread: true } },
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

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "./src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

/*
FNXC:CoreTestInventory 2026-07-13-22:38:
Core test exclusions must exactly mirror the dated quarantine ledger. The PostgreSQL cutover removed the SQLite runtime and the expired 2026-07-10 exclusions no longer have ledger authority; keep this list empty and preserve behavior through active PostgreSQL counterparts.

FNXC:FullSuiteBookkeeping 2026-08-09-03:49:
All 14 core entries from the 2026-08-05 full-suite quarantine wave (run 30982276306) were deleted under the deletion ratchet after operator directive. These tested pre-refactor APIs/mock shapes (layer.db.select, peeled workflow IR resolvers, stale serialization literals) that no longer exist post-cutover. Array intentionally empty.
*/


export default defineConfig({
  resolve: {
    alias: {
      /*
      FNXC:MemoryMcp 2026-08-15-22:05:
      Core PG tests exercise engine source (e.g. command-center activity via engine's
      mcp-resolution.ts), which imports the Node-only `@fusion/core/mcp-builtin-servers` subpath.
      Without this entry the bare `@fusion/core` alias below prefix-rewrites the subpath into
      `src/index.ts/mcp-builtin-servers` and resolution fails. Mirrors engine/vitest.config.ts;
      subpath entries must precede the bare alias.
      */
      "@fusion/core/mcp-builtin-servers": resolve(__dirname, "./src/config/mcp-builtin-servers.ts"),
      "@fusion/core": resolve(__dirname, "./src/index.ts"),
      "@fusion/test-utils": resolve(__dirname, "./src/__test-utils__/workspace.ts"),
      "@fusion/plugin-sdk": resolve(__dirname, "../plugin-sdk/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    /*
    FNXC:QuarantineExcludes 2026-08-23-23:55:
    Quarantine excludes are listed INLINE here, not behind a named const. `check-quarantine-ledger.mjs`
    reads concrete `.test.ts` strings out of `exclude:` ARRAY LITERALS and does not resolve a variable
    reference, so an indirected list reads as an empty exclude array and every ledger row reports
    `missing-exclude` — the guard silently stops holding the ledger and the config in lockstep.
    Each entry needs a matching row in scripts/lib/test-quarantine.json (same commit, deletion ratchet).
    */
    exclude: [
      // Wall-clock lock-race assertion that fails under parallel load; rescue needs a real
      // block-detection probe (pg_locks / lock-wait), not a longer sleep. Deadline 2026-09-06.
      "src/__tests__/postgres/mission-store.pg.test.ts",
    ],
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

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

const quarantinedCliTests: string[] = [
  /*
  FNXC:CliTests 2026-06-14-01:36:
  The full @runfusion/fusion package lane timed out or leaked mock state across 24 CLI integration-heavy files under changed-test load, while the same files passed in smaller direct runs.
  They were quarantined per the flaky-test deletion ratchet instead of raising the 5s test timeout or relaxing assertions.

  FNXC:CliTests 2026-06-14-05:50:
  FN-6427 triaged all 24 quarantined CLI files and kept them in-window: 0 rescued, 0 deleted, 24 kept until the 2026-06-27 and 2026-06-28 deletion deadlines.
  Fresh direct runs passed, and the shared package-load signature needed a broader fixture/concurrency rescue before these high-value suites could safely rejoin the default lane.

  FNXC:CliTests 2026-06-14-01:42:
  FN-6430 rescued all 24 CLI quarantine entries after fixing shared test-isolation cleanup, rejecting inherited HOME roots from other invocations, removing pre-existing file-wide timeout bumps, and narrowing the mission real-store seam.
  Keep this array as an explicit empty rescue ledger so future CLI quarantines add entries in lockstep with scripts/lib/test-quarantine.json instead of resurrecting stale excludes.

  FNXC:CliTests 2026-06-15-04:07:
  FN-6483 observed extension-task-tools timing out only under the full @runfusion/fusion package lane while passing standalone immediately afterward.
  Quarantine the suite for the 14-day deletion ratchet instead of appeasing the load-sensitive timeout with wider test timeouts, retries, or worker changes.

  FNXC:CliTests 2026-06-15-07:46:
  FN-6486 rescued extension-task-tools by closing real TaskStore fixtures and replacing hoisted mock cleanup, then removed the quarantine in lockstep with scripts/lib/test-quarantine.json. Keep this array empty unless a future observed CLI flake is mirrored in the ledger in the same commit.

  FNXC:CliTests 2026-06-19-11:43:
  FN-6705 verification observed five CLI extension-tool files fail under the broad changed-package lane with test timeouts, ENOTEMPTY cleanup, or cross-test state drift; all except extension-task-tools passed in the direct failure-batch rerun, and extension-task-tools remained timeout-sensitive. Quarantine these existing integration-heavy files under the deletion ratchet instead of widening testTimeout, adding retries, or weakening assertions.

  FNXC:CliTests 2026-06-20-09:48:
  FN-6795 reloaded the five remaining 2026-06-19 CLI extension/research quarantines under the full @runfusion/fusion package lane after the FN-6734 close-before-remove seam and found no timeout, ENOTEMPTY, or cross-test state drift. Keep this exclude list empty in lockstep with scripts/lib/test-quarantine.json; future CLI load flakes must prove a new cleanup invariant before quarantine.

  FNXC:CliTests 2026-06-20-10:04:
  FN-6795 final loaded verification re-exposed extension-task-tools, extension.test's built-dist-barrel case, and bin's no-args dashboard launch as package-lane-only timeouts while targeted reruns passed. Retain/quarantine these files in lockstep with the ledger rather than widening 5s/15s timeouts, adding retries, or changing worker budgets; the 2026-06-19 entries still delete on 2026-07-03 unless a real fixture-load invariant is found.

  FNXC:CliTests 2026-06-21-09:58:
  FN-6839 rescues the retained bin, extension-task-tools, and extension suites by awaiting async TaskStore/cache shutdown before temp-root cleanup and proving the grouped/package lanes can run unexcluded. Keep the exclude list empty in lockstep with scripts/lib/test-quarantine.json; do not re-quarantine this loaded-lane signature without a new root-cause invariant.

  FNXC:CliTests 2026-06-25-11:15:
  The SQLite-to-PostgreSQL cutover (feature quarantine-sqlite-internals-tests) quarantines the 'fn db' CLI command test (src/commands/__tests__/db.test.ts) which exercises the SQLite VACUUM dispatch via mockGetDatabase. The VACUUM path is SQLite-only; PG compaction runs through pg-backup/health paths. Mirrored in scripts/lib/test-quarantine.json; will be DELETED when the SQLite code is removed.
  */
  // SQLite-internals quarantine (cutover): see scripts/lib/test-quarantine.json.
  /*
  FNXC:CliTests 2026-06-25-14:00:
  The SQLite-to-PostgreSQL cutover (feature quarantine-sqlite-internals-tests, retry session)
  recorded pre-existing CLI test failures observed during verify:workspace. Root causes varied:
  - extension-fn-secret-get.test.ts: store.getAsyncLayer mock drift (async-satellite dual-path).
  - chat.test.ts: MessageStore.getInbox returns non-array under Node 26 node:sqlite (SQLite-path).
  - skill-sync.test.ts: undocumented engine tools (fn_acquire_repo_worktree, fn_artifact_*).
  - version.test.ts: changeset script assertion drift (project now uses scripts/release.mjs).
  - dashboard.test.ts: mesh lifecycle mock assertion drift.
  - bundled-plugin-freshness.test.ts: bundled plugin build freshness drift.
  The entries were quarantined on sight per AGENTS.md; FN-8219 deleted the five
  in-scope expired entries on 2026-07-17 rather than rescuing or re-recording them.

  FNXC:CliTests 2026-07-17-09:45:
  FN-8210 restores package-config.test.ts to the package lane after the direct green run proved its failures were stale tsup plugin-external and verify:workspace expectations, not flaky behavior. Its old exclusion had no matching ledger entry; do not re-quarantine without new root-cause evidence and a lockstep ledger entry.
  */
  /*
  FNXC:CliTests 2026-07-17-10:00:
  FN-8219 reconciled the five 2026-06-25 config-only quarantines after their
  2026-07-09 deletion deadline. Per docs/testing.md, expired quarantines are
  deleted rather than rescued or re-recorded: extension-fn-secret-get
  (async-layer mock drift), skill-sync (undocumented engine tools), version
  (release-script assertion drift), dashboard (mesh lifecycle mock drift), and
  bundled-plugin-freshness (build freshness drift) are now git-history-only.
  The quarantine ledger has no packages/cli rows. FN-8223 now enforces full
  CLI config↔ledger lockstep, including package-config.test.ts if re-quarantined.
  */
  /*
  FNXC:CliTests 2026-06-25-16:30:
  The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, PHASE A)
  quarantines the remaining non-quarantined CLI test files that construct a
  SQLite-backed store (new TaskStore(..., {inMemoryDb: true}) / new Database(...)).
  The SQLite runtime code (Database class, inMemoryDb option, sync prepare()/
  getDatabase() surface) is being deleted in this feature. Per the AGENTS.md
  flaky-test deletion ratchet, these tests are quarantined on sight (not migrated
  to PG) because they exercise code that will be deleted. Mirrored in
  scripts/lib/test-quarantine.json; will be DELETED when the SQLite code is removed.
  */
  /*
  FNXC:CliTests 2026-06-25-18:00:
  The SQLite-to-PostgreSQL cutover (feature delete-sqlite-runtime-final, SESSION 3 PHASE A)
  quarantines remaining CLI test files that construct a SQLite-backed store via inMemoryDb.
  These tests exercise the SQLite Database class being deleted in this feature. Quarantined
  on sight per AGENTS.md; mirrored in scripts/lib/test-quarantine.json.
  FNXC:CliTests 2026-06-26-09:30:
  extension.test.ts failed in CI full-suite shard 3/4 with 'Target cannot be null or undefined' in the fn_delegate_task test and was quarantined under the deletion ratchet.

  FNXC:CliTests 2026-06-27-10:05:
  FN-7119 re-ran extension.test.ts twice with the exclude removed and the fn_delegate_task null-target symptom no longer reproduces at HEAD. Keep this list empty so delegate-task validation coverage stays active in the package lane.

  FNXC:CliTests 2026-07-16-06:27:
  FN-8093 rescues the isolated dist-barrel test before its deletion deadline. Its entire CPU-bound recompilation unit and fixture seeding run once in suite-scoped beforeAll, while each default-5s test body only executes an already-injected fn_task_list tool. The exclusion and matching ledger entry were removed in lockstep after loaded-lane verification; do not re-add either unless a new root cause is quarantined under the deletion ratchet.
  */
  /*
  FNXC:CliTests 2026-07-16-09:00:
  FN-8077 removed project-context.test.ts from this list and the ledger in lockstep. Its CentralCore coverage now uses the external PostgreSQL test harness under pgDescribe rather than launching an embedded postmaster for each test in forked loaded lanes; pure formatting coverage remains ungated.
  */
  /*
  FNXC:CliTests 2026-07-18-08:50:
  Full-suite shard 4 (runs 29637256028, 29637376023) re-exposed package-lane cascade:
  extension-dist-barrel beforeAll hookTimeout under PG load, plus lock-retry timeouts,
  cascading 87 failures. Quarantine the observed integration-heavy files on sight in
  lockstep with scripts/lib/test-quarantine.json — do not raise hookTimeout/testTimeout.
  */
  "src/__tests__/bin.test.ts",
  "src/__tests__/extension-agent-update.test.ts",
  "src/__tests__/extension-dist-barrel.test.ts",
  "src/__tests__/extension-goal-tools.test.ts",
  "src/__tests__/extension-mission-goal-tools.test.ts",
  "src/__tests__/extension-tool-timeout.test.ts",
  "src/__tests__/extension-workflow-tools.test.ts",
  "src/__tests__/extension.test.ts",
  "src/__tests__/task-plan.test.ts",
  "src/commands/__tests__/mcp-lock-retry.test.ts",
  "src/commands/__tests__/plugin.test.ts",
  "src/commands/__tests__/task-lock-retry.test.ts",
  "src/commands/dashboard-tui/__tests__/app.test.tsx",
  "src/commands/dashboard-tui/__tests__/terminal-attach.test.ts",
];

export default defineConfig({
  resolve: {
    // Keep these aliases exact and ordered (subpaths before package roots).
    // In fresh worktrees, internal packages may not have dist/ built yet, and
    // Vite otherwise resolves workspace package exports.import to dist/*.js.
    // Anchored regex aliases force CLI tests to use source entrypoints instead.
    alias: [
      { find: /^@fusion\/core\/gh-cli$/, replacement: resolve(__dirname, "../core/src/gh-cli.ts") },
      { find: /^@fusion\/core$/, replacement: resolve(__dirname, "../core/src/index.ts") },
      { find: /^@fusion\/dashboard\/planning$/, replacement: resolve(__dirname, "../dashboard/src/planning.ts") },
      { find: /^@fusion\/dashboard$/, replacement: resolve(__dirname, "../dashboard/src/index.ts") },
      { find: /^@fusion\/engine$/, replacement: resolve(__dirname, "../engine/src/index.ts") },
      { find: /^@fusion\/plugin-sdk$/, replacement: resolve(__dirname, "../plugin-sdk/src/index.ts") },
      {
        find: /^@fusion-plugin-examples\/droid-runtime\/probe$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-droid-runtime/src/probe.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/droid-runtime$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-droid-runtime/src/index.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/hermes-runtime$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-hermes-runtime/src/index.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/openclaw-runtime$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-openclaw-runtime/src/index.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/paperclip-runtime$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-paperclip-runtime/src/index.ts"),
      },
      /*
      FNXC:PluginTests 2026-07-03-12:30:
      runtime-provider-probes.ts (transitively imported by dashboard) imports probeCursorBinary from @fusion-plugin-examples/cursor-runtime. Without these source aliases, Vite tries to resolve the package's dist/ exports which don't exist in a source checkout.
      */
      {
        find: /^@fusion-plugin-examples\/cursor-runtime\/probe$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-cursor-runtime/src/probe.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/cursor-runtime$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-cursor-runtime/src/index.ts"),
      },
      /*
      FNXC:GrokCli 2026-07-08-00:00:
      runtime-provider-probes.ts (transitively imported by dashboard) imports probeGrokBinary from @fusion-plugin-examples/grok-runtime (FN-7705, mirroring the Cursor alias above).
      */
      {
        find: /^@fusion-plugin-examples\/grok-runtime\/probe$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-grok-runtime/src/probe.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/grok-runtime$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-grok-runtime/src/index.ts"),
      },
      /*
      FNXC:OmpAcp 2026-07-11-23:35:
      runtime-provider-probes imports @fusion-plugin-examples/omp-runtime; alias source for checkout tests.
      */
      {
        find: /^@fusion-plugin-examples\/omp-runtime\/probe$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-omp-runtime/src/probe.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/omp-runtime$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-omp-runtime/src/index.ts"),
      },
      /*
      FNXC:PluginTests 2026-07-04-09:30:
      The roadmap plugin (@fusion-plugin-examples/roadmap) is imported by the CLI extension. Without source aliases, Vite resolves to the dist/ exports which don't exist in a source checkout.
      */
      {
        find: /^@fusion-plugin-examples\/roadmap\/server$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-roadmap/src/server/index.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/roadmap\/roadmap-suggestions$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-roadmap/src/roadmap-suggestions.ts"),
      },
      {
        find: /^@fusion-plugin-examples\/roadmap$/,
        replacement: resolve(__dirname, "../../plugins/fusion-plugin-roadmap/src/index.ts"),
      },
      { find: /^@fusion\/test-utils$/, replacement: resolve(__dirname, "../core/src/__test-utils__/workspace.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // build-exe + build-exe-cross live in their own vitest project
    // (see vitest.build-exe.config.ts) so the rest of the CLI suite can
    // run with file parallelism enabled.
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/build-exe*.test.ts", ...quarantinedCliTests],
    setupFiles: [
      resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts"),
    ],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
    fileParallelism: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "dist/**"],
    },
  },
});

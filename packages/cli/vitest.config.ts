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

  FNXC:CliTests 2026-06-26-09:30:
  extension.test.ts failed in CI full-suite shard 3/4 with 'Target cannot be null or undefined' in the fn_delegate_task test and was quarantined under the deletion ratchet.

  FNXC:CliTests 2026-06-27-10:05:
  FN-7119 re-ran extension.test.ts twice with the exclude removed and the fn_delegate_task null-target symptom no longer reproduces at HEAD. Keep this list empty so delegate-task validation coverage stays active in the package lane.
  */
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

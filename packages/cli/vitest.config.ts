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

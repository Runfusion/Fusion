import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const defaultMaxWorkers = 2;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(4, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

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
      { find: /^@fusion\/test-utils$/, replacement: resolve(__dirname, "../core/src/__test-utils__/workspace.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    // build-exe + build-exe-cross live in their own vitest project
    // (see vitest.build-exe.config.ts) so the rest of the CLI suite can
    // run with file parallelism enabled.
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/build-exe*.test.ts"],
    setupFiles: [
      "./src/__tests__/setup-test-isolation.ts",
      resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts"),
    ],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
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

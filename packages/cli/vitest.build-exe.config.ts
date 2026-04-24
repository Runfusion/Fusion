import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Separate project for the native-binary build tests. These invoke `bun build`
// and can peg CPU for minutes. They are skipped by default (see skipIf guards
// inside the test files) and run via `pnpm test:build-exe` or when CI=1 /
// FUSION_TEST_BUILD_EXE=1 is set.
//
// fileParallelism is false here because both suites write to packages/cli/dist/
// and would race each other in parallel workers.

export default defineConfig({
  resolve: {
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
    include: ["src/__tests__/build-exe*.test.ts"],
    setupFiles: [
      "./src/__tests__/setup-test-isolation.ts",
      resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts"),
    ],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    fileParallelism: false,
    testTimeout: 360_000,
    hookTimeout: 360_000,
  },
});

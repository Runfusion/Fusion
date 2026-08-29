import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  resolve: {
    alias: {
      // Use @fusion/core's TypeScript source so tests don't require a dist build.
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["../core/src/__test-utils__/vitest-setup.ts"],
    globalSetup: ["../core/src/__test-utils__/vitest-teardown.ts"],
    maxWorkers,
    minWorkers: 1,
  },
});

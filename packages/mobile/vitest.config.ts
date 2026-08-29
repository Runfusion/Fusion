import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: [resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts")],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
    fileParallelism: true,
  },
});

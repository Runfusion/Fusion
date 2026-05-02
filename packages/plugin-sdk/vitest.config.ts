import { defineConfig } from "vitest/config";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Cap fan-out to 4 to avoid saturating high-core machines under workspace concurrency.
const defaultMaxWorkers = Math.min(4, Math.max(1, cpus().length - 1));
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers);
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: [resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts")],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    pool: "threads",
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers } },
  },
});

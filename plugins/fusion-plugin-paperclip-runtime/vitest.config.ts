import { defineConfig } from "vitest/config";

const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "2", 10);
const maxWorkers = Math.max(1, Math.min(4, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : 2));
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": new URL("../../packages/core/src/index.ts", import.meta.url).pathname,
      "@fusion/plugin-sdk": new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url).pathname,
      "@fusion/engine": new URL("../../packages/engine/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    pool: "threads",
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
  },
});

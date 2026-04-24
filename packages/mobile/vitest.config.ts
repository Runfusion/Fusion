import { defineConfig } from "vitest/config";
import { cpus } from "node:os";

const defaultMaxWorkers = Math.max(1, cpus().length - 1);
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers);
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    fileParallelism: true,
  },
});

import { defineConfig } from "vitest/config";

const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "2", 10);
const maxWorkers = Math.max(1, Math.min(4, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : 2));
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "threads",
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
  },
});

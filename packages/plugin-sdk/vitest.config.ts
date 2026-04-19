import { defineConfig } from "vitest/config";

const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "1", 10);
const maxWorkers = Math.max(1, Math.min(1, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : 1));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "threads",
    maxWorkers,
  },
});

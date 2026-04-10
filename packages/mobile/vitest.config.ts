import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

const defaultMaxWorkers = Math.max(1, Math.min(4, Math.ceil(availableParallelism() / 8)));
const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    maxWorkers,
    fileParallelism: true,
  },
});

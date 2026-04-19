import { defineConfig } from "vitest/config";

const defaultMaxWorkers = 1;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(1, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers,
    fileParallelism: true,
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "desktop",
          include: ["src/__tests__/**/*.test.ts"],
          pool: "threads",
          isolate: true,
        },
      },
      {
        test: {
          name: "desktop-renderer",
          include: ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx"],
          environment: "jsdom",
          isolate: true,
        },
      },
    ],
  },
});

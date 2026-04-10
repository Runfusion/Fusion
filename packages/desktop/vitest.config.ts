import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

const defaultMaxWorkers = Math.max(1, Math.min(4, Math.ceil(availableParallelism() / 8)));
const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);

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

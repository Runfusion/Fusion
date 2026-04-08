import { defineConfig } from "vitest/config";

const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "16", 10);

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environmentMatchGlobs: [["src/renderer/**", "jsdom"]],
    pool: "threads",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers,
    fileParallelism: true,
    passWithNoTests: true,
  },
});

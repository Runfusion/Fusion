import { defineConfig } from "vitest/config";

const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "16", 10);

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environmentMatchGlobs: [["src/renderer/**", "jsdom"]],
    maxWorkers,
    fileParallelism: true,
    pool: "threads",
    passWithNoTests: true,
  },
});

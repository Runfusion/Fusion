import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const defaultMaxWorkers = Math.max(1, Math.min(2, Math.ceil(availableParallelism() / 8)));
const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const coreSourceEntry = fileURLToPath(new URL("../core/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": coreSourceEntry,
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
    maxWorkers,
    fileParallelism: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts", "dist/**"],
    },
  },
});

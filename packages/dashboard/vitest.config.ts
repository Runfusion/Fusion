import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { availableParallelism } from "node:os";

const defaultMaxWorkers = Math.max(1, Math.min(4, Math.ceil(availableParallelism() / 4)));
const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
      "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["app/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers,
    fileParallelism: true,
    isolate: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "dist/**"],
    },
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "2", 10);
const maxWorkers = Math.max(1, Math.min(4, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : 2));
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

const engineGuardStub = fileURLToPath(new URL("./src/__tests__/engine-guard-stub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/engine": fileURLToPath(new URL("../../packages/engine/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    pool: "threads",
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    // ── Engine guard ──────────────────────────────────────────────────────
    // This setup file installs a vi.mock("@fusion/engine") that throws if
    // the real engine is loaded. All plugin tests must mock "../pi-module.js"
    // (the seam) to prevent the real @fusion/engine import chain.
    //
    // If you introduce a test that genuinely needs @fusion/engine:
    //   1. Create a setup-test-isolation.ts (HOME override) following the
    //      pattern in packages/core/src/__tests__/setup-test-isolation.ts
    //   2. Add it to setupFiles BEFORE this guard
    //   3. Add a vi.mock("@fusion/engine", ...) override in the test file
    //      or a dedicated setup file to replace the throwing mock
    setupFiles: ["./src/__tests__/setup-engine-guard.ts"],
    alias: {
      // Resolve @fusion/engine to a local test stub so Vitest can register the
      // guard mock without requiring built dist artifacts from packages/engine.
      "@fusion/engine": engineGuardStub,
    },
  },
});

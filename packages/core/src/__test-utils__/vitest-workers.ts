import { cpus } from "node:os";

interface ComputeMaxWorkersOptions {
  defaultCap?: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

// Shared worker-budget computation for every package's vitest.config.
//
// Resolution order:
//   1. VITEST_MAX_WORKERS — explicit per-run override, wins unconditionally.
//   2. FUSION_TEST_TOTAL_WORKERS — global budget across the workspace, divided
//      by FUSION_TEST_CONCURRENCY (default 1). Lets `pnpm -r` runs cap total
//      fan-out instead of multiplying per package.
//   3. defaultCap — small ceiling (2 by default) so a single package run on a
//      high-core machine stays gentle.
// All paths clamp to (cpus - 1) so we never oversubscribe.
export function computeMaxWorkers(options: ComputeMaxWorkersOptions = {}): number {
  const { defaultCap = 2 } = options;

  const cpuCap = Math.max(1, cpus().length - 1);

  const explicit = parsePositiveInt(process.env.VITEST_MAX_WORKERS);
  const totalBudget = parsePositiveInt(process.env.FUSION_TEST_TOTAL_WORKERS);
  const concurrency = Math.max(1, parsePositiveInt(process.env.FUSION_TEST_CONCURRENCY) ?? 1);

  let workers: number;
  if (explicit !== undefined) {
    // In recursive workspace runs we provide a global worker budget via
    // FUSION_TEST_TOTAL_WORKERS/FUSION_TEST_CONCURRENCY. Clamp explicit
    // VITEST_MAX_WORKERS to that per-package share so `VITEST_MAX_WORKERS=4`
    // at the workspace root doesn't fan out to 4 workers in every package.
    const workspaceBudget = totalBudget !== undefined
      ? Math.max(1, Math.floor(totalBudget / concurrency))
      : undefined;
    workers = workspaceBudget !== undefined ? Math.min(explicit, workspaceBudget) : explicit;
  } else if (totalBudget !== undefined) {
    workers = Math.max(1, Math.floor(totalBudget / concurrency));
  } else {
    workers = defaultCap;
  }

  workers = Math.min(workers, cpuCap);
  process.env.VITEST_MAX_WORKERS = String(workers);
  return workers;
}

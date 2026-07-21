import { cpus } from "node:os";

interface ComputeMaxWorkersOptions {
  defaultCap?: number;
  /*
   * FNXC:PgTestWorkerCap 2026-07-18-18:00:
   * Hard upper clamp applied to the FINAL resolved worker count, AFTER every
   * other resolution path (explicit VITEST_MAX_WORKERS, workspace budget, CPU
   * default) and the cpuCap clamp. Purpose: a suite bound by a single shared
   * external resource (the pg-gate's one Postgres server, which serializes
   * CREATE/DROP DATABASE DDL) must NOT scale its fork fan-out with CPU count.
   * On a 28-core dev box the CPU-derived default is 6 forks; 6 concurrent forks
   * each running the DDL-heavy per-file schema-template build oversubscribe the
   * one Postgres until every beforeAll exceeds the 15s hookTimeout (the whole
   * pg-gate then reports 23/23 hook timeouts). CI's low-core runners stay near 2
   * and pass, which is why this only bites high-core local machines. `maxCap`
   * lets the pg vitest config pin a DB-safe ceiling while low-core machines keep
   * using their smaller CPU-derived count. See vitest.pg.config.ts.
   */
  maxCap?: number;
}

function computeDefaultCap(cpuCap: number): number {
  return Math.max(2, Math.min(6, Math.ceil(cpuCap / 2)));
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
//   3. defaultCap — CPU-aware default for local single-package runs so modern
//      machines can use more parallelism without runaway fan-out.
// All paths clamp to (cpus - 1) so we never oversubscribe.
export function computeMaxWorkers(options: ComputeMaxWorkersOptions = {}): number {
  const cpuCap = Math.max(1, cpus().length - 1);
  const { defaultCap = computeDefaultCap(cpuCap), maxCap } = options;

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
  // DB-bound suites clamp below the CPU-derived count so fork fan-out never
  // oversubscribes a single shared external resource (see maxCap docs).
  if (maxCap !== undefined && maxCap > 0) {
    workers = Math.max(1, Math.min(workers, maxCap));
  }
  process.env.VITEST_MAX_WORKERS = String(workers);
  return workers;
}

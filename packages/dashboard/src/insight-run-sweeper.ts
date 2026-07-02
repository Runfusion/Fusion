import type { AsyncInsightStore, InsightRun, InsightStore } from "@fusion/core";

export const ORPHAN_GRACE_MS = 30_000;
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;

/*
 * FNXC:InsightStore 2026-06-28-10:05:
 * The stale-run sweeper drives either backend: the sync SQLite `InsightStore` or
 * the PostgreSQL-backed `AsyncInsightStore`. Both expose the same method names,
 * so the sweeper types the store as the union and `await`s every call; a sync
 * method's awaited return equals its direct return, preserving recovery
 * semantics across both backends.
 */
type SweeperInsightStore = InsightStore | AsyncInsightStore;

type RecoverySource = "startup" | "periodic" | "drive_by" | "manual";

type RecoverParams = {
  insightStore: SweeperInsightStore;
  run: InsightRun | null | undefined;
  now: Date;
  activeRunControllers: Map<string, AbortController>;
  graceMs?: number;
  source?: RecoverySource;
};

function getRunAgeMs(run: Pick<InsightRun, "startedAt" | "createdAt">, nowMs: number): number {
  const anchor = run.startedAt ?? run.createdAt;
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return 0;
  return Math.max(0, nowMs - anchorMs);
}

export async function recoverOrphanedInsightRun(params: RecoverParams): Promise<{ recovered: boolean; reason?: string }> {
  const {
    insightStore,
    run,
    now,
    activeRunControllers,
    graceMs = ORPHAN_GRACE_MS,
    source = "manual",
  } = params;

  if (!run || !["pending", "running"].includes(run.status)) {
    return { recovered: false, reason: "not_active_status" };
  }

  if (activeRunControllers.has(run.id)) {
    return { recovered: false, reason: "has_live_controller" };
  }

  const ageMs = getRunAgeMs(run, now.getTime());
  if (ageMs <= graceMs) {
    return { recovered: false, reason: "within_grace_window" };
  }

  const nowIso = now.toISOString();
  await insightStore.appendRunEvent(run.id, {
    type: "warning",
    status: run.status,
    classification: "non_retryable",
    message: `Recovered orphaned active run after ${ageMs}ms without controller ownership`,
    metadata: {
      recovery: "orphaned_active_run",
      ageMs,
      graceMs,
      hadController: false,
      anchorTimestamp: run.startedAt ?? run.createdAt,
      recoverySource: source,
    },
  });

  const failed = await insightStore.updateRun(run.id, {
    status: "failed",
    summary: "Recovered orphaned run",
    error: "Run was marked active but had no live controller after grace period",
    completedAt: nowIso,
    lifecycle: {
      ...run.lifecycle,
      terminalReason: "failed",
      terminalCause: "orphaned_active_run_recovered",
      failureClass: "non_retryable",
      retryable: false,
    },
  });

  if (!failed) {
    return { recovered: false, reason: "update_failed" };
  }

  await insightStore.appendRunEvent(run.id, {
    type: "status_changed",
    status: "failed",
    classification: "non_retryable",
    message: "Run marked failed after orphaned active-run recovery",
    metadata: {
      recovery: "orphaned_active_run",
      recoverySource: source,
    },
  });

  return { recovered: true };
}

export async function sweepStaleInsightRuns(params: {
  insightStore: SweeperInsightStore;
  activeRunControllers: Map<string, AbortController>;
  now?: Date;
  graceMs?: number;
  source: RecoverySource;
}): Promise<{ scanned: number; recovered: number; skipped: number }> {
  const {
    insightStore,
    activeRunControllers,
    now = new Date(),
    graceMs = ORPHAN_GRACE_MS,
    source,
  } = params;

  const thresholdIso = new Date(now.getTime() - graceMs).toISOString();
  const staleRuns = await insightStore.listStalePendingRuns(thresholdIso);

  let recovered = 0;
  let skipped = 0;

  for (const run of staleRuns) {
    if (activeRunControllers.has(run.id)) {
      skipped += 1;
      continue;
    }

    const result = await recoverOrphanedInsightRun({
      insightStore,
      run,
      now,
      activeRunControllers,
      graceMs,
      source,
    });

    if (result.recovered) {
      recovered += 1;
    } else {
      skipped += 1;
    }
  }

  return {
    scanned: staleRuns.length,
    recovered,
    skipped,
  };
}

export function startInsightRunSweeper(params: {
  insightStore: SweeperInsightStore;
  activeRunControllers: Map<string, AbortController>;
  intervalMs?: number;
  graceMs?: number;
  logger?: Pick<Console, "warn">;
}): { dispose: () => void } {
  const {
    insightStore,
    activeRunControllers,
    intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    graceMs = ORPHAN_GRACE_MS,
    logger,
  } = params;

  const timer = setInterval(() => {
    // FNXC:InsightStore 2026-06-28-10:05: sweep is async now; swallow rejections
    // so a backend hiccup never crashes the interval-driven background sweeper.
    void sweepStaleInsightRuns({
      insightStore,
      activeRunControllers,
      graceMs,
      source: "periodic",
    }).catch((error) => {
      logger?.warn?.("[insight-sweeper] periodic sweep failed", error);
    });
  }, intervalMs);

  timer.unref?.();

  return {
    dispose: () => clearInterval(timer),
  };
}

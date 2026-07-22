/*
FNXC:MergeQueue 2026-07-15-10:05:
Pure decision helpers for wedged-merge reclaim and merge-generation settle.
Keeps status-aware silence policy and generation gating unit-testable without booting ProjectEngine.
*/

/** Transient merge-activity statuses set by the AI/PR merge pipeline. */
export const MERGE_ACTIVITY_STATUSES = new Set([
  "merging",
  "merging-pr",
  "merging-fix",
  "reviewing",
]);

/** Statuses that mean the merge agent is still in verify/land work (long bash tools are normal). */
export const MERGING_PHASE_STATUSES = new Set(["merging", "merging-pr", "merging-fix"]);

/**
 * Minimum silence before reclaiming a live merge still in the `merging*` phase.
 * Monorepo install/test can exceed default taskStuckTimeoutMs as a single tool call with no agent logs.
 */
export const DEFAULT_MERGING_PHASE_SILENCE_FLOOR_MS = 45 * 60_000;

export function resolveMergingPhaseSilenceFloorMs(
  stuckTimeoutMs: number,
  configuredFloorMs?: number | null,
): number {
  const floor =
    configuredFloorMs != null && Number.isFinite(configuredFloorMs) && configuredFloorMs > 0
      ? configuredFloorMs
      : DEFAULT_MERGING_PHASE_SILENCE_FLOOR_MS;
  return Math.max(stuckTimeoutMs, floor);
}

export type WedgedMergeReclaimInput = {
  /** Task status while the process still owns activeMergeTaskId. */
  status: string | null | undefined;
  /** ms since last merger agent-log activity (or claim wall-clock fallback). */
  silenceMs: number;
  /** Project taskStuckTimeoutMs. */
  stuckTimeoutMs: number;
  /** Optional override for merging-phase silence floor. */
  mergingSilenceFloorMs?: number | null;
};

/*
FNXC:MergeQueue 2026-07-15-10:05:
Reclaim policy:
- reviewing (post-squash AI review): reclaim after stuckTimeoutMs of merger silence (the original hang shape).
- merging/merging-pr/merging-fix: require a higher silence floor so a single long bash (pnpm test) is not false-reclaimed.
- null/other with a live active owner: treat as a dead pump (identity without progress) and reclaim after stuckTimeoutMs.
*/
export function shouldReclaimWedgedMerge(input: WedgedMergeReclaimInput): boolean {
  const { silenceMs, stuckTimeoutMs } = input;
  if (!Number.isFinite(stuckTimeoutMs) || stuckTimeoutMs <= 0) return false;
  if (!Number.isFinite(silenceMs) || silenceMs < 0) return false;
  if (silenceMs < stuckTimeoutMs) return false;

  const status = input.status ?? null;
  if (status === "reviewing") return true;

  if (status != null && MERGING_PHASE_STATUSES.has(status)) {
    const floor = resolveMergingPhaseSilenceFloorMs(stuckTimeoutMs, input.mergingSilenceFloorMs);
    return silenceMs >= floor;
  }

  // Dead pump: active owner but no merge-activity status (cleared/orphaned identity).
  return true;
}

/**
 * Whether a new merge body may start given an outstanding prior body promise.
 * Pure: true only when no prior body is tracked.
 */
export function canStartNextMergeBody(priorBodyInFlight: Promise<unknown> | null | undefined): boolean {
  return priorBodyInFlight == null;
}

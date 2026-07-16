/**
 * Shared definition of "a task is stamped with an active merge status".
 *
 * FNXC:MergeReliability 2026-07-15-21:45 (FN-8004 follow-up):
 * A merge-active status (`merging`/`reviewing`/`landing`/…) means "a merger owns this task right
 * now". Two consumers must agree on when that stamp is STALE — i.e. no live merger holds it:
 *
 *  - `SelfHealingManager.recoverStaleMergingStatus()` clears the stamp automatically.
 *  - The dashboard's manual Retry gate refuses to retry a task that a live merger owns.
 *
 * Before this module they did NOT agree: self-healing recovered stale stamps after a bounded
 * delay, but the manual gate rejected EVERY merge-active status outright ("Task is not in a
 * retryable state (current status: landing)"). So when a merger died mid-flight — a crash, an
 * engine restart, an operator SIGTERM — the operator's own escape hatch was blocked precisely
 * when they needed it, and the only recourse was waiting out the sweep.
 *
 * This is the same class of bug as the FN-8004 transient-classifier split: one concept, two
 * definitions, silently diverging. Keeping the predicate here means the manual path can never be
 * stricter than the automatic one.
 *
 * Leaf module by design — types only, no logger/store imports — so both the engine's sweep and
 * the dashboard route can import it without inheriting a runtime dependency chain.
 */
import type { Task } from "@fusion/core";

/**
 * Statuses meaning "a merger owns this task right now".
 *
 * `reviewing` is the AI-merge review pass; `landing` is the ref-advance/finalize phase. Both are
 * as reclaimable as `merging` when no live owner exists — a process killed during either leaves
 * the same orphaned stamp.
 */
export const ACTIVE_MERGE_STATUSES: ReadonlySet<string> = new Set([
  "merging",
  "merging-pr",
  "merging-fix",
  "reviewing",
  "landing",
]);

/** How long a merge-active stamp must sit untouched before it counts as orphaned. */
export const DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS = 5 * 60_000;

export function isMergeActiveStatus(status: string | null | undefined): boolean {
  return Boolean(status && ACTIVE_MERGE_STATUSES.has(status));
}

/**
 * True when `task` carries a merge-active stamp that no live merger owns.
 *
 * Deliberately conservative — a task is stale only when EVERY check passes:
 *  1. it carries a merge-active status;
 *  2. it is not the in-process merge owner (`activeMergeTaskId`), which proves a live merger; and
 *  3. its `updatedAt` has not moved for `minAgeMs`, so a merger that is slow but progressing
 *     (each phase writes a log entry, refreshing `updatedAt`) is never mistaken for a dead one.
 *
 * Rule 3 is what makes this safe to expose to a manual Retry button: an operator cannot yank a
 * merge that is actually running, because a running merge keeps its own stamp fresh.
 */
export function isStaleMergeActiveStatus(
  task: Pick<Task, "id" | "status" | "updatedAt">,
  opts: { activeMergeTaskId?: string | null; nowMs?: number; minAgeMs?: number } = {},
): boolean {
  if (!isMergeActiveStatus(task.status)) return false;

  // A live in-process owner is authoritative proof the merge is running.
  if (opts.activeMergeTaskId && opts.activeMergeTaskId === task.id) return false;

  const minAgeMs = opts.minAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS;
  if (!Number.isFinite(minAgeMs) || minAgeMs <= 0) return false;

  const updatedAtMs = task.updatedAt ? Date.parse(task.updatedAt) : Number.NaN;
  // Unparseable timestamp = no staleness evidence. Fail closed: never call it stale.
  if (!Number.isFinite(updatedAtMs)) return false;

  return (opts.nowMs ?? Date.now()) - updatedAtMs >= minAgeMs;
}

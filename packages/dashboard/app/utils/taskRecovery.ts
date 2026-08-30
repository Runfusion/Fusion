import type { Task } from "@fusion/core";

/**
 * FNXC:TaskRecoveryAffordance 2026-07-16-12:00:
 * FN-8167 treats a finite, strictly-future automatic recovery schedule as non-terminal.
 * It wins over a stale `failed` status, so failed chrome and manual Retry render only
 * after automatic recovery is no longer pending.
 */
export function hasPendingAutomaticRecovery(task: Task, nowMs = Date.now()): boolean {
  const recoveryAtMs = Date.parse(task.nextRecoveryAt ?? "");
  return Number.isFinite(recoveryAtMs) && recoveryAtMs > nowMs;
}

/**
 * Determine whether a task needs a human-initiated retry.
 *
 * FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
 * FN-206 retains this exported predicate for callers/tests that classify legacy failure state, but
 * removes its menu Retry gate, Actions-menu visibility disjunct, and Task Detail failure-alert gate.
 * Retry now repeats any mutable live stage, including one awaiting automatic recovery.
 *
 * FNXC:TaskRecoveryAffordance 2026-07-16-12:00:
 * A nonzero `recoveryRetryCount` and elapsed `nextRecoveryAt` do not themselves make a
 * task retryable: elapsed or absent schedules fall back to terminal-status rules. A
 * strictly-future schedule suppresses manual retry regardless of status.
 */
export function isTaskManuallyRetryable(task: Task, nowMs = Date.now()): boolean {
  if (hasPendingAutomaticRecovery(task, nowMs)) {
    return false;
  }

  return task.status === "failed"
    || task.status === "stuck-killed"
    || task.status === "planning"
    || task.status === "needs-replan"
    || (task.stuckKillCount ?? 0) > 0;
}

import type { Task } from "./types.js";

export interface CompletedPromotionFailureProvenanceEvaluation {
  /** True when the task's current execution lifecycle ended in a failure/refusal park. */
  blocked: boolean;
  /** Stable reason code for the no-action run-audit event. */
  reason?: "failure-provenance";
  /** The blocking failure-marker log action text (diagnostics only). */
  markerAction?: string;
}

/**
 * FNXC:Lifecycle 2026-07-16-10:30:
 * FN-8141 laundered a failed task into `done`: the executor parked the task `failed`
 * ("task parked failed during no-fn_task_done retry" / "fn_task_done refusal retry budget exhausted"),
 * the pause-abort machinery bounced it to `todo`, and 12 minutes later the stranded-completed
 * promoters (`recoverStrandedCompletedTodoTasks` / `recoverCompletedTasks` in self-healing.ts)
 * moved it to `in-review` because every step was done/skipped — overriding the honest failure park.
 *
 * Invariant restored: a stranded-completed promoter must NOT promote a task whose MOST RECENT
 * execution-outcome in the durable task log was a failure/refusal park. The escape hatch stays
 * intact because an operator retrying/moving the task produces a fresh execution that logs a clean
 * completion marker ("Task marked done by agent" / "All steps complete — implicit fn_task_done"),
 * which is more recent than the failure marker and therefore supersedes it.
 *
 * Recency by construction: we scan the log tail and stop at the FIRST (most recent) entry that is
 * either a failure park or a clean completion. A failure that predates a newer clean execution is
 * never reached — the completion marker decides first. A task with zero failure markers is never
 * blocked. The scan is bounded to the tail so these per-housekeeping-cycle sweeps stay cheap.
 *
 * FNXC:Lifecycle 2026-07-16-14:05:
 * CLEAN_COMPLETION_MARKERS must be EXECUTION outcomes only — a log line the agent's execution
 * lifecycle wrote when it genuinely completed the work (an accepted fn_task_done, or the implicit
 * all-steps-done completion). The PROMOTER'S OWN OUTPUT is never evidence: the stranded-completed
 * recovery line "Auto-recovered: task work was complete but stranded ..." (executor.ts
 * recoverCompletedTasks) is self-healing narrating "I promoted this", not proof the execution ended
 * cleanly. Counting it as a clean marker let any task carrying a promotion written by the pre-#2257
 * buggy sweep (e.g. the real FN-8141 row, or any pre-guard history) permanently unblock the guard —
 * the tail scan hit the promotion line before the older failure park and returned not-blocked,
 * re-enabling the exact laundering this guard exists to stop. Removed for that reason. Likewise the
 * honest-blocked exit ("BLOCKED: ...") is NOT a clean completion and must never be a marker.
 */

/** Bound the tail scan; sweeps run every housekeeping cycle over many tasks. */
const MAX_LOG_SCAN = 250;

/**
 * Log-action substrings that mark the current execution lifecycle ending in a failure/refusal park.
 * Sources (packages/engine/src/executor.ts):
 *  - "task parked failed during no-fn_task_done retry" (FN-7965 terminal park honoring)
 *  - "fn_task_done refusal retry budget exhausted" (explicit fn_task_done refusal exhaustion)
 *  - "execution failed after task-done retry budget was exhausted" (retry-budget failure)
 *  - "execution failed because implicit fn_task_done was refused" (implicit-completion refusal)
 */
const FAILURE_PARK_MARKERS = [
  "task parked failed during no-fn_task_done retry",
  "fn_task_done refusal retry budget exhausted",
  "execution failed after task-done retry budget was exhausted",
  "execution failed because implicit fn_task_done was refused",
];

/**
 * Log-action substrings that mark a fresh clean EXECUTION outcome. A clean completion appearing
 * MORE RECENTLY than a failure park proves the failing lifecycle was superseded by a good one.
 * These are execution-lifecycle outcomes ONLY — never promoter/recovery output (see the header
 * FNXC note; "Auto-recovered: task work was complete but stranded" was removed because it is the
 * promoter narrating its own move, not proof the execution ended cleanly).
 * Sources (packages/engine/src/executor.ts):
 *  - "Task marked done by agent" (executor.ts ~14939 — accepted explicit fn_task_done; also covers
 *    the PREMISE STALE skip-then-done flow, which reaches the same accepted-completion write)
 *  - "All steps complete — implicit fn_task_done" (executor.ts ~12095/~12402 — implicit-completion
 *    success when all steps are done without an explicit tool call)
 */
/*
 * FNXC:Lifecycle 2026-07-16-12:10:
 * Exported so the FN-8141 follow-up overseer no-op-finalize veto
 * (`deriveExecutorSignalMemory` in packages/engine/src/overseer-noop-finalize-veto.ts)
 * consumes the SAME accepted-completion marker set instead of duplicating the
 * strings. The executor-stage overseer timeline emits no "completed green"
 * observation (only progressing/failed/stuck/blocked), so these durable task-log
 * markers are the only evidence that can supersede a failure park. Importing the
 * shared list means any change here (e.g. removing the stranded-completion
 * promotion-output marker) is picked up by the veto automatically — no drift.
 */
export const CLEAN_COMPLETION_MARKERS = [
  "Task marked done by agent",
  "All steps complete — implicit fn_task_done",
];

function matchesAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

/**
 * Evaluate whether a stranded-completed promotion candidate should be withheld because its current
 * execution lifecycle ended in a failure/refusal park. Pure and unit-testable; both self-healing
 * sweeps share it. Requires the full task `log` (slim listings strip it, so promoters must fetch the
 * full task for candidates before calling this).
 */
export function evaluateCompletedPromotionFailureProvenance(
  task: Pick<Task, "log">,
): CompletedPromotionFailureProvenanceEvaluation {
  const log = task.log ?? [];
  // Walk from the tail so the most recent execution-outcome marker decides. Cap the scan window.
  const scanFloor = Math.max(0, log.length - MAX_LOG_SCAN);
  for (let i = log.length - 1; i >= scanFloor; i--) {
    const action = log[i]?.action ?? "";
    if (matchesAny(action, FAILURE_PARK_MARKERS)) {
      return { blocked: true, reason: "failure-provenance", markerAction: action };
    }
    if (matchesAny(action, CLEAN_COMPLETION_MARKERS)) {
      return { blocked: false };
    }
  }
  return { blocked: false };
}

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
 * Log-action substrings that mark a fresh clean execution outcome. A clean completion appearing
 * MORE RECENTLY than a failure park proves the failing lifecycle was superseded by a good one.
 * Sources (packages/engine/src/executor.ts):
 *  - "Task marked done by agent" (explicit fn_task_done success)
 *  - "All steps complete — implicit fn_task_done" (implicit-completion success)
 *  - "Auto-recovered: task work was complete but stranded" (stranded-completion recovery)
 */
const CLEAN_COMPLETION_MARKERS = [
  "Task marked done by agent",
  "All steps complete — implicit fn_task_done",
  "Auto-recovered: task work was complete but stranded",
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

import type { Task } from "@fusion/core";
import { enrichRunningAgentTaskShapeFromFlags, isRunningAgentTask } from "../../../core/src/agents/live-agent-count";
import { isCompleteColumnRole } from "./columnRoles";

/** The shared status vocabulary for active task phases and lock/model policy. */
export const ACTIVE_STATUSES = new Set([
  "planning",
  "researching",
  "executing",
  "finalizing",
  "merging",
  "merging-pr",
  "merging-fix",
  "reviewing",
  "landing",
]);

export interface TaskAgentActivityOptions {
  globalPaused?: boolean;
  queued?: boolean;
  // FNXC:StuckTagRemoval 2026-08-17-22:30: the isStuck gate was deleted with the dashboard's stuck-task tagging; the engine-written "stuck-killed" status below still suppresses the pulse.
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  The task's own column traits, when the caller has them. This predicate drives the
  pulsing status badge, the agent-active row border, and the column header's executing
  count, so a card in a renamed lane must resolve its roles from traits rather than ids.

  Optional, and the legacy ids remain the fallback: callers without resolved metadata
  (pre-load, or a card stranded in a vanished lane) must keep their current behaviour
  rather than lose activity detection entirely.
  */
  /*
  FNXC:TaskActivity 2026-08-01-17:53:
  Widened with the review/merge roles because the positive arm now delegates to the shared
  live-agent predicate, which resolves merge statuses through mergeOrchestration/mergeBlocker.
  */
  columnFlags?: { intake?: boolean; hold?: boolean; complete?: boolean; countsTowardWip?: boolean; mergeOrchestration?: boolean; mergeBlocker?: boolean };
}

/*
FNXC:TaskActivity 2026-07-16-00:00:
FN-8055 makes the agent-active border and pulsing badges represent the same ground truth: an agent is working now. Reject render-context global pause, queue, and derived freshness-stuck gates before checking activity.

FNXC:TaskActivity 2026-08-01-17:53:
Operator requirement: activity chrome and lane counts must NEVER show more work than the engine's
actual live-agent population. Summing lane headers used to exceed the concurrency cap (e.g. 10 glowing
cards under a 9-slot limit) because this predicate unioned extra render-only signals — the FN-8494
`needs-replan` REVISING chrome, the FN-8300 fresh planner-log window, ACTIVE_STATUSES in any column,
and running unified-progress items. Those extras glowed on cards that hold no concurrency slot, which
operators read as a capacity breach.
The positive arm is now exactly the shared `isRunningAgentTask` predicate used by footer Running and
project admission, so card glow (and the header counts derived from it) is a strict subset of the
slot-holding population. The suppression gates above it only ever subtract (queued/stuck/paused/failed
cards can still hold a slot briefly but must not glow), preserving the "never more" direction.

Stuck-killed and Complete columns are never active, even when stale execution status or workflow-step data remains on the task.

Model-resolution and routing locks intentionally import only ACTIVE_STATUSES and retain their status-or-in-progress policy; using this rendering predicate there would change lock behavior during status-null workflow steps.
*/
export function isTaskAgentActive(
  task: Pick<Task, "column" | "status" | "paused" | "userPaused" | "steps" | "enabledWorkflowSteps" | "workflowStepResults" | "recentAgentActivityAt" | "sessionFile" | "checkedOutBy">,
  options: TaskAgentActivityOptions = {},
): boolean {
  const status = task.status;

  if (
    options.globalPaused === true ||
    options.queued === true ||
    status === "queued" ||
    status === "stuck-killed" ||
    task.paused === true ||
    task.userPaused === true ||
    status === "paused" ||
    status === "failed" ||
    status === "awaiting-approval" ||
    status === "awaiting-user-input" ||
    isCompleteColumnRole(options.columnFlags, task.column) ||
    status === "done"
  ) {
    return false;
  }

  return isRunningAgentTask(enrichRunningAgentTaskShapeFromFlags(task, options.columnFlags));
}

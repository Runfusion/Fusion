import type { Task } from "@fusion/core";
import { getUnifiedTaskProgress } from "./taskProgress";

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

export const RECENT_PLANNER_ACTIVITY_WINDOW_MS = 60_000;

import { isLegacyIntakeColumn } from "./legacyLifecycleColumns.js";

export interface TaskAgentActivityOptions {
  globalPaused?: boolean;
  queued?: boolean;
  isStuck?: boolean;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  The task's own column traits, when the caller has them. Fresh-planner-activity was
  keyed on `column === "triage"`, so under U11 — merged planning column keeps the id
  `todo`, `triage` deleted — a planning card with live planner logs stops reading as
  agent-active. That is not one badge: this predicate drives the pulsing status badge,
  the agent-active row border, and the column header's executing count, so the whole
  board would quietly report planning work as idle.

  Optional, and the legacy ids remain the fallback: callers without resolved metadata
  (pre-load, or a card stranded in a vanished lane) must keep their current behaviour
  rather than lose activity detection entirely.
  */
  columnFlags?: { intake?: boolean; hold?: boolean };
}

/*
FNXC:TaskActivity 2026-07-16-00:00:
FN-8055 makes the agent-active border and pulsing badges represent the same ground truth: an agent is working now. Reject render-context global pause, queue, and derived freshness-stuck gates before checking activity, then combine the engine's column-aware active window with canonical phase statuses and the running unified workflow item that drives progress badges.

FNXC:TaskActivity 2026-07-28-12:00:
FN-8300 also honors a bounded, client-only fresh planner-log timestamp for triage cards. The log stream can arrive before the authoritative planning-status row; this render-only fallback closes that window without changing routing/model locks.

FNXC:TaskActivity 2026-07-22-09:25:
FN-8494 requires cards parked in the engine's durable `needs-replan` planning stage to keep their activity chrome on both triage and plan-in-place todo lanes. This is rendering-only: do not add `needs-replan` to ACTIVE_STATUSES, because model and routing pickers use that set as a long-lived lock policy while this predicate only describes live operator chrome. Extend the bounded fresh-log window to the todo replan lane so an incoming planner log remains represented consistently there.

Stuck-killed and both terminal columns are never active, even when stale execution status or workflow-step data remains on the task.

Model-resolution and routing locks intentionally import only ACTIVE_STATUSES and retain their status-or-in-progress policy; using this rendering predicate there would change lock behavior during status-null workflow steps.
*/
export function isTaskAgentActive(
  task: Pick<Task, "column" | "status" | "paused" | "userPaused" | "steps" | "enabledWorkflowSteps" | "workflowStepResults" | "recentAgentActivityAt">,
  options: TaskAgentActivityOptions = {},
): boolean {
  const status = task.status;

  if (
    options.globalPaused === true ||
    options.queued === true ||
    options.isStuck === true ||
    status === "queued" ||
    status === "stuck-killed" ||
    task.paused === true ||
    task.userPaused === true ||
    status === "paused" ||
    status === "failed" ||
    status === "awaiting-approval" ||
    status === "awaiting-user-input" ||
    task.column === "done" ||
    task.column === "archived" ||
    status === "done"
  ) {
    return false;
  }

  const isReplanning = status === "needs-replan";
  const recentPlannerActivityAtMs = Date.parse(task.recentAgentActivityAt ?? "");
  const nowMs = Date.now();
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  Planner activity belongs to the PRE-IMPLEMENTATION lane. With traits the rule is
  "intake lane, or a hold lane that is replanning"; without them it falls back to the
  ids, which is the same shape the two lanes have today.
  */
  const inPlannerLane = options.columnFlags
    ? options.columnFlags.intake === true || (options.columnFlags.hold === true && isReplanning)
    : isLegacyIntakeColumn(task.column) || (task.column === "todo" && isReplanning);
  const hasFreshPlannerActivity = inPlannerLane
    && Number.isFinite(recentPlannerActivityAtMs)
    && nowMs - recentPlannerActivityAtMs >= 0
    && nowMs - recentPlannerActivityAtMs <= RECENT_PLANNER_ACTIVITY_WINDOW_MS;

  return task.column === "in-progress" ||
    ACTIVE_STATUSES.has(status ?? "") ||
    isReplanning ||
    hasFreshPlannerActivity ||
    getUnifiedTaskProgress(task).items.some((item) => item.status === "running");
}

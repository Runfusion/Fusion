/*
FNXC:MergeQueue 2026-07-15-10:45:
AI merge sets task.status to reviewing/landing for most of the live merge window. Board/list badges must never show those raw engine strings; map the full active-merge pipeline to operator-facing Merging… (and Merging fixes… for merging-fix).
*/
import type { TFunction } from "i18next";
import type { Task } from "@fusion/core";
import { isActiveMergeStatus } from "../../../core/src/merge/active-merge-status";

/*
FNXC:TaskStatusBadge 2026-07-22-00:00:
FN-8475 restores truthful status visibility: Coding (Ideas) deliberately plans in Todo,
so a real non-queued task status must not be hidden based only on its board column.
Queued remains an intake-only presentation exclusion at TaskCard and ListView call sites.
*/
export function hasTaskStatusBadge(status: string | null | undefined): boolean {
  return typeof status === "string" && status.trim().length > 0;
}

export interface TaskWipLifecycleBadgeContext {
  /** True when the task's resolved workflow column occupies an implementation/WIP slot. */
  isWipColumn: boolean;
  /** The resolved workflow column name, when board metadata has loaded. */
  lifecycleLabel?: string | null;
}

/*
FNXC:TaskStatusBadge 2026-08-08-03:02:
A WIP lifecycle role supplies a badge only when the persisted status is empty: engine status,
pause, workflow-gate, and other call-site precedence remains authoritative. Resolve WIP from
workflow traits before calling this helper so renamed/custom implementation lanes receive their
own lifecycle label; metadata gaps retain the safe legacy "In progress" fallback without writing
that presentation state back to task.status.
*/
export function getTaskWipLifecycleBadgeLabel(
  status: string | null | undefined,
  t: TFunction<"app">,
  { isWipColumn, lifecycleLabel }: TaskWipLifecycleBadgeContext,
): string | null {
  if (!isWipColumn || hasTaskStatusBadge(status)) return null;
  return lifecycleLabel?.trim() || t("tasks.statusInProgress", "In progress");
}

/*
FNXC:TaskStatusConsistency 2026-08-05-03:49:
A planner agent-log event can reach the shared board snapshot before the status update that changes
`needs-replan` to `planning`. Its `recentAgentActivityAt` is written only after the log proves it is
newer than the row, so this is explicit live-planner evidence rather than arrival-order guessing.
Use it only for the parked-revision token while the event is inside the five-minute live window and
the engine is not globally paused: undefined status remains unknown and an idle needs-replan card
remains Queued to revise. TaskCard, both ListView paths, and task detail share this predicate so a
modal that has already fetched planning cannot contradict the board during that short SSE gap.

FNXC:TaskStatusConsistency 2026-08-05-04:54:
A parseable historical log is not liveness. The transient `needs-replan` override expires after the
shared five-minute heartbeat window and is suppressed during global pause, returning the operator to
Queued to revise instead of leaving every affected surface stuck on Planning.
*/
export const PLANNER_ACTIVITY_LIVE_WINDOW_MS = 5 * 60_000;

export interface TaskPlanningActivityOptions {
  globalPaused?: boolean;
  now?: number;
}

export function isTaskPlanningActive(
  task: Pick<Task, "status" | "recentAgentActivityAt">,
  { globalPaused = false, now = Date.now() }: TaskPlanningActivityOptions = {},
): boolean {
  if (task.status === "planning") return true;
  if (globalPaused || task.status !== "needs-replan" || typeof task.recentAgentActivityAt !== "string") return false;

  const activityAt = Date.parse(task.recentAgentActivityAt);
  return Number.isFinite(activityAt)
    && activityAt <= now
    && now - activityAt <= PLANNER_ACTIVITY_LIVE_WINDOW_MS;
}

/*
FNXC:TaskStatusBadge 2026-08-01-01:30 (operator: "make the badges more descriptive"):
Three waiting states read as ACTIVITY on the board and made healthy queueing look broken:
"Revising" while merely queued for a replan slot, and bare "queued" while parked behind another
task's file-scope lease (the reason lived only in a log line). The badge now names the wait:
"Queued to revise" (idle needs-replan) and "Queued behind FN-XXXX" (overlap lease). Liveness and
the overlap id are caller-supplied so this stays a pure mapper; omitted → legacy labels, so every
existing caller keeps its behavior.
*/
export interface TaskStatusBadgeContext {
  /** True when no agent session is live for the card (queued, not running). */
  idle?: boolean;
  /** The task currently holding the overlapping file-scope lease, when queued behind one. */
  overlapBlockedBy?: string | null;
}

export function getTaskStatusBadgeLabel(
  status: string | null | undefined,
  t: TFunction<"app">,
  /*
  FNXC:TaskStatusBadge 2026-07-19-02:55 (U12 / R2 / R11):
  Workflow-step state wins over the raw status vocabulary. A card whose Plan Review is running
  reads "Plan Review" — the step's own IR-declared name — instead of the engine token "planning"
  or "needs-replan". Pass `getRunningWorkflowStepLabel(task)` here; omit it and the legacy status
  mapping below is unchanged, so every existing caller keeps its behavior.
  */
  workflowStepLabel?: string,
  context?: TaskStatusBadgeContext,
): string {
  /*
  FNXC:TaskStatusBadge 2026-07-19-09:40:
  Every active-merge status ("merging", "merging-pr", "merging-fix", "reviewing", "landing") must
  win over a still-running workflow-step label (a pre-merge step's startedAt-without-completedAt
  state can survive into the merge pipeline). Checking the status before the workflow-step override
  enforces this for every caller (TaskCard, ListView grouped rows, ListView table rows) instead of
  relying on per-call-site pre-checks. "merging-fix" keeps its distinct "Merging fixes…" label.
  */
  if (isActiveMergeStatus(status)) {
    return status === "merging-fix"
      ? t("tasks.statusMergingFix", "Merging fixes…")
      : t("tasks.statusMerging", "Merging…");
  }
  if (workflowStepLabel) return workflowStepLabel;
  if (!status) return "";
  /*
  FNXC:TaskStatusBadge 2026-07-22-09:22:
  FN-8493 requires operator copy "Revising" while a revise/replan cycle is in progress. Keep the
  engine token "needs-replan" unchanged and map centrally so board cards and list rows agree.
  */
  if (status === "needs-replan") {
    // Idle = waiting for a planning slot; the live revise cycle shows as "Revising"/step label.
    return context?.idle
      ? t("tasks.statusReplanQueued", "Queued to revise")
      : t("tasks.statusReplan", "Revising");
  }
  if (status === "queued" && context?.overlapBlockedBy) {
    return t("tasks.statusQueuedBehind", "Queued behind {{taskId}}", { taskId: context.overlapBlockedBy });
  }
  /*
  FNXC:TaskStatusBadge 2026-08-01-03:20 (operator: one queued family, like the planning badge):
  Raw "queued" (scheduler capacity/dependency marker) previously fell through to the verbatim
  lowercase engine token. Map it so every queued state reads as the same badge family.
  */
  if (status === "queued") {
    return t("tasks.statusQueued", "Queued");
  }
  /*
  FNXC:TaskStatusBadge 2026-07-26-14:05:
  "planning" is an engine token, not operator copy, and it was only ever hidden because U12's
  workflow-step override happened to cover the same cards. Now that the Plan Review gate has its own
  badge, callers suppress the step-name override while that badge renders — which uncovered the raw
  lowercase token underneath. Map it to the same "Planning" copy the transient-planner badge already
  uses so the two paths cannot read differently.
  */
  if (status === "planning") {
    return t("tasks.statusPlanning", "Planning");
  }
  return status;
}

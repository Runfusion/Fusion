/*
FNXC:MergeQueue 2026-07-15-10:45:
AI merge sets task.status to reviewing/landing for most of the live merge window. Board/list badges must never show those raw engine strings; map the full active-merge pipeline to operator-facing Merging… (and Merging fixes… for merging-fix).
*/
import type { TFunction } from "i18next";
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

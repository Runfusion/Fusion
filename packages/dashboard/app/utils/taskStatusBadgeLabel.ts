/*
FNXC:MergeQueue 2026-07-15-10:45:
AI merge sets task.status to reviewing/landing for most of the live merge window. Board/list badges must never show those raw engine strings; map the full active-merge pipeline to operator-facing Merging… (and Merging fixes… for merging-fix).
*/
import type { TFunction } from "i18next";
import { isActiveMergeStatus } from "../../../core/src/active-merge-status";

/*
FNXC:TaskStatusBadge 2026-08-19-00:00:
FN-8475 restores truthful status visibility: Coding (Ideas) deliberately plans in Todo,
so a real non-queued task status must not be hidden based only on its board column.
Queued remains an intake-only presentation exclusion at TaskCard and ListView call sites.
*/
export function hasTaskStatusBadge(status: string | null | undefined): boolean {
  return typeof status === "string" && status.trim().length > 0;
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
  FNXC:TaskStatusBadge 2026-07-28-00:00:
  FN-8195 requires the raw engine status "needs-replan" to appear as "Replan" on board cards
  and list rows. Keep the task.status token unchanged and map centrally so both consumers agree.
  */
  if (status === "needs-replan") {
    return t("tasks.statusReplan", "Replan");
  }
  return status;
}

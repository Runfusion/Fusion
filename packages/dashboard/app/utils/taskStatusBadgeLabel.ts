/*
FNXC:MergeQueue 2026-07-15-10:45:
AI merge sets task.status to reviewing/landing for most of the live merge window. Board/list badges must never show those raw engine strings; map the full active-merge pipeline to operator-facing Merging… (and Merging fixes… for merging-fix).
*/
import type { TFunction } from "i18next";
import { isActiveMergeStatus } from "../../../core/src/active-merge-status";

/*
FNXC:TaskStatusBadge 2026-07-16-12:00:
FN-8170 requires the raw "planning" status badge to stay off Todo and In Progress cards while preserving it in triage. Suppression is unconditional because Coding (Ideas) in-place planning writes only status:"planning", with no durable client-visible active-planner signal; the additive Reviewing Plan Review badge remains independent.
*/
export function shouldSuppressPlanningStatusBadge({
  status,
  column,
}: {
  status?: string | null;
  column: string;
}): boolean {
  return status === "planning" && (column === "todo" || column === "in-progress");
}

export function getTaskStatusBadgeLabel(
  status: string | null | undefined,
  t: TFunction<"app">,
): string {
  if (!status) return "";
  if (status === "merging-fix") {
    return t("tasks.statusMergingFix", "Merging fixes…");
  }
  if (isActiveMergeStatus(status)) {
    return t("tasks.statusMerging", "Merging…");
  }
  return status;
}

import type { TFunction } from "i18next";
import type { TaskContextMenuColumnFlags } from "../components/TaskContextMenu";

export type RetryStage = "plan" | "implementation" | "review" | "generic";

export interface RetryStageCopy {
  stage: RetryStage;
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel: string;
  successMessage: string;
}

/**
 * FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
 * Retry repeats the current stage without moving the card. This mirrors the durable restart
 * planner's review-over-WIP-over-planning trait order so each host explains the same destructive
 * boundary before an operator confirms it. Missing column metadata deliberately uses generic copy
 * during first paint instead of guessing a stage from an unresolved column id.
 */
export function resolveRetryStageCopy(
  t: TFunction<"app">,
  flags: TaskContextMenuColumnFlags | undefined,
  _column: string,
): RetryStageCopy {
  const common = {
    confirmTitle: t("taskDetail.retry.confirmTitle", "Retry this stage?"),
    confirmLabel: t("taskDetail.retry.confirmLabel", "Retry"),
  };
  if (flags?.mergeBlocker || flags?.humanReview) {
    return {
      stage: "review",
      ...common,
      confirmMessage: t("taskDetail.retry.reviewConfirmMessage", "Discard the review verdicts and review the produced work again. This card stays in its current column."),
      successMessage: t("taskDetail.retry.reviewSuccess", "Review will run again in this column."),
    };
  }
  if (flags?.countsTowardWip) {
    return {
      stage: "implementation",
      ...common,
      confirmMessage: t("taskDetail.retry.implementationConfirmMessage", "Discard the in-flight work and start it again on the approved plan. This card stays in its current column."),
      successMessage: t("taskDetail.retry.implementationSuccess", "Work will restart in this column."),
    };
  }
  if (flags?.intake || flags?.hold) {
    return {
      stage: "plan",
      ...common,
      confirmMessage: t("taskDetail.retry.planConfirmMessage", "Rebuild the plan from the original request. This card stays in its current column."),
      successMessage: t("taskDetail.retry.planSuccess", "Planning will restart in this column."),
    };
  }
  return {
    stage: "generic",
    ...common,
    confirmMessage: t("taskDetail.retry.genericConfirmMessage", "Repeat the current stage and keep this card in its current column."),
    successMessage: t("taskDetail.retry.genericSuccess", "This stage will restart in its current column."),
  };
}

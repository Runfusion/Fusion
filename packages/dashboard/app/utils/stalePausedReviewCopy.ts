import type { StalePausedReviewCode, StalePausedReviewSignal, Task } from "@fusion/core";
import { isReviewColumnRole } from "./columnRoles";

export interface StalePausedReviewCopy {
  badgeLabel: string;
  headline: string;
  description: string;
  suggestedAction: string;
  code: StalePausedReviewCode;
}

const BADGE_LABEL = "Paused stall";

export function getStalePausedReviewCopy(signal: StalePausedReviewSignal): StalePausedReviewCopy {
  return {
    badgeLabel: BADGE_LABEL,
    code: signal.code,
    headline: "Paused in review beyond threshold",
    description: "This task has remained paused in in-review beyond the configured stale paused review threshold.",
    suggestedAction: "Disposition options: unpause, retry, archive, or create follow-up task.",
  };
}

export function shouldShowStalePausedReviewBadge(
  task: Pick<Task, "column" | "paused" | "stalePausedReview">,
  columnFlags?: Parameters<typeof isReviewColumnRole>[0],
): boolean {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-13:10 (batch-dashboard-app):
  Same gate as its sibling in inReviewStallCopy.ts, same failure: on a renamed board the
  stale-paused-review badge was computed and then discarded here, so a review paused for days
  looked healthy. `columnFlags` omitted -> the legacy id.
  */
  return isReviewColumnRole(columnFlags, task.column) && task.paused === true && task.stalePausedReview != null;
}

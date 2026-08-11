/**
 * FNXC:CodeOrganization 2026-08-03-13:35:
 * Review checkout routing log helper peeled from TaskExecutor (U4).
 */
import { getTaskReviewCheckoutPath } from "../execution/review-checkout.js";
import { reviewerLog } from "../logger.js";

/*
FNXC:ReviewRouting 2026-07-01-16:36:
Review routing must expose whether the reviewer is using an explicit external checkout or the task worktree, but the invalid-sourceMetadata warning is only valid when sourceMetadata supplied the selected candidate. Higher-priority metadata can fail closed before sourceMetadata is considered, so centralize the logging to keep both review seams consistent and avoid false invalid-path warnings.
*/
export function logReviewCheckoutRouting(taskId: string, task: unknown, reviewCwd: string, worktreePath: string): void {
  if (reviewCwd !== worktreePath) {
    reviewerLog.log(`${taskId}: review routed to external checkout ${reviewCwd} (task worktree: ${worktreePath})`);
    return;
  }

  const selectedCandidate = getTaskReviewCheckoutPath(task);
  const sourceMetadata = task && typeof task === "object" ? (task as Record<string, unknown>).sourceMetadata : undefined;
  const sourceRecord = sourceMetadata && typeof sourceMetadata === "object" ? sourceMetadata as Record<string, unknown> : undefined;
  const sourceExternalReviewCheckout = sourceRecord?.externalReviewCheckout;
  const sourceExternalReviewCheckoutPath = typeof sourceExternalReviewCheckout === "string" ? sourceExternalReviewCheckout.trim() : undefined;
  if (sourceExternalReviewCheckoutPath && selectedCandidate === sourceExternalReviewCheckoutPath) {
    reviewerLog.warn(`${taskId}: external review checkout metadata present (${sourceExternalReviewCheckoutPath}) but invalid — reviewing task worktree ${worktreePath}`);
  }
}

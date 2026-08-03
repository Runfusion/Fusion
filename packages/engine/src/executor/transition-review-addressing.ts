/**
 * FNXC:CodeOrganization 2026-08-03-11:45:
 * transitionReviewAddressing peeled from TaskExecutor (U4).
 *
 * FNXC:ReviewAddressing 2026-07-30-16:40 DELIBERATE-LITERAL:
 * `to` is a review-addressing RECORD STATUS (`queued` | `in-progress` | `addressed` | `failed`),
 * NOT a board column — resolving it to a workflow role would be nonsense.
 */
import type { TaskStore } from "@fusion/core";

export type ReviewAddressingStatus = "queued" | "in-progress" | "addressed" | "failed";

export async function transitionReviewAddressing(
  store: TaskStore,
  taskId: string,
  from: ReviewAddressingStatus[],
  to: ReviewAddressingStatus,
): Promise<void> {
  const task = await store.getTask(taskId);
  const reviewState = task.reviewState;
  if (!reviewState || reviewState.addressing.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  let changed = false;
  const addressing = reviewState.addressing.map((record) => {
    if (!from.includes(record.status)) {
      return record;
    }
    changed = true;
    /*
    FNXC:ReviewAddressing 2026-07-30-16:40 DELIBERATE-LITERAL:
    `to` is a review-addressing RECORD STATUS (`queued` | `in-progress` | `addressed` | `failed`),
    NOT a board column — the next lines test against `"addressed"` and `"failed"`, which are not
    columns at all. The lifecycle-column census matches the bare string; resolving it to a
    workflow role would be nonsense.
    */
    return {
      ...record,
      status: to,
      startedAt: to === "in-progress" ? now : record.startedAt,
      completedAt: to === "addressed" || to === "failed" ? now : record.completedAt,
      error: to === "addressed" ? undefined : record.error,
    };
  });

  if (!changed) {
    return;
  }

  await store.updateTask(taskId, {
    reviewState: {
      ...reviewState,
      addressing,
    },
  });
}

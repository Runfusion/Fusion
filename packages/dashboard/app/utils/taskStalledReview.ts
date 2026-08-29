import type { Task, StalledReviewSignal } from "@fusion/core";

export function getStalledReviewSignal(task: Task): StalledReviewSignal | undefined {
  return task.stalledReview;
}

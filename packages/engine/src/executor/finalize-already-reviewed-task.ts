/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * finalizeAlreadyReviewedTask peeled from TaskExecutor (U4).
 *
 * When a completed task is already in the review lane, finalize merge if no merge
 * blocker remains; otherwise log deferral. Uses resolved resume lanes (not literals).
 */
import type { TaskStore } from "@fusion/core";
import { getTaskMergeBlocker } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";

export type FinalizeAlreadyReviewedTaskDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveResumeLanes: (taskId: string, memo?: { lanes?: ResumeLanes }) => Promise<ResumeLanes>;
};

export async function finalizeAlreadyReviewedTask(
  deps: FinalizeAlreadyReviewedTaskDeps,
  taskId: string,
): Promise<"merged" | "blocked" | "missing"> {
  const latestTask = await deps.store.getTask(taskId);
  /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the board's own review lane. Spelled as the
     literal, this reported "missing" — a word that reads as "the task is gone" — for a card sitting in
     review on a renamed board, and the already-reviewed finalize never ran. */
  if (!latestTask || latestTask.column !== (await deps.resolveResumeLanes(taskId)).review) {
    return "missing";
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-14:40 (outer question resolved, inner one not):
  The guard directly above compares against `(await deps.resolveResumeLanes(taskId)).review`, then this
  call re-asked with the literal — so a card that just PASSED the resolved lane check was refused by the
  unresolved blocker on any renamed board.
  */
  const resumeReviewLane = (await deps.resolveResumeLanes(taskId)).review;
  const blocker = getTaskMergeBlocker(latestTask, {
    reviewColumns: new Set([resumeReviewLane ?? "in-review"]),
  });
  if (blocker) {
    await deps.store.logEntry(taskId, "Task already in-review; merge deferred", blocker, deps.getRunContextFor(taskId));
    return "blocked";
  }

  await deps.store.logEntry(
    taskId,
    "Task already in-review after completion — finalizing merge",
    undefined,
    deps.getRunContextFor(taskId),
  );
  await deps.store.mergeTask(taskId);
  return "merged";
}

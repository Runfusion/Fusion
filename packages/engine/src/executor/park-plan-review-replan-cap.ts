/**
 * FNXC:CodeOrganization 2026-08-03-09:50:
 * parkPlanReviewReplanCapExhausted peeled from TaskExecutor (U4).
 *
 * FNXC:PlanReviewReplanCap 2026-07-19-00:10:
 * U3 — the graph is the sole Plan Review owner (triage's out-of-graph gate and
 * its blockAfterPlanReviewRevise cap-park are deleted). Re-own the replan-cap
 * escalation here: when the plan-review replan budget (node `maxRevisions` /
 * `planReviewReplanCap` setting, or the unbounded-default hard cap) is exhausted,
 * park the task at `awaiting-approval` with reason `plan-review-replan-cap` so a
 * persistent planner/reviewer disagreement surfaces to a human instead of looping
 * forever or silently sitting in place. The reason string is special-cased by the
 * dashboard + notifications, so it must be preserved verbatim.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type ParkPlanReviewReplanCapDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export async function parkPlanReviewReplanCapExhausted(
  deps: ParkPlanReviewReplanCapDeps,
  taskId: string,
  capLabel: string,
  currentCount: number,
  feedback: string,
): Promise<void> {
  await deps.store.logEntry(
    taskId,
    "Plan Review replan cap reached — escalating to manual approval",
    `The Plan Review gate requested a planning revision ${currentCount} times without converging (cap ${capLabel}). To avoid an endless plan → Plan Review REVISE → replan loop, the task is routed to awaiting-approval for a human decision instead of replanning again. Latest Plan Review feedback:\n${feedback}`,
    deps.getRunContextFor(taskId),
  );
  // awaitingApprovalReason is written through a Record<string, unknown> (matching
  // the manual plan-approval hold + the deleted triage cap-park) so the distinct
  // reason survives the update path.
  const escalationUpdates: Record<string, unknown> = {
    status: "awaiting-approval",
    awaitingApprovalReason: "plan-review-replan-cap",
    error: null,
    recoveryRetryCount: null,
    nextRecoveryAt: null,
  };
  await deps.store.updateTask(taskId, escalationUpdates as Partial<Task>, deps.getRunContextFor(taskId));
  executorLog.warn(
    `${taskId}: Plan Review replan cap (${capLabel}) reached after ${currentCount} attempts — escalating to awaiting-approval`,
  );
}

/**
 * FNXC:CodeOrganization 2026-08-03-15:40:
 * handoffTaskToReview peeled from TaskExecutor (U4).
 *
 * Stable completion handoff into review: optional feature-video, workflow
 * completion summary, handoffToReview store transition, and merge-request
 * contract shadow markers. Failed execution must not use this path.
 *
 * Stable handoff reasons on task:handoff audit events (keep greppable for
 * executor/self-healing forensics): review-handoff-requested, completed-task-recovered,
 * step-session-completed, paused-after-completion, fn_task_done, fn_task_done-retry-completed.
 *
 * FNXC:WorkflowLifecycle 2026-06-29-11:20:
 * Failed execution is not a review handoff. Error paths must either requeue
 * executable work for resume or fail in-place; `in-review` is reserved for
 * clean completion handoffs.
 */
import type { Task, TaskDetail, TaskStore } from "@fusion/core";
import { isMergeRequestContractShadowEnabled } from "@fusion/core";
import { ensureWorkflowCompletionSummary } from "../workflows/workflow-completion-summary.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method surface
type AnyFn = (...args: any[]) => any;

export type HandoffTaskToReviewDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  generateCompletionFeatureVideo: AnyFn;
};

export async function handoffTaskToReview(
  deps: HandoffTaskToReviewDeps,
  task: Task,
  reason: string,
  runId = deps.getRunContextFor(task.id)?.runId,
): Promise<Task> {
  const agentId = deps.getRunContextFor(task.id)?.agentId;
  await deps.generateCompletionFeatureVideo(task);
  if (reason.startsWith("workflow-")) {
    await ensureWorkflowCompletionSummary(deps.store, task as TaskDetail, {
      reason,
      runId,
    }).catch((error: unknown) => {
      executorLog.warn(`${task.id}: failed to record workflow completion summary: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  const handedOff = await deps.store.handoffToReview(task.id, {
    ownerAgentId: agentId ?? null,
    evidence: {
      reason,
      runId,
      agentId,
    },
  });

  const settings = await deps.store.getSettings();
  if (isMergeRequestContractShadowEnabled(settings)) {
    deps.store.setCompletionHandoffAcceptedMarker(task.id, {
      source: `executor:${reason}`,
    });
    await deps.store.upsertMergeRequestRecord(task.id, {
      state: handedOff.autoMerge === false ? "manual-required" : "queued",
    });
  }

  return handedOff;
}

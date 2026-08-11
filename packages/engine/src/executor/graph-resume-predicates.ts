/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * Pure graph resume / pause-abort classifiers peeled from TaskExecutor (U4).
 */
import type { Task, TaskDetail } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import {
  graphFailureValue,
  isMergeGraphFailure,
} from "./graph-failure-pure.js";
import { isGenericAbortProvenance, type PausedAbortProvenance } from "./paused-abort-provenance.js";
import { isTerminalMergeGraphFailureValue } from "./task-predicates.js";
import { hasNonTerminalWorkflowSteps } from "./workflow-step-satisfaction.js";

export function isTransientResumeAfterRestartGraphFailure(
  live: Task,
  result: WorkflowGraphTaskRunResult,
): boolean {
  if ((result.reason ?? "").trim().length > 0) return false;

  const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
  if (failedNode !== undefined && failedNode !== "execute") return false;

  /*
  FNXC:GraphRestartRecovery 2026-08-07-23:36:
  Completed earlier steps are resumable progress when a later step is still active. Only a fully terminal step list fences this bounded retry path.
  */
  if (live.steps.length > 0 && !hasNonTerminalWorkflowSteps(live)) return false;

  const failureState = live as Task & { lastError?: unknown; failureReason?: unknown };
  if (failureState.lastError != null || failureState.failureReason != null) return false;

  const latestAction = live.log.at(-1)?.action;
  return latestAction === "Resumed after engine restart"
    || latestAction === "Resuming execution after unpause";
}

/*
FNXC:WorkflowLifecycle 2026-06-20-00:00:
FNXC:WorkflowLifecycle 2026-07-26-11:20:
KB-PROV: post-split the engine case arrives as `engine-abort` and an operator withdrawal as `hard-cancel`; this classifier still accepts BOTH (`isGenericAbortProvenance`) because the `userCanceled` guard below — not the label — is the load-bearing operator-intent discriminator FN-6796 designed. Narrowing to `engine-abort` would change behaviour for the operator path.

FN-6796: an engine restart/pause-resume abort reaches graph-failure handling as `hard-cancel`/`engine-abort` provenance even when no user canceled the task. A clean completed `in-review` row in that shape is already handed off for review and must not be stranded with the operator-action pause-abort marker; the discriminator is the in-memory `userCanceledTaskIds` set plus the resting column and clean row state, while global/user pause, merge-seam, terminal merge values, merge-confirmed partial landings, and pre-existing status/error still park exactly as before.
*/
export function isBenignInReviewPauseAbort(
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
  pausedAborted: boolean,
  userCanceled: boolean,
  /** The caller's already-resolved review lane — see the note on the sync resolver. */
  reviewLane: string,
): boolean {
  if (!pausedAborted) return false;
  if (!isGenericAbortProvenance(abortProvenance)) return false;
  if (userCanceled) return false;
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (PR #2703 review — replaces my own earlier reasoning):
  This comparison used the SYNC `resolvePlannerLanes`, which I justified as the right resolver for a
  synchronous classifier. That justification was wrong in production: in PostgreSQL mode the sync
  selection reader always returns undefined, so the sync resolver hands back the DEFAULT workflow's lanes
  and the guard behaves exactly as the literal did. The lane now arrives from the caller's snapshot — see
  the note on this method.
  */
  if (live.column !== reviewLane) return false;
  if (live.userPaused === true) return false;
  if (live.status != null || live.error != null) return false;
  if (live.mergeDetails?.mergeConfirmed === true) return false;
  if (isTerminalMergeGraphFailureValue(graphFailureValue(result))) return false;
  const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
  if (isMergeGraphFailure(failedNode)) return false;
  if (live.steps.length === 0) return false;
  if (!live.steps.every((step) => step.status === "done" || step.status === "skipped")) return false;
  return true;
}

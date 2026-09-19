import type { Task, TaskStore, WorkflowStepResult, RunMutationContext } from "@fusion/core";
import { hasPreMergeRemediationAutoMergeHold } from "@fusion/core";
import { EMPTY_REVIEW_DIFF_FINGERPRINT } from "../worktree/review-diff-fingerprint.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";

export type EmptyReviewContentGateFence = {
  workflowStepId: string;
  stepName: string;
  expectedStartedAt?: string;
  expectedCompletedAt?: string;
  expectedVerdict?: WorkflowStepResult["verdict"];
  expectedReviewInputFingerprint: string;
};

export type ReviewEmptyContentCloseDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => RunMutationContext | undefined;
};

export function isDefiniteEmptyCodeReviewRevise(result: WorkflowStepResult | undefined): result is WorkflowStepResult {
  return result != null
    && (result.phase ?? "pre-merge") === "pre-merge"
    && result.status === "failed"
    && result.reviewKind === "code"
    && result.verdict === "REVISE"
    && result.reviewInputFingerprint === EMPTY_REVIEW_DIFF_FINGERPRINT
    && result.supersededAt == null
    && result.remediationArchivedAt == null
    && result.bypassedAt == null;
}

function findFencedGate(current: Task, fence: EmptyReviewContentGateFence): WorkflowStepResult | undefined {
  const result = current.workflowStepResults?.find((entry) => entry.workflowStepId === fence.workflowStepId);
  if (!isDefiniteEmptyCodeReviewRevise(result)) return undefined;
  if (result.startedAt !== fence.expectedStartedAt
    || result.completedAt !== fence.expectedCompletedAt
    || result.verdict !== fence.expectedVerdict
    || result.reviewInputFingerprint !== fence.expectedReviewInputFingerprint) return undefined;
  return result;
}

/*
FNXC:ReviewEmptyContent 2026-08-28-13:14:
The empty-content park is a compare-and-set on the exact failed Code Review attempt. A plain re-read
cannot protect a periodic sweep or live graph node from racing an approval, operator bypass,
supersession, remediation archive, pause, delete, hold, or a different terminal classifier. The
atomic store updater is authoritative; minimal stores retain only a best-effort compatibility path.
This helper does not move columns because it may run inside a graph node whose column boundary has a
cached lane. Graph teardown settles WIP to review after the run unwinds, while self-healing already
starts in review. A declined claim is safe because every caller continues its existing behavior.
*/
export async function terminalizeEmptyReviewContent(
  deps: ReviewEmptyContentCloseDeps,
  taskId: string,
  fence: EmptyReviewContentGateFence,
): Promise<boolean> {
  const settings = await deps.store.getSettings();
  const terminalColumns = await resolveTerminalColumnsFor(deps.store, taskId).catch(() => [] as string[]);
  let parked = false;
  let parkedColumn: string | undefined;
  const claim = (current: Task) => {
    if (current.deletedAt || current.paused || current.userPaused === true
      || settings.globalPause === true || settings.enginePaused === true
      || hasPreMergeRemediationAutoMergeHold(current, settings)
      || terminalColumns.includes(current.column)
      || current.status != null
      || !findFencedGate(current, fence)) return null;
    parked = true;
    parkedColumn = current.column;
    return {
      status: "failed" as const,
      error: `NO REVIEWABLE CONTENT: ${fence.stepName} rejected a provably empty diff; no remediation round can review content that does not exist.`,
      nextRecoveryAt: null,
      recoveryRetryCount: null,
    };
  };

  const atomic = (deps.store as TaskStore & { updateTaskAtomic?: TaskStore["updateTaskAtomic"] }).updateTaskAtomic;
  if (atomic) {
    await atomic.call(deps.store, taskId, claim, deps.getRunContextFor(taskId));
  } else {
    const current = await deps.store.getTask(taskId);
    const patch = claim(current);
    if (patch) await deps.store.updateTask(taskId, patch, deps.getRunContextFor(taskId));
  }
  if (!parked) return false;

  await deps.store.logEntry(
    taskId,
    `No reviewable content — terminal park recorded for ${fence.stepName}`,
    `Gate ${fence.workflowStepId} rejected a provably empty diff. No remediation round can help until new work exists.`,
    deps.getRunContextFor(taskId),
  );
  const context = deps.getRunContextFor(taskId);
  if (context) await emitBoundedRunAudit(deps.store, {
    taskId,
    agentId: context.agentId,
    runId: context.runId,
    domain: "database",
    mutationType: "task:review-empty-content-parked",
    target: taskId,
    metadata: {
      taskId,
      workflowStepId: fence.workflowStepId,
      column: parkedColumn,
      outcome: "failed",
    },
  });
  return true;
}

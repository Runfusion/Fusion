/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * routeImplementationIncompleteMergeGraphFailure peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowMerge 2026-07-14-18:20:
 * FN-1165: clear non-user pause parks for incomplete-merge failures; keep activeWorktrees
 * on resumable path; release only on fail-closed.
 */
import { resolveTaskMergeTarget, type Task, type TaskDetail, type TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import { hasNonTerminalWorkflowSteps } from "./workflow-step-satisfaction.js";
import { MERGE_BOUNDARY_RECOVERY_VALUE } from "../workflows/workflow-merge-nodes.js";
import type { MergeBoundaryRecoveryEvidence } from "./workflow-merge-boundary.js";
import { hasLandedEmptyStepApprovedCodeReview } from "./evaluate-workflow-merge-boundary.js";

export const IMPLEMENTATION_INCOMPLETE_NO_RESUME_MESSAGE = "implementation incomplete with no executable proof to resume — failing instead of retrying merge";

function hasApprovedCodeReview(task: Pick<Task, "workflowStepResults">): boolean {
  return (task.workflowStepResults ?? []).some((result) =>
    result.workflowStepId === "code-review"
    && result.status === "passed"
    && result.verdict === "APPROVE",
  );
}

function isCurrentLandedReviewRecovery(
  current: Task,
  snapshot: TaskDetail,
): boolean {
  const staleFailure = snapshot.status === "failed"
    && snapshot.error?.includes(IMPLEMENTATION_INCOMPLETE_NO_RESUME_MESSAGE) === true;
  return current.id === snapshot.id
    && current.column === snapshot.column
    && current.columnMovedAt === snapshot.columnMovedAt
    && current.status === snapshot.status
    && current.error === snapshot.error
    && current.paused === snapshot.paused
    && current.pausedReason === snapshot.pausedReason
    && current.userPaused === snapshot.userPaused
    && current.lineageId === snapshot.lineageId
    && current.baseBranch === snapshot.baseBranch
    && resolveTaskMergeTarget(current).branch === resolveTaskMergeTarget(snapshot).branch
    && current.branch === snapshot.branch
    && current.baseCommitSha === snapshot.baseCommitSha
    && Array.isArray(current.steps)
    && current.steps.length === 0
    && hasApprovedCodeReview(current)
    && current.userPaused !== true
    && (current.paused === true || staleFailure);
}

export type RouteImplementationIncompleteMergeGraphFailureDeps = {
  store: TaskStore;
  rootDir: string;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  clearPausedAborted: (taskId: string) => void;
  hasLiveTaskSessionSurface: (taskId: string) => boolean;
  activeWorktrees: Map<string, Set<string>>;
  routeGraphFailureToExecutionResume: (
    live: TaskDetail,
    failedNode: string,
    failureValue: string | undefined,
    resumeLanesMemo?: unknown,
    boundaryEvidence?: MergeBoundaryRecoveryEvidence,
  ) => Promise<boolean>;
  persistTokenUsage: (taskId: string) => Promise<void>;
};

export async function routeImplementationIncompleteMergeGraphFailure(
  deps: RouteImplementationIncompleteMergeGraphFailureDeps,
  live: TaskDetail,
  failedNode: string,
  failureValue: "implementation-incomplete" | typeof MERGE_BOUNDARY_RECOVERY_VALUE = "implementation-incomplete",
  boundaryEvidence?: MergeBoundaryRecoveryEvidence,
): Promise<boolean> {
  if (
    !deps.hasLiveTaskSessionSurface(live.id)
    && await hasLandedEmptyStepApprovedCodeReview(live, deps.rootDir)
  ) {
    let recovered = false;
    /*
    FNXC:LandedReviewRecovery 2026-09-29-03:33:
    Git evidence is asynchronous, so the recovery must validate the same lifecycle
    and merge-proof inputs under the task lock before clearing an engine-owned park.
    The resolved target includes inheritedBaseBranch, so matching baseBranch alone
    cannot prove an inherited-target change still has the same landed evidence.
    A final liveness probe immediately before cleanup lets a newly claimed session
    retain its pause state and active-worktree registration.
    */
    await deps.store.updateTaskAtomic(live.id, (current) => {
      if (!isCurrentLandedReviewRecovery(current, live)) return null;
      recovered = true;
      const staleFailure = current.status === "failed"
        && current.error?.includes(IMPLEMENTATION_INCOMPLETE_NO_RESUME_MESSAGE) === true;
      return {
        ...(current.paused === true ? { paused: false, pausedReason: null } : {}),
        ...(staleFailure ? { status: null, error: null } : {}),
      };
    }, deps.getRunContextFor(live.id));
    if (!recovered) return true;
    if (deps.hasLiveTaskSessionSurface(live.id)) return true;

    deps.clearPausedAborted(live.id);
    deps.activeWorktrees.delete(live.id);
    await deps.store.logEntry(
      live.id,
      "Workflow graph merge preserved landed empty-step task for outstanding human review evidence",
      undefined,
      deps.getRunContextFor(live.id),
    );
    await deps.persistTokenUsage(live.id);
    return true;
  }
    /*
    FNXC:WorkflowMerge 2026-07-14-18:20:
    FN-1165 greptile P1s: (1) system-paused implementation-incomplete merge failures must still classify —
    clear only non-user pause parks so incomplete steps can requeue; real global/user pauses never enter this method.
    (2) Do not drop activeWorktrees until we know the outcome is terminal fail-closed. Resumable requeue preserves
    progress (and often the persisted worktree); releasing tracking early leaves that worktree uncounted while a later
    dispatch can allocate a second one. Keep the active registration on the resumable path; release only on fail-closed.
    */
    deps.clearPausedAborted(live.id);
    let resumeLive = live;
    if (live.paused === true && live.userPaused !== true) {
      // FNXC:WorkflowMerge 2026-07-14-18:35: TaskDetail.pausedReason is string|undefined (not null). Persist clear via updateTask (store accepts null); in-memory resume snapshot uses undefined to satisfy the type.
      await deps.store.updateTask(live.id, {
        paused: false,
        pausedReason: null,
      }, deps.getRunContextFor(live.id));
      resumeLive = { ...live, paused: false, pausedReason: undefined };
    }
    if (((Array.isArray(resumeLive.steps) && hasNonTerminalWorkflowSteps(resumeLive)) || failureValue === MERGE_BOUNDARY_RECOVERY_VALUE)
      && await deps.routeGraphFailureToExecutionResume(resumeLive, failedNode, failureValue, undefined, boundaryEvidence)) {
      return true;
    }
    // Fail-closed terminal path — release active worktree tracking now that no resume will reuse it.
    deps.activeWorktrees.delete(live.id);
    const message = `Workflow graph merge blocked at node '${failedNode}': ${IMPLEMENTATION_INCOMPLETE_NO_RESUME_MESSAGE}`;
    executorLog.warn(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
    if (!(await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column) && live.error == null) {
      await deps.store.updateTask(live.id, { error: message, status: "failed" }, deps.getRunContextFor(live.id));
    }
    await deps.persistTokenUsage(live.id);
    return true;
}

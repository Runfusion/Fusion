/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * routeImplementationIncompleteMergeGraphFailure peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowMerge 2026-07-14-18:20:
 * FN-1165: clear non-user pause parks for incomplete-merge failures; keep activeWorktrees
 * on resumable path; release only on fail-closed.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import { hasNonTerminalWorkflowSteps } from "./workflow-step-satisfaction.js";

export type RouteImplementationIncompleteMergeGraphFailureDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  clearPausedAborted: (taskId: string) => void;
  activeWorktrees: Map<string, Set<string>>;
  routeGraphFailureToExecutionResume: (
    live: TaskDetail,
    failedNode: string,
    failureValue: string | undefined,
  ) => Promise<boolean>;
  persistTokenUsage: (taskId: string) => Promise<void>;
};

export async function routeImplementationIncompleteMergeGraphFailure(
  deps: RouteImplementationIncompleteMergeGraphFailureDeps,
  live: TaskDetail,
  failedNode: string,
): Promise<boolean> {
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
    if (hasNonTerminalWorkflowSteps(resumeLive) && await deps.routeGraphFailureToExecutionResume(resumeLive, failedNode, "implementation-incomplete")) {
      return true;
    }
    // Fail-closed terminal path — release active worktree tracking now that no resume will reuse it.
    deps.activeWorktrees.delete(live.id);
    const message = `Workflow graph merge blocked at node '${failedNode}': implementation incomplete with no executable proof to resume — failing instead of retrying merge`;
    executorLog.warn(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
    if (!(await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column) && live.error == null) {
      await deps.store.updateTask(live.id, { error: message, status: "failed" }, deps.getRunContextFor(live.id));
    }
    await deps.persistTokenUsage(live.id);
    return true;
}

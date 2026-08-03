/**
 * FNXC:CodeOrganization 2026-08-03-12:00:
 * routeResetParsePinMismatchToRetry peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowReset 2026-06-29-10:04:
 * A user reset/retry can race an aborting graph-owned foreach instance that persists after the route cleared pins. If the next run reaches parse and sees only stale foreach pins while the task has no implementation progress, recover by deleting all graph instance rows and requeueing to todo. Do not hand the task to in-review, because parse has not executed work or produced mergeable output.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { resolveTerminalColumnsFor, resolveReboundColumnFor } from "./lifecycle-columns.js";

export type RouteResetParsePinMismatchDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  clearPausedAborted: (taskId: string) => void;
  activeWorktrees: Map<string, unknown>;
  persistTokenUsage: (taskId: string) => Promise<void>;
};

export async function routeResetParsePinMismatchToRetry(
  deps: RouteResetParsePinMismatchDeps,
  live: TaskDetail,
): Promise<boolean> {
  if (live.deletedAt) return false;
  if (live.paused || live.userPaused === true) return false;
  if ((await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) return false;
  const hasImplementationProgress =
    (live.currentStep ?? 0) > 0
    || (live.steps ?? []).some((step) => step.status === "done" || step.status === "in-progress" || step.status === "skipped");
  if (hasImplementationProgress) return false;

  const maybeStore = deps.store as unknown as {
    clearWorkflowRunStepInstancesAsync?: (taskId: string) => Promise<void>;
    clearWorkflowRunStepInstances?: (taskId: string) => void;
    clearWorkflowRunBranches?: (taskId: string, keepRunId: string) => void;
  };
  try {
    await (maybeStore.clearWorkflowRunStepInstancesAsync?.(live.id)
      ?? maybeStore.clearWorkflowRunStepInstances?.(live.id));
  } catch {
    // Legacy stores may not persist graph step instances.
  }
  deps.clearPausedAborted(live.id);
  deps.activeWorktrees.delete(live.id);
  await deps.store.updateTask(live.id, {
    status: null,
    error: null,
    graphResumeRetryCount: 0,
  }, deps.getRunContextFor(live.id));
  const reboundColumn = await resolveReboundColumnFor(deps.store, live.id);
  if (live.column !== reboundColumn) {
    await deps.store.moveTask(live.id, reboundColumn, { preserveProgress: false });
  }
  const message = "Auto-recovered: cleared stale workflow parse pins after reset/retry — task requeued before execution";
  executorLog.warn(`${live.id}: ${message}`);
  await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
  await deps.persistTokenUsage(live.id);
  return true;
}

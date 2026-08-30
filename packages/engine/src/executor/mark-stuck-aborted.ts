/**
 * FNXC:CodeOrganization 2026-08-03-10:55:
 * markStuckAborted peeled from TaskExecutor (U4).
 * Stuck-kill signal + bounded force-requeue if executor never unwinds.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): force-requeue skips when task left WIP.
 * FNXC:Workspace 2026-06-21-22:30: F8 — observability for multi-worktree skip.
 * FNXC:StuckRequeue 2026-06-27-23:15: reconcile steps before reaping hung worktree.
 */
import type { TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { executingTaskLock } from "../agents/active-session-registry.js";

export type MarkStuckAbortedDeps = {
  store: TaskStore;
  activeStepExecutors: Map<string, { terminateAllSessions(): Promise<void> }>;
  stuckAborted: Map<string, boolean>;
  executing: Set<string>;
  loopRecoveryState: Map<string, unknown>;
  terminateAllChildren: (taskId: string) => Promise<void>;
  awaitAbortInFlightTaskWork: (taskId: string, reason: string) => Promise<void>;
  clearPausedAborted: (taskId: string) => void;
  reexecuteTaskInPlace: (taskId: string) => Promise<void>;
};

export function markStuckAborted(
  deps: MarkStuckAbortedDeps,
  taskId: string,
): void {

  // Terminate step-session executor if active
  const stepExecutor = deps.activeStepExecutors.get(taskId);
  if (stepExecutor) {
    stepExecutor.terminateAllSessions().catch(err =>
      executorLog.warn(`Failed to terminate step sessions for stuck task ${taskId}: ${err}`)
    );
  }
  deps.stuckAborted.set(taskId, true);

  /*
  FNXC:StuckSessionRecovery 2026-08-28-07:48:
  If disposal cannot unwind the old executor, force-release only its runtime ownership. Preserve
  column, node, step, worktree, branch, and progress, then re-dispatch the same task in place.
  */
  if (deps.executing.has(taskId)) {
    const FORCE_RESUME_GRACE_MS = 60_000;
    setTimeout(async () => {
      if (!deps.executing.has(taskId)) return;
      try {
        const latestTask = await deps.store.getTask(taskId);
        if (latestTask.paused || latestTask.userPaused) {
          deps.stuckAborted.delete(taskId);
          return;
        }
        await deps.terminateAllChildren(taskId).catch((error: unknown) => {
          executorLog.warn(`${taskId}: child cleanup failed during forced stuck resume: ${error instanceof Error ? error.message : String(error)}`);
        });
        await deps.awaitAbortInFlightTaskWork(taskId, "forced in-place resume after stuck-session unwind timeout");
        deps.clearPausedAborted(taskId);
        deps.executing.delete(taskId);
        executingTaskLock.release(taskId);
        deps.stuckAborted.delete(taskId);
        deps.loopRecoveryState.delete(taskId);
        await deps.store.updateTask(taskId, { status: null, error: null });
        await deps.store.logEntry(taskId, "Forced stuck-session cleanup completed — resuming the same node and step in place");
        await deps.reexecuteTaskInPlace(taskId);
      } catch (error: unknown) {
        executorLog.error(`Failed to force-resume stuck task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, FORCE_RESUME_GRACE_MS);
  }
  
}

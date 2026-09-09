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
import type { PreparedAbortInFlightTaskWork } from "./await-abort-in-flight.js";

export type MarkStuckAbortedDeps = {
  store: TaskStore;
  activeStepExecutors: Map<string, { terminateAllSessions(): Promise<void> }>;
  stuckAborted: Map<string, boolean>;
  executing: Set<string>;
  loopRecoveryState: Map<string, unknown>;
  terminateAllChildren: (taskId: string) => Promise<void>;
  prepareAbortInFlightTaskWork: (
    taskId: string,
    reason: string,
    options: { deferTaskKeyedClaims: true },
  ) => PreparedAbortInFlightTaskWork;
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
  const executionLease = executingTaskLock.currentLease(taskId);

  /*
  FNXC:StuckSessionRecovery 2026-08-28-07:48:
  If disposal cannot unwind the old executor, force-release only its runtime ownership. Preserve
  column, node, step, worktree, branch, and progress, then re-dispatch the same task in place.

  FNXC:StuckSessionRecovery 2026-09-07-16:46:
  The ownership publication also re-reads global and engine pause controls inside the critical
  section. A paused engine retains the in-place continuation but must not dispatch its successor
  until the ordinary unpause owner resumes execution.

  FNXC:StuckSessionRecovery 2026-09-07-17:15:
  Reserve forced invalidation in the attempt FIFO before synchronously interrupting its runtime.
  Abort settlement and every task-keyed cleanup remain in that reservation; only after invalidation
  publishes may reexecuteTaskInPlace let a successor claim the task.
  */
  if (deps.executing.has(taskId)) {
    const FORCE_RESUME_GRACE_MS = 60_000;
    setTimeout(async () => {
      if (!deps.executing.has(taskId) || !executionLease) return;
      try {
        const invalidated = await executingTaskLock.invalidateWithSignal(
          executionLease,
          () => deps.prepareAbortInFlightTaskWork(
            taskId,
            "forced in-place resume after stuck-session unwind timeout",
            { deferTaskKeyedClaims: true },
          ),
          async (preparedAbort) => {
          await preparedAbort.complete().catch((error: unknown) => {
            executorLog.warn(`${taskId}: abort settlement failed during forced stuck resume: ${error instanceof Error ? error.message : String(error)}`);
          });
          await deps.terminateAllChildren(taskId).catch((error: unknown) => {
            executorLog.warn(`${taskId}: child cleanup failed during forced stuck resume: ${error instanceof Error ? error.message : String(error)}`);
          });
          const [latestTask, latestSettings] = await Promise.all([
            deps.store.getTask(taskId).catch((error: unknown) => {
              executorLog.warn(`${taskId}: task control read failed during forced stuck resume: ${error instanceof Error ? error.message : String(error)}`);
              return undefined;
            }),
            deps.store.getSettings().catch((error: unknown) => {
              executorLog.warn(`${taskId}: settings control read failed during forced stuck resume: ${error instanceof Error ? error.message : String(error)}`);
              return undefined;
            }),
          ]);
          deps.executing.delete(taskId);
          deps.stuckAborted.delete(taskId);
          deps.loopRecoveryState.delete(taskId);
          // Missing control evidence refuses dispatch, while invalidation still publishes in the FIFO.
          if (!latestTask || !latestSettings) return false;
          if (latestTask.paused || latestTask.userPaused || latestTask.deletedAt) return false;
          deps.clearPausedAborted(taskId);
          try {
            await deps.store.updateTask(taskId, { status: null, error: null });
          } catch (error: unknown) {
            executorLog.warn(`${taskId}: resume-state publication failed during forced stuck resume: ${error instanceof Error ? error.message : String(error)}`);
            return false;
          }
          if (latestSettings.globalPause || latestSettings.enginePaused) {
            await deps.store.logEntry(taskId, "Forced stuck-session ownership invalidated — continuation preserved until engine execution resumes").catch((error: unknown) => {
              executorLog.warn(`${taskId}: forced-resume pause log failed: ${error instanceof Error ? error.message : String(error)}`);
            });
            return false;
          }
          await deps.store.logEntry(taskId, "Forced stuck-session ownership invalidated — resuming the same node and step in place").catch((error: unknown) => {
            executorLog.warn(`${taskId}: forced-resume success log failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          return true;
        });
        if (invalidated.executed && invalidated.value === true) {
          await deps.reexecuteTaskInPlace(taskId);
        }
      } catch (error: unknown) {
        executorLog.error(`Failed to force-resume stuck task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, FORCE_RESUME_GRACE_MS);
  }
  
}

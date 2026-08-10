/**
 * FNXC:CodeOrganization 2026-08-03-10:55:
 * markStuckAborted peeled from TaskExecutor (U4).
 * Stuck-kill signal + bounded force-requeue if executor never unwinds.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): force-requeue skips when task left WIP.
 * FNXC:Workspace 2026-06-21-22:30: F8 — observability for multi-worktree skip.
 * FNXC:StuckRequeue 2026-06-27-23:15: reconcile steps before reaping hung worktree.
 */
import { existsSync } from "node:fs";
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { executingTaskLock } from "../agents/active-session-registry.js";
import { RemovalReason, removeWorktree } from "../worktree/worktree-pool.js";
import { resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

export type MarkStuckAbortedDeps = {
  store: TaskStore;
  rootDir: string;
  workspaceConfig: unknown;
  activeStepExecutors: Map<string, { terminateAllSessions(): Promise<void> }>;
  stuckAborted: Map<string, boolean>;
  executing: Set<string>;
  activeWorktrees: Map<string, unknown>;
  loopRecoveryState: Map<string, unknown>;
  resolveResumeLanes: (taskId: string) => Promise<{ wip: string }>;
  getWorktreePath: (taskId: string) => string | undefined | null;
  terminateAllChildren: (taskId: string) => Promise<void>;
  awaitAbortInFlightTaskWork: (taskId: string, reason: string) => Promise<void>;
  clearPausedAborted: (taskId: string) => void;
  resetStepsIfWorkLost: (task: Task) => Promise<void>;
  hasActiveWorktreeBinding: (ownerTaskId: string, path: string) => boolean;
};

export function markStuckAborted(
  deps: MarkStuckAbortedDeps,
  taskId: string,
  shouldRequeue: boolean = true,
): void {

  // Terminate step-session executor if active
  const stepExecutor = deps.activeStepExecutors.get(taskId);
  if (stepExecutor) {
    stepExecutor.terminateAllSessions().catch(err =>
      executorLog.warn(`Failed to terminate step sessions for stuck task ${taskId}: ${err}`)
    );
  }
  deps.stuckAborted.set(taskId, shouldRequeue);

  // Safety net: if the executor's Promise never resolves (e.g. a bash subprocess
  // is blocking the agent session even after dispose()), force-requeue the task
  // directly after a short grace period.  Without this, a task with a hung tool
  // call stays stranded in "in-progress" until the engine restarts.
  if (shouldRequeue && deps.executing.has(taskId)) {
    const FORCE_REQUEUE_GRACE_MS = 60_000; // 60 s — generous, but bounded
    setTimeout(async () => {
      if (!deps.executing.has(taskId)) return; // executor unwound normally — nothing to do
      // Re-check the latest column: self-healing may have already moved the
      // task out of in-progress (e.g. recoverCompletedTasks → in-review).
      // Force-requeueing in that case would clobber a valid recovery, undo
      // the worktree/branch state that recovery now relies on, and reset
      // step progress.
      let latestColumn: string | undefined;
      try {
        const latestTask = await deps.store.getTask(taskId);
        latestColumn = latestTask.column;
      } catch (err: unknown) {
        executorLog.warn(
          `${taskId} force-requeue could not read latest task state: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the board's wip lane; with the literal a
         renamed board skipped every force-requeue as "recovered concurrently". */
      if (latestColumn && latestColumn !== (await deps.resolveResumeLanes(taskId)).wip) {
        executorLog.log(
          `${taskId} force-requeue skipped — task is now in '${latestColumn}' (recovered concurrently)`,
        );
        deps.executing.delete(taskId);
        executingTaskLock.release(taskId);
        deps.stuckAborted.delete(taskId);
        return;
      }
      executorLog.warn(
        `${taskId} still executing ${FORCE_REQUEUE_GRACE_MS / 1000}s after stuck-kill signal ` +
        `(likely a hung subprocess) — force-requeueing`,
      );
      try {
        const settings = await deps.store.getSettings();
        const preserveProgress = settings.preserveProgressOnStuckRequeue !== false;
        const latestTask = await deps.store.getTask(taskId);
        const externalExecutionRoute = await resolveExternalExecutionCheckoutRoute(latestTask);
        /*
        FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
        Never remove an operator-owned external checkout during force-requeue cleanup.
        */
        const worktreePath = externalExecutionRoute.configured
          ? undefined
          : deps.getWorktreePath(taskId) ?? latestTask.worktree;
        /*
        FNXC:Workspace 2026-06-21-22:30:
        F8 — observability for the workspace case. A workspace task has no singular
        worktree (getWorktreePath returns undefined for a multi-worktree task, and
        latestTask.worktree is null on the browse-only root), so the removeWorktree
        block below silently no-ops. Per-repo teardown is Phase B; until then make
        the skip visible rather than silent. Behavior is unchanged.
        */
        if (deps.workspaceConfig && !worktreePath) {
          await deps.store.logEntry(
            taskId,
            `workspace task ${taskId}: no singular worktree to force-requeue (per-repo teardown is Phase B)`,
          );
        }
        await deps.store.logEntry(
          taskId,
          `Force-kill cleanup starting after stuck-kill unwind timeout — reaping in-flight surfaces and worktree`,
        );

        // Spawned children must be terminated before the canonical reaper clears
        // spawnedAgents bookkeeping; otherwise child agent sessions would be orphaned.
        await deps.terminateAllChildren(taskId).catch((err: unknown) => {
          executorLog.warn(`${taskId}: spawned child cleanup failed during force-requeue: ${err instanceof Error ? err.message : String(err)}`);
        });
        await deps.awaitAbortInFlightTaskWork(taskId, "force-requeue after stuck-kill unwind timeout");
        // awaitAbortInFlightTaskWork marks pausedAborted as a generic abort
        // signal (KB-PROV 2026-07-26: `engine-abort`, since the force-requeue is
        // engine-initiated and passes no `userCanceled`).
        // The force-requeue path has already handled the task move, so
        // clear it to prevent a later subprocess unwind from logging/moving as a pause.
        deps.clearPausedAborted(taskId);

        /*
        FNXC:StuckRequeue 2026-06-27-23:15:
        The force path mirrors normal stuck-requeue cleanup: before reaping a hung executor's worktree, reconcile step progress against committed branch state so preserved progress never points at deleted uncommitted work.
        */
        if (!externalExecutionRoute.configured) {
          await deps.resetStepsIfWorkLost(latestTask);
        }

        let cleanupFailed = false;
        if (worktreePath && existsSync(worktreePath)) {
          try {
            await removeWorktree({
              worktreePath,
              rootDir: deps.rootDir,
              settings,
              taskId,
              reason: RemovalReason.ExecutorStuckKilled,
              expectedOwnerTaskId: taskId,
              liveOwnerProbe: (path, ownerTaskId) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
            });
            executorLog.log(`${taskId}: removed worktree during force-requeue cleanup: ${worktreePath}`);
          } catch (cleanupErr: unknown) {
            cleanupFailed = true;
            const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
            executorLog.warn(`${taskId}: worktree removal failed during force-requeue cleanup (${worktreePath}): ${cleanupErrMessage}`);
            await deps.store.logEntry(taskId, `Force-kill cleanup failed to remove worktree ${worktreePath}: ${cleanupErrMessage}`);
          }
        }

        deps.activeWorktrees.delete(taskId);

        await deps.store.logEntry(
          taskId,
          `Force-requeued after stuck-kill: executor did not unwind within ${FORCE_REQUEUE_GRACE_MS / 1000}s (hung subprocess)${preserveProgress ? " — progress preserved" : ""}`,
        );
        await deps.store.updateTask(taskId, {
          status: "queued",
          error: null,
          worktree: null,
          branch: null,
        });
        await deps.store.moveTask(taskId, await resolveReboundColumnFor(deps.store, taskId), preserveProgress ? { preserveProgress: true } : undefined);
        // Remove from executing only after the hung surfaces and worktree have
        // been reaped, preventing a scheduler re-dispatch onto stale resources.
        deps.executing.delete(taskId);
        executingTaskLock.release(taskId);
        deps.stuckAborted.delete(taskId);
        deps.loopRecoveryState.delete(taskId);
        await deps.store.logEntry(
          taskId,
          cleanupFailed
            ? "Force-kill cleanup completed with non-fatal worktree removal failure — task requeued"
            : "Force-kill cleanup completed — in-flight surfaces reaped and task requeued",
        );
        executorLog.log(`${taskId} force-requeued to todo after stuck-kill cleanup`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        executorLog.error(`Failed to force-requeue stuck task ${taskId}: ${errorMessage}`);
        await deps.store.logEntry(taskId, `Force-kill cleanup failed during stuck-kill force-requeue: ${errorMessage}`).catch(() => undefined);
      }
    }, FORCE_REQUEUE_GRACE_MS);
  }
  
}

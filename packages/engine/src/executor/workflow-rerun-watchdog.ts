/**
 * FNXC:CodeOrganization 2026-08-03-21:25:
 * scheduleWorkflowRerun peeled from TaskExecutor (U4).
 * Immediate bounce + delayed watchdog retry when workflow rerun handoff stalls.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the INVERSE of the guard above — this one
 * SKIPS a card that is still executing. Note the direction: with the literal on a renamed board it
 * never matched, so a rerun could fire on a card mid-execution. A mechanical sweep of every
 * `!== "in-progress"` would fix the refusals and leave this admission in place.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";

export type WorkflowRerunWatchdogDeps = {
  store: TaskStore;
  workflowRerunWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
  workflowRerunWatchdogMs: number;
  clearWorkflowRerunWatchdog: (taskId: string) => void;
  performWorkflowRerunBounce: (
    taskId: string,
    worktreePath: string,
    preserveResumeState: boolean,
    persistWorktreePath?: boolean,
  ) => Promise<"bounced" | "skipped-pending" | "deferred-paused">;
  getExecutionPauseLabel: () => Promise<string | null>;
  resolveResumeLanes: (taskId: string) => Promise<{ wip: string }>;
};

export function scheduleWorkflowRerun(
  deps: WorkflowRerunWatchdogDeps,
  taskId: string,
  worktreePath: string,
  successMessage: string,
  preserveResumeState: boolean = true,
  /*
  FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
  When false, bounce must not write the operator external path into task.worktree.
  */
  persistWorktreePath: boolean = true,
): void {
  deps.clearWorkflowRerunWatchdog(taskId);

  setTimeout(async () => {
    try {
      const outcome = await deps.performWorkflowRerunBounce(taskId, worktreePath, preserveResumeState, persistWorktreePath);
      if (outcome === "bounced") {
        executorLog.log(successMessage);
      } else if (outcome === "skipped-pending") {
        executorLog.warn(`${taskId}: rerun bounce skipped — another bounce already in flight`);
      } else {
        executorLog.log(`${taskId}: rerun bounce deferred while pause is active`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${taskId}: failed to schedule rerun bounce: ${errorMessage}`);
    }
  }, 0);

  const watchdog = setTimeout(async () => {
    deps.workflowRerunWatchdogs.delete(taskId);

    const pauseLabel = await deps.getExecutionPauseLabel();
    if (pauseLabel) {
      executorLog.log(`${taskId}: workflow rerun watchdog skipped — ${pauseLabel} active`);
      return;
    }

    let currentTask: Task | null = null;
    try {
      currentTask = await deps.store.getTask(taskId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: workflow rerun watchdog could not read latest task state: ${errorMessage}`);
      return;
    }

    if (!currentTask || currentTask.paused
      || currentTask.column === (await deps.resolveResumeLanes(taskId)).wip) {
      return;
    }

    executorLog.warn(
      `${taskId}: workflow rerun watchdog fired after ${deps.workflowRerunWatchdogMs / 1000}s ` +
      `— task is still ${currentTask.column}; retrying handoff once`,
    );
    await deps.store.logEntry(
      taskId,
      `Watchdog: workflow rerun handoff stalled for ${deps.workflowRerunWatchdogMs / 1000}s ` +
      `(still ${currentTask.column}) — retrying once`,
    ).catch(() => undefined);

    try {
      const outcome = await deps.performWorkflowRerunBounce(taskId, worktreePath, preserveResumeState, persistWorktreePath);
      if (outcome === "bounced") {
        executorLog.warn(`${taskId}: workflow rerun watchdog retry succeeded`);
      } else if (outcome === "skipped-pending") {
        // The original bounce is still mid-flight, which means *it* is the
        // one that's hung — not us. Log honestly so operators don't see a
        // false "succeeded" message while the task is actually stranded.
        executorLog.error(
          `${taskId}: workflow rerun watchdog retry skipped — original bounce still in flight after ${deps.workflowRerunWatchdogMs / 1000}s; task may be stuck`,
        );
        await deps.store.logEntry(
          taskId,
          `Workflow rerun watchdog retry skipped — original bounce still in flight after ${deps.workflowRerunWatchdogMs / 1000}s; task may be stuck`,
        ).catch(() => undefined);
      } else {
        executorLog.log(`${taskId}: workflow rerun watchdog retry deferred while pause is active`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${taskId}: workflow rerun watchdog retry failed: ${errorMessage}`);
    }
  }, deps.workflowRerunWatchdogMs);

  deps.workflowRerunWatchdogs.set(taskId, watchdog);
}

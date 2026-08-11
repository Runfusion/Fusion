/**
 * FNXC:CodeOrganization 2026-08-03-21:15:
 * scheduleCompletedTaskWatchdog peeled from TaskExecutor (U4).
 * Bounded recovery when a completed task remains stuck in-progress after fn_task_done.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { isTaskWorkComplete } from "./task-predicates.js";

export type CompletedTaskWatchdogDeps = {
  store: TaskStore;
  completedTaskWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
  recoveringCompleted: Set<string>;
  executing: Set<string>;
  activeSessions: Map<string, unknown>;
  activeStepExecutors: Map<string, unknown>;
  activeWorkflowStepSessions: Map<string, unknown>;
  resumingUnpaused: Set<string>;
  completedTaskWatchdogMs: number;
  clearCompletedTaskWatchdog: (taskId: string) => void;
  getExecutionPauseLabel: () => Promise<string | null>;
  resolveResumeLanes: (taskId: string) => Promise<{ wip: string }>;
  recoverCompletedTask: (task: Task) => Promise<boolean>;
};

export function scheduleCompletedTaskWatchdog(
  deps: CompletedTaskWatchdogDeps,
  taskId: string,
  trigger: string,
): void {
  deps.clearCompletedTaskWatchdog(taskId);

  const handle = setTimeout(async () => {
    deps.completedTaskWatchdogs.delete(taskId);

    // Claim recovery slot atomically (synchronously) before any async work.
    // Without this, two paths can pass the in-flight guards on the same
    // event-loop turn and both call recoverCompletedTask() concurrently.
    if (
      deps.recoveringCompleted.has(taskId)
      || deps.executing.has(taskId)
      || deps.activeSessions.has(taskId)
      || deps.activeStepExecutors.has(taskId)
      || deps.activeWorkflowStepSessions.has(taskId)
      || deps.resumingUnpaused.has(taskId)
    ) {
      return;
    }
    deps.recoveringCompleted.add(taskId);

    try {
      const pauseLabel = await deps.getExecutionPauseLabel();
      if (pauseLabel) {
        return;
      }

      let currentTask: Task | null = null;
      try {
        currentTask = await deps.store.getTask(taskId);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        executorLog.warn(`${taskId}: completed-task watchdog could not read latest task state: ${errorMessage}`);
        return;
      }

      if (!currentTask || currentTask.paused
        || currentTask.column !== (await deps.resolveResumeLanes(taskId)).wip) {
        return;
      }
      if (!isTaskWorkComplete(currentTask)) {
        return;
      }

      executorLog.warn(
        `${taskId}: completed-task watchdog fired after ${deps.completedTaskWatchdogMs / 1000}s ` +
        `(${trigger}) — attempting direct recovery to in-review`,
      );
      await deps.store.logEntry(
        taskId,
        `Watchdog: task remained in-progress ${deps.completedTaskWatchdogMs / 1000}s after ${trigger} — attempting direct recovery to in-review`,
      ).catch(() => undefined);

      const recovered = await deps.recoverCompletedTask(currentTask);
      if (!recovered) {
        await deps.store.logEntry(
          taskId,
          "Watchdog recovery attempt could not finalize completed task — leaving for follow-up recovery",
        ).catch(() => undefined);
      }
    } finally {
      deps.recoveringCompleted.delete(taskId);
    }
  }, deps.completedTaskWatchdogMs);

  deps.completedTaskWatchdogs.set(taskId, handle);
}

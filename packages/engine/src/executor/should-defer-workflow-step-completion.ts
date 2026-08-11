/**
 * FNXC:CodeOrganization 2026-08-03-11:55:
 * shouldDeferWorkflowStepCompletion peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: wip-lane liveness family):
 * "still executing" is the board's WIP lane. With the literal a renamed board deferred EVERY
 * completion handoff — the card was never in `in-progress`, so this read "no longer active"
 * for a card that was actively executing, and the handoff was dropped with a log line.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type ShouldDeferWorkflowStepCompletionDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  pausedAborted: { has(taskId: string): boolean };
  userCanceledTaskIds: Set<string>;
  clearCompletedTaskWatchdog: (taskId: string) => void;
  resolveResumeLanes: (taskId: string) => Promise<{ wip: string }>;
  shouldDeferCompletionForGlobalPause: (taskId: string, context: string) => Promise<boolean>;
};

export async function shouldDeferWorkflowStepCompletion(
  deps: ShouldDeferWorkflowStepCompletionDeps,
  taskId: string,
  context: string,
): Promise<boolean> {
  let latestTask: Task | null = null;
  try {
    latestTask = await deps.store.getTask(taskId);
  } catch {
    latestTask = null;
  }

  if (latestTask?.paused || deps.pausedAborted.has(taskId)) {
    deps.clearCompletedTaskWatchdog(taskId);
    executorLog.log(`${taskId}: completion handoff deferred — task paused (${context})`);
    await deps.store.logEntry(
      taskId,
      `Completion handoff deferred — task paused (${context})`,
      undefined,
      deps.getRunContextFor(taskId),
    ).catch(() => undefined);
    return true;
  }

  if ((latestTask && latestTask.column !== (await deps.resolveResumeLanes(taskId)).wip) || deps.userCanceledTaskIds.has(taskId)) {
    deps.clearCompletedTaskWatchdog(taskId);
    executorLog.log(`${taskId}: completion handoff deferred — task no longer active (${context})`);
    await deps.store.logEntry(
      taskId,
      `Completion handoff deferred — task no longer active (${context})`,
      undefined,
      deps.getRunContextFor(taskId),
    ).catch(() => undefined);
    return true;
  }

  return deps.shouldDeferCompletionForGlobalPause(taskId, context);
}

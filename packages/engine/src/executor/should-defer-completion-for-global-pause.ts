/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * shouldDeferCompletionForGlobalPause peeled from TaskExecutor (U4).
 *
 * When global pause is active, skip completion handoff and leave a task-log breadcrumb.
 */
import type { TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type ShouldDeferCompletionForGlobalPauseDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  clearCompletedTaskWatchdog: (taskId: string) => void;
};

export async function shouldDeferCompletionForGlobalPause(
  deps: ShouldDeferCompletionForGlobalPauseDeps,
  taskId: string,
  context: string,
): Promise<boolean> {
  const settings = await deps.store.getSettings();
  if (!settings.globalPause) {
    return false;
  }

  deps.clearCompletedTaskWatchdog(taskId);
  executorLog.log(`${taskId}: completion handoff deferred — global pause active (${context})`);
  await deps.store.logEntry(
    taskId,
    `Completion handoff deferred — global pause active (${context})`,
    undefined,
    deps.getRunContextFor(taskId),
  ).catch(() => undefined);
  return true;
}

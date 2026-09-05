import type { TaskStore, RunMutationContext } from "@fusion/core";
import { executorLog } from "../logger.js";
/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * shouldDeferCompletionForGlobalPause peeled from TaskExecutor (U4).
 *
 * When global pause is active, skip completion handoff and leave a task-log breadcrumb.
 */

export type ShouldDeferCompletionForGlobalPauseDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => RunMutationContext | undefined;
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
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
    deps.runContextFor(taskId),
  ).catch(() => undefined);
  return true;
}

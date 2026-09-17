import { isRecoverableOverlapWaitFailure, allowsAutoMergeProcessing, resolveEffectiveAutoMerge, resolveTaskLifecycleColumns, type Task, type TaskStore } from "@fusion/core";
import { createLogger } from "../logger.js";

const log = createLogger("self-healing");

/*
FNXC:OverlapWaitRelease 2026-09-17-06:29:
Run on startup and maintenance, including failed WIP whose visible blocker was already cleared.
Only idle missing-delivery or superseded-owner failures resume; completed steps and the current lane remain intact.
Repairing an indicator is metadata cleanup, not authorization to resume a paused or human-owned card.
*/
export async function reconcileReleasedOverlapWaits(
  store: TaskStore,
  isTaskLive: (task: Task) => boolean,
  onReleased?: (releases: readonly { taskId: string; blockerId: string }[]) => void | Promise<void>,
): Promise<number> {
  if (typeof store.reconcileTaskOverlapWaits !== "function") return 0;
  const settings = await store.getSettings();
  if (settings.globalPause || settings.enginePaused) return 0;
  let count = 0;
  for (const task of await store.listTasks({ includeArchived: false, slim: true })) {
    if (task.deletedAt || (!task.overlapBlockedBy && !task.blockedBy && !isRecoverableOverlapWaitFailure(task.error))) continue;
    try {
      const lanes = await resolveTaskLifecycleColumns(store, task.id);
      const result = await store.reconcileTaskOverlapWaits(task.id, {
        resumeIf: (current) => current.column === lanes?.wip && !isTaskLive(current)
          && !current.checkedOutBy && !current.paused && !current.userPaused
          && resolveEffectiveAutoMerge(current, settings) !== false && allowsAutoMergeProcessing(current, settings),
      });
      if (result.cancelledCount || result.resumed || result.clearedBlockerIds.length) count++;
      if (result.clearedBlockerIds.length) await onReleased?.(result.clearedBlockerIds.map((blockerId) => ({ taskId: task.id, blockerId })));
    } catch (error) {
      log.warn(`Overlap recovery deferred for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return count;
}

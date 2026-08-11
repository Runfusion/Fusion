/**
 * FNXC:CodeOrganization 2026-08-03-19:10:
 * clearStalePauseAbortBeforeDispatch + clearPauseAbortStateForManualRetry peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-06-29-10:35:
 * A stale pause-abort marker must not survive into a fresh unpaused dispatch.
 * FN-7225/FN-7226 showed graph-owned execution failures being narrated as
 * pause/resume cleanup even though the task row was not paused. Clear the
 * volatile marker silently at dispatch entry so the task log names the real
 * workflow failure (`step-execute`, parse, review, etc.) instead of implying
 * the engine actually paused.
 *
 * FNXC:ManualRetry 2026-06-29-00:57:
 * User retry is a fresh execution boundary. Clear volatile pause-abort provenance so retries cannot inherit stale engine pause/resume classification from a prior run.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";

export type StalePauseAbortDeps = {
  store: TaskStore;
  hasPausedAborted: (taskId: string) => boolean;
  clearPausedAborted: (taskId: string) => void;
};

export async function clearStalePauseAbortBeforeDispatch(
  deps: StalePauseAbortDeps,
  task: Task,
): Promise<void> {
  if (!deps.hasPausedAborted(task.id)) return;
  let globalPause = false;
  try {
    globalPause = (await deps.store.getSettings()).globalPause === true;
  } catch {
    globalPause = false;
  }
  if (task.paused === true || task.userPaused === true || globalPause) return;
  deps.clearPausedAborted(task.id);
  executorLog.log(`${task.id}: cleared stale pause-abort marker before unpaused execution dispatch`);
}

export function clearPauseAbortStateForManualRetry(
  deps: Pick<StalePauseAbortDeps, "clearPausedAborted">,
  taskId: string,
): void {
  deps.clearPausedAborted(taskId);
}

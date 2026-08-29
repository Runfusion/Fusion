/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * parkApprovalSuspension peeled from TaskExecutor (U4).
 *
 * After disposing a surface under approval suspension, clear pause-abort markers and
 * leave the task in progress for decision resume.
 */
import type { TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type ParkApprovalSuspensionDeps = {
  store: TaskStore;
  approvalSuspended: Set<string>;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  clearPausedAborted: (taskId: string) => void;
};

export async function parkApprovalSuspension(
  deps: ParkApprovalSuspensionDeps,
  taskId: string,
  surface: string,
): Promise<boolean> {
  if (!deps.approvalSuspended.has(taskId)) return false;
  deps.clearPausedAborted(taskId);
  await deps.store.logEntry(
    taskId,
    `Execution suspended for approval — ${surface} disposed; task remains in progress for decision resume`,
    undefined,
    deps.getRunContextFor(taskId),
  );
  executorLog.log(`${taskId}: approval suspension parked after ${surface} disposal`);
  return true;
}

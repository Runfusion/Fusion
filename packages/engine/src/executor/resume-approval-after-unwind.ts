/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * resumeApprovalAfterUnwindIfNeeded peeled from TaskExecutor (U4).
 *
 * FNXC:ApprovalResume 2026-07-12-18:35:
 * Runs from execute()'s outer finally. A getTask throw must not escape finally and mask the
 * original execute outcome — treat unreadable tasks as no deferred resume.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";

export type ResumeApprovalAfterUnwindDeps = {
  store: TaskStore;
  approvalResumeAfterUnwind: Set<string>;
  resolveResumeLanes: (taskId: string) => Promise<ResumeLanes>;
  dispatchUnpauseResume: (task: Task) => Promise<boolean>;
};

export async function resumeApprovalAfterUnwindIfNeeded(
  deps: ResumeApprovalAfterUnwindDeps,
  taskId: string,
): Promise<boolean> {
  if (!deps.approvalResumeAfterUnwind.delete(taskId)) return false;
  let latestTask;
  try {
    latestTask = await deps.store.getTask(taskId);
  } catch (error) {
    executorLog.warn(`${taskId}: failed to read latest task state for deferred approval resume: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (latestTask.paused || latestTask.userPaused
    || latestTask.column !== (await deps.resolveResumeLanes(taskId)).wip) return false;
  return deps.dispatchUnpauseResume(latestTask);
}

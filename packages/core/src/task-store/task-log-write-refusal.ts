/*
FNXC:GithubTrackingReconcile 2026-09-15-15:19:
Delete-path callers need a drift-proof way to recognize task-log refusals because the reconciler
selects rows that are unloggable by construction. Keep the stable suffix compatible with the
historical archived wording while core remains the single source of current messages.
*/
export const TASK_LOG_READ_ONLY_SUFFIX = "logging is read-only";

export function buildTaskLogReadOnlyMessage(taskId: string): string {
  return `Task ${taskId} is deleted or historical — ${TASK_LOG_READ_ONLY_SUFFIX}`;
}

export function buildTaskNotFoundMessage(taskId: string): string {
  return `Task ${taskId} not found`;
}

export function isTaskLogWriteRefusal(error: unknown, taskId?: string): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.length === 0 || (taskId !== undefined && !message.includes(`Task ${taskId} `))) return false;
  return message.endsWith(TASK_LOG_READ_ONLY_SUFFIX) || /^Task .+ not found$/.test(message);
}

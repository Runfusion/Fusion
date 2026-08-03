/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * clearCompletedTaskWatchdog peeled from TaskExecutor (U4).
 */

export function clearCompletedTaskWatchdog(
  completedTaskWatchdogs: Map<string, ReturnType<typeof setTimeout>>,
  taskId: string,
): void {
  const handle = completedTaskWatchdogs.get(taskId);
  if (!handle) return;
  clearTimeout(handle);
  completedTaskWatchdogs.delete(taskId);
}

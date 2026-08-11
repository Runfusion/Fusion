/**
 * FNXC:CodeOrganization 2026-08-03-19:00:
 * clearWorkflowRerunWatchdog peeled from TaskExecutor (U4).
 */

export function clearWorkflowRerunWatchdog(
  workflowRerunWatchdogs: Map<string, ReturnType<typeof setTimeout>>,
  taskId: string,
): void {
  const handle = workflowRerunWatchdogs.get(taskId);
  if (!handle) return;
  clearTimeout(handle);
  workflowRerunWatchdogs.delete(taskId);
}

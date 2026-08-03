/**
 * FNXC:CodeOrganization 2026-08-03-13:55:
 * hasLiveTaskSessionSurface peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowRemediation 2026-07-01-23:40:
 * Live coding/step/CLI session surface (excludes executing/graphRouting so ending runs are not "still live").
 */
export type HasLiveTaskSessionSurfaceDeps = {
  activeSessions: Map<string, unknown>;
  activeStepExecutors: Map<string, unknown>;
  activeWorkflowStepSessions: Map<string, unknown>;
  activeCliTaskSessions: Map<string, unknown>;
};

export function hasLiveTaskSessionSurface(
  deps: HasLiveTaskSessionSurfaceDeps,
  taskId: string,
): boolean {
  return (
    deps.activeSessions.has(taskId)
    || deps.activeStepExecutors.has(taskId)
    || deps.activeWorkflowStepSessions.has(taskId)
    || deps.activeCliTaskSessions.has(taskId)
  );
}

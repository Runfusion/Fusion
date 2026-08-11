/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * getExecutingTaskIds, isTaskActive, hasActivePlanningWorkflowSession peeled from TaskExecutor (U4).
 *
 * FNXC:TaskTiming 2026-07-30-21:40:
 * A planning segment has one owner: a graph Plan Review session is live only while both its
 * session registration and planning ownership marker remain. isTaskActive is broader (implementation
 * + non-planning workflow sessions). Graph-routed tasks count as executing for the whole interpreter run.
 */

export type TaskLivenessDeps = {
  executing: Set<string>;
  recoveringCompleted: Set<string>;
  resumingUnpaused: Set<string>;
  activeSessions: Map<string, unknown>;
  activePlanningWorkflowSessions: Set<string>;
  activeWorkflowStepSessions: Map<string, unknown>;
  processWideGraphRouting: Set<string>;
};

export function getExecutingTaskIds(deps: TaskLivenessDeps): Set<string> {
  // Graph-routed tasks count as executing for their WHOLE interpreter run —
  // between seams the inner execute() has released this.executing, but the
  // graph still owns the lifecycle; self-healing/recovery must not touch it.
  return new Set([
    ...deps.executing,
    ...deps.recoveringCompleted,
    ...deps.resumingUnpaused,
    ...deps.processWideGraphRouting,
  ]);
}

export function hasActivePlanningWorkflowSession(
  deps: TaskLivenessDeps,
  taskId: string,
): boolean {
  return deps.activePlanningWorkflowSessions.has(taskId) && deps.activeWorkflowStepSessions.has(taskId);
}

export function isTaskActive(
  deps: TaskLivenessDeps,
  taskId: string,
): boolean {
  return (
    deps.executing.has(taskId)
    || deps.activeSessions.has(taskId)
    || deps.recoveringCompleted.has(taskId)
    || deps.processWideGraphRouting.has(taskId)
  );
}

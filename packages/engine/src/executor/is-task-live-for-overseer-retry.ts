/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * isTaskLiveForOverseerRetry peeled from TaskExecutor (U4).
 *
 * FNXC:PlannerOversight 2026-07-21-22:56:
 * Overseer retry_step must not hard-cancel a live agent (FN-8471 thrash). True when any
 * in-process graph claim, coding/step/CLI session, or unpause-resume handoff still owns the task.
 */

export type IsTaskLiveForOverseerRetryDeps = {
  isTaskActive: (taskId: string) => boolean;
  hasLiveTaskSessionSurface: (taskId: string) => boolean;
  resumingUnpaused: Set<string>;
};

export function isTaskLiveForOverseerRetry(
  deps: IsTaskLiveForOverseerRetryDeps,
  taskId: string,
): boolean {
  // isTaskActive covers executing/graphRouting/coding session/recoveringCompleted;
  // hasLiveTaskSessionSurface adds step/workflow/CLI surfaces; resumingUnpaused is the unpause handoff gap.
  return (
    deps.isTaskActive(taskId)
    || deps.hasLiveTaskSessionSurface(taskId)
    || deps.resumingUnpaused.has(taskId)
  );
}

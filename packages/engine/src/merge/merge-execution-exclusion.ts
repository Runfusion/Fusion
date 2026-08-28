import type { ActiveSessionRegistry } from "../agents/active-session-registry.js";

export type ExecutionLivenessDeps = {
  activeSessionRegistry: Pick<ActiveSessionRegistry, "pathsForTask" | "isPathActive">;
  executingTaskLock: Pick<{ has(taskId: string): boolean }, "has">;
  isTaskActive?: (taskId: string) => boolean;
};

export type MergeLivenessDeps = {
  activeMergeTaskId?: string | null;
  mergeActive?: ReadonlySet<string>;
  mergeQueue?: readonly string[];
};

export type ExecutionLivenessSignal =
  | "active-session"
  | "executing-lock"
  | "task-active";

/*
FNXC:MergeExecutionExclusion 2026-08-23-06:52:
FN-180 requires merge admission to be independent of review state: a live executor
session is the structural cause of the FN-175 interleave, even when review is perfect.
The caller defers rather than parks; admission resumes as soon as this signal clears.
*/
export function getTaskExecutionLivenessSignal(
  taskId: string,
  deps: ExecutionLivenessDeps,
): ExecutionLivenessSignal | undefined {
  if (deps.activeSessionRegistry.pathsForTask(taskId).some((path) => deps.activeSessionRegistry.isPathActive(path))) {
    return "active-session";
  }
  if (deps.executingTaskLock.has(taskId)) return "executing-lock";
  if (deps.isTaskActive?.(taskId)) return "task-active";
  return undefined;
}

export function isTaskExecutionLive(taskId: string, deps: ExecutionLivenessDeps): boolean {
  return getTaskExecutionLivenessSignal(taskId, deps) !== undefined;
}

/** The converse protects executor dispatch from landing a branch underneath it. */
export function isTaskMergeInFlight(taskId: string, deps: MergeLivenessDeps): boolean {
  return deps.activeMergeTaskId === taskId
    || deps.mergeActive?.has(taskId) === true
    || deps.mergeQueue?.includes(taskId) === true;
}

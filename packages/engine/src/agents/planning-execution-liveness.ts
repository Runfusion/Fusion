import type { WorkflowWorkItem } from "@fusion/core";
import {
  activeSessionRegistry as defaultActiveSessionRegistry,
  executingTaskLock as defaultExecutingTaskLock,
  type ActiveSessionRegistry,
} from "./active-session-registry.js";
import { planningLivenessRegistry } from "./planning-liveness.js";

export const PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX = "planning-continuation-dispatch:";

export function planningContinuationDispatchLeaseOwner(
  item: Pick<WorkflowWorkItem, "id" | "attempt">,
): string {
  return `${PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX}${item.id}:${item.attempt}`;
}

export function isPlanningContinuationDispatchClaim(
  item: Pick<WorkflowWorkItem, "state" | "leaseOwner">,
): boolean {
  return item.state === "running"
    && item.leaseOwner?.startsWith(PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX) === true;
}

export type TaskLivenessSignal =
  | "active-session"
  | "executing-lock"
  | "task-active"
  | "planning-processor"
  | "planning-probe";

export interface PlanningExecutionLivenessDeps {
  activeSessionRegistry?: Pick<ActiveSessionRegistry, "pathsForTask" | "isPathActive">;
  executingTaskLock?: Pick<{ has(taskId: string): boolean }, "has">;
  isTaskActive?: (taskId: string) => boolean;
  getPlanningTaskIds?: () => ReadonlySet<string>;
  isPlanningLive?: (taskId: string) => boolean;
}

/*
FNXC:PlanningExecutionLiveness 2026-09-06-00:29:
FN-299 exposed a fourth owner that the historical execution triple cannot see: a planner without a
worktree registers no active path, does not hold `executingTaskLock`, and is not an executor-active
task. Treat planner ownership as first-class liveness, and retain the planning registry's fail-closed
contract: a throwing probe means the planner may still be alive and therefore refuses recovery.

`getPlanningTaskIds` and the process-wide probe deliberately coexist. Triage's production probe is
backed by that same getter, but self-healing tests and integrations can construct a manager without
the option while a registered planner is still live. Keeping both independently injectable makes
that redundancy a defence-in-depth boundary rather than an accidental duplicate.

FNXC:PlanningContinuationDispatch 2026-09-06-01:58:
The planning lifecycle lock orders contenders, but ordering alone is not ownership: after the drain
releases that lock, a late planner needs durable evidence that graph dispatch already won. A running
continuation whose owner uses the dispatch prefix is that claim. Triage must refuse to replace it,
so either the graph or the planner starts, never both.
*/
export function getTaskPlanningOrExecutionLivenessSignal(
  taskId: string,
  deps: PlanningExecutionLivenessDeps = {},
): TaskLivenessSignal | undefined {
  const sessions = deps.activeSessionRegistry ?? defaultActiveSessionRegistry;
  if (sessions.pathsForTask(taskId).some((path) => sessions.isPathActive(path))) {
    return "active-session";
  }

  const lock = deps.executingTaskLock ?? defaultExecutingTaskLock;
  if (lock.has(taskId)) return "executing-lock";
  if (deps.isTaskActive?.(taskId) === true) return "task-active";

  try {
    if (deps.getPlanningTaskIds?.().has(taskId) === true) return "planning-processor";
  } catch {
    return "planning-processor";
  }

  const isPlanningLive = deps.isPlanningLive ?? planningLivenessRegistry.isPlanningLive.bind(planningLivenessRegistry);
  if (isPlanningLive(taskId)) return "planning-probe";
  return undefined;
}

export function isTaskPlanningOrExecutionLive(
  taskId: string,
  deps: PlanningExecutionLivenessDeps = {},
): boolean {
  return getTaskPlanningOrExecutionLivenessSignal(taskId, deps) !== undefined;
}

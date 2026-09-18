import type { WorkflowWorkItem } from "@fusion/core";
import {
  activeSessionRegistry as defaultActiveSessionRegistry,
  executingTaskLock as defaultExecutingTaskLock,
  type ActiveSessionRegistry,
} from "./active-session-registry.js";
import { planningLivenessRegistry } from "./planning-liveness.js";

/*
FNXC:PlanningExecutionLiveness 2026-09-17-00:30:
Reimplemented for FN-332 "overlap wait synchronization", which needs a liveness check before it
claims/completes an overlap-wait episode (a claim on a task whose planner or executor no longer
owns it must not be allowed to publish). The historical "is this task live" triple (active session
path, executingTaskLock, isTaskActive) misses a planner that has not yet acquired a worktree: it
registers no active path, does not hold executingTaskLock, and is not executor-active. Treat
planner ownership (the process-wide `planningLivenessRegistry` probe, or an injected task-id set)
as a fourth first-class signal.
*/

export const PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX = "planning-continuation-dispatch:";

/** Deterministic lease-owner string for a work item's current dispatch attempt. */
export function planningContinuationDispatchLeaseOwner(item: Pick<WorkflowWorkItem, "id" | "attempt">): string {
  return `${PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX}${item.id}:${item.attempt}`;
}

/** True when a work item is currently held by the planning-continuation dispatcher (as opposed to some other lease owner). */
export function isPlanningContinuationDispatchClaim(item: Pick<WorkflowWorkItem, "state" | "leaseOwner">): boolean {
  return item.state === "running" && item.leaseOwner?.startsWith(PLANNING_CONTINUATION_DISPATCH_LEASE_OWNER_PREFIX) === true;
}

export type TaskLivenessSignal = "active-session" | "executing-lock" | "task-active" | "planning-processor" | "planning-probe";

export interface PlanningExecutionLivenessDeps {
  activeSessionRegistry?: Pick<ActiveSessionRegistry, "pathsForTask" | "isPathActive">;
  executingTaskLock?: Pick<{ has(taskId: string): boolean }, "has">;
  isTaskActive?: (taskId: string) => boolean;
  getPlanningTaskIds?: () => ReadonlySet<string>;
  isPlanningLive?: (taskId: string) => boolean;
}

/**
 * Resolves which liveness signal (if any) currently proves a task is planning or executing.
 * A throwing planning-processor getter is treated as "planning-processor" (fail closed: ambiguity
 * must preserve a possibly-live planner rather than let a caller treat the task as free).
 */
export function getTaskPlanningOrExecutionLivenessSignal(taskId: string, deps: PlanningExecutionLivenessDeps = {}): TaskLivenessSignal | undefined {
  const sessions = deps.activeSessionRegistry ?? defaultActiveSessionRegistry;
  if (sessions.pathsForTask(taskId).some((path) => sessions.isPathActive(path))) return "active-session";

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

export function isTaskPlanningOrExecutionLive(taskId: string, deps: PlanningExecutionLivenessDeps = {}): boolean {
  return getTaskPlanningOrExecutionLivenessSignal(taskId, deps) !== undefined;
}

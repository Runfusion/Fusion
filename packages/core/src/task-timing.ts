import type { Task } from "./types.js";

/**
 * FNXC:TaskTiming 2026-08-01-10:00:
 * Operators' active-time totals include live and persisted planning AI work as
 * well as in-progress execution. Column dwell remains idle wall-clock data and
 * must never be substituted for an agent session anchor.
 */
export function getTotalAgentActiveMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "cumulativePlanningMs" | "planningStartedAt">,
  nowMs: number,
): number | null {
  const executionBase = Math.max(0, task.cumulativeActiveMs ?? 0);
  const executionStartMs = task.column === "in-progress" ? Date.parse(task.executionStartedAt ?? "") : NaN;
  const execution = executionBase + (Number.isFinite(executionStartMs) ? Math.max(0, nowMs - executionStartMs) : 0);
  const planningBase = Math.max(0, task.cumulativePlanningMs ?? 0);
  const planningStartMs = Date.parse(task.planningStartedAt ?? "");
  const planning = planningBase + (Number.isFinite(planningStartMs) ? Math.max(0, nowMs - planningStartMs) : 0);
  return task.cumulativeActiveMs != null || task.cumulativePlanningMs != null || Number.isFinite(executionStartMs) || Number.isFinite(planningStartMs)
    ? execution + planning
    : null;
}

export function startPlanningSegment<T extends Pick<Task, "planningStartedAt">>(task: T, nowMs = Date.now()): { planningStartedAt?: string } {
  return task.planningStartedAt ? {} : { planningStartedAt: new Date(nowMs).toISOString() };
}

export function finalizePlanningSegment<T extends Pick<Task, "cumulativePlanningMs" | "planningStartedAt">>(task: T, endMs = Date.now()): { cumulativePlanningMs?: number; planningStartedAt?: null } {
  const startedMs = Date.parse(task.planningStartedAt ?? "");
  if (!Number.isFinite(startedMs)) return {};
  return {
    cumulativePlanningMs: Math.max(0, task.cumulativePlanningMs ?? 0) + Math.max(0, endMs - startedMs),
    planningStartedAt: null,
  };
}

import type { Task } from "./types.js";
import { isWipColumnRole, type ColumnRoleTraitFlags } from "./column-roles.js";

/**
 * FNXC:TaskTiming 2026-08-01-10:00:
 * Operators' active-time totals include live and persisted planning AI work as
 * well as in-progress execution. Column dwell remains idle wall-clock data and
 * must never be substituted for an agent session anchor.
 */
export function getTotalAgentActiveMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "cumulativePlanningMs" | "planningStartedAt">,
  nowMs: number,
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-03:20 (batch-core feed):
  The task column's resolved trait flags. Omitted, `isWipColumnRole` falls back to the legacy id, so
  an unconverted caller is byte-identical.

  This gate decides whether the card's LIVE execution segment counts. Keyed on the literal, a renamed
  wip lane dropped the in-flight segment from every active-time total, so the task an agent is
  working on RIGHT NOW under-reported by exactly the elapsed time of the current run — and it healed
  itself the moment the task moved on and the segment was persisted into `cumulativeActiveMs`. A
  metric that is wrong only while you are watching it is close to unreportable as a bug.
  */
  columnFlags?: ColumnRoleTraitFlags,
): number | null {
  const executionBase = Math.max(0, task.cumulativeActiveMs ?? 0);
  const executionStartMs = isWipColumnRole(columnFlags, task.column) ? Date.parse(task.executionStartedAt ?? "") : NaN;
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

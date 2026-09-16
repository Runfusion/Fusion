import type { Task } from "../types.js";
import { isWipColumnRole, type ColumnRoleTraitFlags } from "../column-roles.js";

/**
 * FNXC:TaskTiming 2026-08-01-10:00:
 * Operators' active-time totals include live and persisted planning AI work as
 * well as in-progress execution. Column dwell remains idle wall-clock data and
 * must never be substituted for an agent session anchor.
 */
export function getTotalAgentActiveMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "cumulativePlanningMs" | "planningStartedAt">
    & Partial<Pick<Task, "firstExecutionAt" | "createdAt" | "cumulativePausedMs" | "pausedStartedAt" | "paused" | "userPaused">>,
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
  /*
  FNXC:TaskPauseAccounting 2026-09-16-06:16:
  FN-457 — subtract durable paused time from the execution bucket. THIS MUST STAY BYTE-EQUIVALENT TO
  `getPausedDeductionMs` in `packages/dashboard/app/utils/taskTiming.ts`; the two copies of this
  calculation have drifted once already (see the WorkflowLifecycleColumns note on `columnFlags`
  below) and only a visible production defect caught it. `task-timing-pause.test.ts` pins the parity.

  The open segment is deducted ONLY while the card is actually paused: a `pausedStartedAt` on an
  unpaused card is orphaned (a seam that cleared the park without closing the segment, or a
  historical row) and deducting it would grow without bound and drive the total to zero.
  */
  const pausedBanked = Math.max(0, task.cumulativePausedMs ?? 0);
  const pauseOpenMs = (task.paused === true || task.userPaused === true) ? Date.parse(task.pausedStartedAt ?? "") : NaN;
  const pausedMs = pausedBanked + (Number.isFinite(pauseOpenMs) ? Math.max(0, nowMs - pauseOpenMs) : 0);
  const executionGross = executionBase + (Number.isFinite(executionStartMs) ? Math.max(0, nowMs - executionStartMs) : 0);
  const execution = Math.max(0, executionGross - pausedMs);
  const planningBase = Math.max(0, task.cumulativePlanningMs ?? 0);
  const planningStartMs = Date.parse(task.planningStartedAt ?? "");
  const planning = planningBase + (Number.isFinite(planningStartMs) ? Math.max(0, nowMs - planningStartMs) : 0);
  if (task.cumulativeActiveMs == null && task.cumulativePlanningMs == null && !Number.isFinite(executionStartMs) && !Number.isFinite(planningStartMs)) {
    return null;
  }

  /*
  FNXC:TaskRuntimeSegments 2026-08-15-20:34:
  Closed segments can be historically poisoned by the former sticky execution anchor. Never expose
  their accumulated total beyond the task's real age; this display defense heals old rows while the
  move hook prevents new poison. This total includes planning recorded before first execution, so
  creation is the earliest durable wall-clock ceiling and must take precedence over firstExecutionAt.
  */
  const ageAnchorMs = Date.parse(task.createdAt ?? task.firstExecutionAt ?? "");
  const total = execution + planning;
  return Number.isFinite(ageAnchorMs) ? Math.min(total, Math.max(0, nowMs - ageAnchorMs)) : total;
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

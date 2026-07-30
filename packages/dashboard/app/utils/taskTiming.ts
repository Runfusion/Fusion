import { isWipColumnRole, type ColumnRoleFlags } from "./columnRoles";
import type { Task, TaskLogEntry, WorkflowStepResult } from "@fusion/core";

export interface TimingEvent {
  timestamp: string;
  durationMs?: number;
  summary: string;
}

function summarizeTimingLabel(entry: TaskLogEntry): string {
  const timingText = entry.action || entry.outcome || "";
  const stripped = timingText
    .replace(/^\[timing\]\s*/i, "")
    .replace(/^\[[^\]]+\]\s*/i, "")
    .replace(/\s+in\s+\d+(?:\.\d+)?ms\b/i, "")
    .replace(/\s+after\s+\d+(?:\.\d+)?ms\b/i, "")
    .trim();
  return stripped || "Timing event";
}

export function extractTimingEvents(logEntries: TaskLogEntry[]): TimingEvent[] {
  return logEntries
    .filter((entry) => {
      const actionText = typeof entry.action === "string" ? entry.action : "";
      const outcomeText = typeof entry.outcome === "string" ? entry.outcome : "";
      return actionText.includes("[timing]") || outcomeText.includes("[timing]");
    })
    .map((entry) => {
      const haystack = `${entry.action ?? ""}\n${entry.outcome ?? ""}`;
      const durationMatch = haystack.match(/(\d+(?:\.\d+)?)ms\b/i);
      const durationMs = durationMatch ? Number(durationMatch[1]) : undefined;
      return {
        timestamp: entry.timestamp,
        durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
        summary: summarizeTimingLabel(entry),
      };
    });
}

export function getTimedDurationMs(logEntries: TaskLogEntry[] | undefined): number | null {
  if (!logEntries || logEntries.length === 0) return null;
  let total = 0;
  let counted = 0;
  for (const event of extractTimingEvents(logEntries)) {
    if (typeof event.durationMs !== "number") continue;
    total += event.durationMs;
    counted += 1;
  }
  return counted > 0 ? total : null;
}

export function parseTimestampToMs(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getWorkflowRuntimeMs(results: WorkflowStepResult[] | undefined, nowMs: number): number | null {
  if (!results || results.length === 0) return null;

  let total = 0;
  let counted = 0;
  for (const step of results) {
    if (!step.startedAt) continue;
    const startedMs = parseTimestampToMs(step.startedAt);
    if (startedMs == null) continue;

    let endMs: number;
    if (step.completedAt) {
      const completedMs = parseTimestampToMs(step.completedAt);
      if (completedMs == null || completedMs < startedMs) continue;
      endMs = completedMs;
    } else {
      endMs = Math.max(startedMs, nowMs);
    }

    total += endMs - startedMs;
    counted += 1;
  }

  return counted > 0 ? total : null;
}

export function getEndToEndDurationMs(
  executionStartedAt: string | undefined,
  executionCompletedAt: string | undefined,
  nowMs: number,
): number | null {
  const startedMs = parseTimestampToMs(executionStartedAt);
  if (startedMs == null) return null;

  const completedMs = parseTimestampToMs(executionCompletedAt);
  const endMs = completedMs != null && completedMs >= startedMs ? completedMs : nowMs;
  return Math.max(0, endMs - startedMs);
}

export function getActiveRuntimeMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "columnMovedAt">,
  nowMs: number,
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-10:10:
  THE DASHBOARD HAS ITS OWN COPY OF THIS FUNCTION, and converting core's did not touch it.

  `@fusion/core`'s `task-timing.ts` exports a `getTotalAgentActiveMs` that was converted onto
  `isWipColumnRole` — but the card chip imports THIS module instead, so that conversion never
  reached the surface an operator actually looks at. Two implementations of one calculation, one
  converted and one not, is the same drift `column-roles.ts` was created to end.

  Keyed on the literal, the LIVE execution segment was dropped on a renamed board, so the card
  under-reported the run in flight by exactly its elapsed time — and healed itself the moment the
  card moved on and the segment was persisted.

  Omitted flags keep the legacy id via `isWipColumnRole`'s own degraded mode.
  */
  columnFlags?: ColumnRoleFlags,
): number | null {
  const persisted = task.cumulativeActiveMs;
  const base = persisted ?? 0;

  if (isWipColumnRole(columnFlags, task.column)) {
    const startedMs = parseTimestampToMs(task.executionStartedAt);
    if (startedMs != null) {
      return base + Math.max(0, nowMs - startedMs);
    }
  }

  if (persisted != null) {
    return Math.max(0, persisted);
  }

  return null;
}

/** FNXC:TaskTiming 2026-07-20-10:00: rendered task totals include planning AI
 * segments while getActiveRuntimeMs intentionally remains execution-only. */
export function getTotalAgentActiveMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "cumulativePlanningMs" | "planningStartedAt">,
  nowMs: number,
  /** Resolved trait flags for the card's column; omitted keeps the legacy id. */
  columnFlags?: ColumnRoleFlags,
): number | null {
  const execution = getActiveRuntimeMs(task as never, nowMs, columnFlags) ?? 0;
  const planningStart = parseTimestampToMs(task.planningStartedAt);
  const planning = Math.max(0, task.cumulativePlanningMs ?? 0) + (planningStart != null ? Math.max(0, nowMs - planningStart) : 0);
  return task.cumulativeActiveMs != null || task.cumulativePlanningMs != null || (isWipColumnRole(columnFlags, task.column) && parseTimestampToMs(task.executionStartedAt) != null) || planningStart != null
    ? execution + planning
    : null;
}

export function getWallClockSinceFirstExecutionMs(
  firstExecutionAt: string | undefined,
  executionCompletedAt: string | undefined,
  nowMs: number,
): number | null {
  const firstMs = parseTimestampToMs(firstExecutionAt);
  if (firstMs == null) return null;

  const completedMs = parseTimestampToMs(executionCompletedAt);
  const endMs = completedMs != null ? completedMs : nowMs;
  return Math.max(0, endMs - firstMs);
}

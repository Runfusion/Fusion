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

/*
FNXC:WorkflowResolvedColumns 2026-07-30-11:30 (batch-dashboard-app):
`columnFlags` resolves the WIP role; omitted -> the legacy id, i.e. today's behaviour.

These two functions decide whether a card's runtime is still ACCRUING. Keyed on the literal, a card
in a renamed wip lane reports only its persisted `cumulativeActiveMs` and never the in-flight
segment, so every duration display freezes at the last checkpoint while the agent keeps working.

STILL LITERALS, REVERTED 2026-07-30-22:40 — the bug is real, my fix was inert. NEITHER FUNCTION
TAKES A `columnFlags` PARAMETER ANY MORE; the wording below describes the removed attempt. I added a
`columnFlags` parameter to both and no caller could supply one: `getTotalAgentActiveMs` is reached
from module-level helpers with no flags in scope (TaskCard's `getTaskEndToEndDurationMs`,
TaskTokenStatsPanel), and `getActiveRuntimeMs`'s only caller is that wrapper. An optional parameter
every caller omits is strictly worse than the literal — the literal is honest and stays counted.

Unblocking needs a flags-bearing caller, which means the components that compute these durations
resolving traits first. Left counted so the census keeps pointing here.
*/
export function getActiveRuntimeMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "columnMovedAt">,
  nowMs: number,
): number | null {
  const persisted = task.cumulativeActiveMs;
  const base = persisted ?? 0;

  if (task.column === "in-progress") {
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
): number | null {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-22:40 (REVERTED — the seam had no supplier):
  No `columnFlags` parameter here, deliberately. Both callers reach this from module-level helpers
  with no flags in scope (`getTaskEndToEndDurationMs` in TaskCard, and TaskTokenStatsPanel), so the
  parameter I added was never supplied and the conversion was inert. `getActiveRuntimeMs` keeps its
  parameter because it HAS a supplier; this wrapper does not, so it passes nothing and the literal
  inside stays counted.
  */
  const execution = getActiveRuntimeMs(task, nowMs) ?? 0;
  const planningStart = parseTimestampToMs(task.planningStartedAt);
  const planning = Math.max(0, task.cumulativePlanningMs ?? 0) + (planningStart != null ? Math.max(0, nowMs - planningStart) : 0);
  return task.cumulativeActiveMs != null || task.cumulativePlanningMs != null || (task.column === "in-progress" && parseTimestampToMs(task.executionStartedAt) != null) || planningStart != null
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

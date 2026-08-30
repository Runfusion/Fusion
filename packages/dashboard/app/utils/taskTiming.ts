import { isWipColumnRole, type ColumnRoleFlags } from "./columnRoles";
import type { Task, TaskLogEntry, WorkflowStepResult } from "@fusion/core";
import { getTaskLogEntryAction } from "./taskLogEntryDisplay";

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

export function formatDurationMs(valueMs: number): string {
  if (valueMs < 1000) {
    return `${Math.round(valueMs)} ms`;
  }
  const valueSeconds = valueMs / 1000;
  if (valueSeconds < 60) {
    return `${valueSeconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(valueSeconds / 60);
  const seconds = Math.round(valueSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

const STEP_TRANSITION_ACTION = /^Step (\d+) \((.*)\) → (pending|in-progress|done|skipped)$/;

/*
FNXC:TaskStepDurations 2026-08-29-05:45:
`packages/core/src/task-store/merge-queue-ops.ts` is the sole writer of these step-transition
actions. Task-detail logs retain only the latest 500 entries, so an opening transition that has
been trimmed must produce no duration instead of inventing a start time.
*/
export function buildStepDurations(log: TaskLogEntry[] | undefined): {
  get(stepIndex: number, stepName: string): number | undefined;
} {
  const activeStarts = new Map<string, number>();
  const durationsByStep = new Map<string, number>();
  const durationsByIndex = new Map<number, number>();

  for (const entry of log ?? []) {
    const match = getTaskLogEntryAction(entry).match(STEP_TRANSITION_ACTION);
    if (!match) continue;

    const stepIndex = Number.parseInt(match[1] ?? "", 10);
    const stepName = match[2] ?? "";
    const status = match[3];
    const timestampMs = parseTimestampToMs(entry.timestamp);
    if (!Number.isInteger(stepIndex) || timestampMs == null || !status) continue;

    const stepKey = `${stepIndex}:${stepName}`;
    if (status === "in-progress") {
      if (!activeStarts.has(stepKey)) activeStarts.set(stepKey, timestampMs);
      continue;
    }

    const startedAtMs = activeStarts.get(stepKey);
    if (startedAtMs == null || timestampMs < startedAtMs) continue;

    const elapsedMs = timestampMs - startedAtMs;
    durationsByStep.set(stepKey, (durationsByStep.get(stepKey) ?? 0) + elapsedMs);
    durationsByIndex.set(stepIndex, (durationsByIndex.get(stepIndex) ?? 0) + elapsedMs);
    activeStarts.delete(stepKey);
  }

  return {
    get(stepIndex: number, stepName: string): number | undefined {
      return durationsByStep.get(`${stepIndex}:${stepName}`) ?? durationsByIndex.get(stepIndex);
    },
  };
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
FNXC:TaskRuntimeSegments 2026-08-15-20:34:
The card and detail panel must cap legacy cumulative values at a durable wall-clock age. Execution-
only values use first execution, while totals that include pre-execution planning use task creation.
This is a reader-only guard for rows written before closed WIP segments cleared their anchor.
*/
function clampRuntimeToWallClock(totalMs: number, ageAnchor: string | undefined, nowMs: number): number {
  const ageAnchorMs = parseTimestampToMs(ageAnchor);
  return ageAnchorMs == null ? totalMs : Math.min(totalMs, Math.max(0, nowMs - ageAnchorMs));
}

export function getActiveRuntimeMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "columnMovedAt">
    & Partial<Pick<Task, "firstExecutionAt" | "createdAt">>,
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
      return clampRuntimeToWallClock(base + Math.max(0, nowMs - startedMs), task.firstExecutionAt ?? task.createdAt, nowMs);
    }
  }

  if (persisted != null) {
    return clampRuntimeToWallClock(Math.max(0, persisted), task.firstExecutionAt ?? task.createdAt, nowMs);
  }

  return null;
}

/** FNXC:TaskTiming 2026-07-20-10:00: rendered task totals include planning AI
 * segments while getActiveRuntimeMs intentionally remains execution-only. */
export function getTotalAgentActiveMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "cumulativePlanningMs" | "planningStartedAt">
    & Partial<Pick<Task, "firstExecutionAt" | "createdAt">>,
  nowMs: number,
  /** Resolved trait flags for the card's column; omitted keeps the legacy id. */
  columnFlags?: ColumnRoleFlags,
): number | null {
  const execution = getActiveRuntimeMs(task as never, nowMs, columnFlags) ?? 0;
  const planningStart = parseTimestampToMs(task.planningStartedAt);
  const planning = Math.max(0, task.cumulativePlanningMs ?? 0) + (planningStart != null ? Math.max(0, nowMs - planningStart) : 0);
  if (task.cumulativeActiveMs == null && task.cumulativePlanningMs == null && !(isWipColumnRole(columnFlags, task.column) && parseTimestampToMs(task.executionStartedAt) != null) && planningStart == null) {
    return null;
  }
  return clampRuntimeToWallClock(execution + planning, task.createdAt ?? task.firstExecutionAt, nowMs);
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

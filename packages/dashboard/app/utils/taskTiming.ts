import { isWipColumnRole, type ColumnRoleFlags } from "./columnRoles";
import type { Task, TaskLogEntry, WorkflowStepResult } from "@fusion/core";
import { getTaskLogEntryAction } from "./taskLogEntryDisplay";

/** Built-in Plan Review group id (`packages/core/src/workflows/builtin-plan-review-group.ts`). */
const PLAN_REVIEW_STEP_ID = "plan-review";

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

/*
FNXC:TaskPauseAccounting 2026-09-16-06:16:
FN-457 — the reader half of durable paused-time accounting. MUST stay byte-equivalent to
`packages/core/src/tasks/task-timing.ts`'s copy: these two implementations have drifted once before
(see the WorkflowLifecycleColumns note below), and the drift was only found by a visible production
defect.

Two rules, both load-bearing:
- Banked pause (`cumulativePausedMs`) is always subtracted.
- The OPEN segment (`pausedStartedAt`) is subtracted only while the card is actually paused. A
  `pausedStartedAt` on a card that is no longer paused is ORPHANED — written by a seam that cleared
  the park without closing the segment, or carried on a historical row. Subtracting it would grow
  without bound and drive the chip to zero, which is strictly worse than the wall clock this work
  replaced. This is the reader-side valve behind the writer-side census.
*/
function getPausedDeductionMs(
  task: Partial<Pick<Task, "cumulativePausedMs" | "pausedStartedAt" | "paused" | "userPaused">>,
  nowMs: number,
): number {
  const banked = Math.max(0, task.cumulativePausedMs ?? 0);
  const isPaused = task.paused === true || task.userPaused === true;
  if (!isPaused) return banked;
  const openedMs = parseTimestampToMs(task.pausedStartedAt);
  return banked + (openedMs == null ? 0 : Math.max(0, nowMs - openedMs));
}

export function getActiveRuntimeMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "columnMovedAt">
    & Partial<Pick<Task, "firstExecutionAt" | "createdAt" | "cumulativePausedMs" | "pausedStartedAt" | "paused" | "userPaused">>,
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
  // FN-457: pause is deducted from the execution bucket only — planning and verification have their own.
  const pausedMs = getPausedDeductionMs(task, nowMs);

  if (isWipColumnRole(columnFlags, task.column)) {
    const startedMs = parseTimestampToMs(task.executionStartedAt);
    if (startedMs != null) {
      const live = base + Math.max(0, nowMs - startedMs);
      return clampRuntimeToWallClock(Math.max(0, live - pausedMs), task.firstExecutionAt ?? task.createdAt, nowMs);
    }
  }

  if (persisted != null) {
    return clampRuntimeToWallClock(Math.max(0, Math.max(0, persisted) - pausedMs), task.firstExecutionAt ?? task.createdAt, nowMs);
  }

  return null;
}

/** FNXC:TaskTiming 2026-07-20-10:00: rendered task totals include planning AI
 * segments while getActiveRuntimeMs intentionally remains execution-only. */
export function getTotalAgentActiveMs(
  task: Pick<Task, "column" | "cumulativeActiveMs" | "executionStartedAt" | "cumulativePlanningMs" | "planningStartedAt">
    & Partial<Pick<Task, "firstExecutionAt" | "createdAt" | "cumulativePausedMs" | "pausedStartedAt" | "paused" | "userPaused">>,
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

/*
FNXC:TaskVerificationRuntime 2026-09-16-06:16:
FN-457 — the Verification bucket of the card's clock chip. NOT a sum of `workflowStepResults`: the
rule is "a gate whose wall clock runs OUTSIDE the two existing counters", and a naive sum
double-counts exactly two families, each proved by a writer in this repo:

1. PLAN REVIEW. The gate opens a `planningStartedAt` segment (proved by
   `packages/engine/src/__tests__/self-healing.test.ts` → "does not finalize a live graph Plan
   Review segment"), so its duration is ALREADY inside `cumulativePlanningMs`. Excluded both by
   `reviewKind: "plan"` and by the `plan-review` step id, because
   `executor/workflow-step-satisfaction.ts` reconstructs a legacy Plan Review row carrying neither
   `reviewKind` nor `source`.
2. SKILL NODE PROGRESS. `recordNodeProgressStart/Finish` in
   `packages/engine/src/workflows/workflow-graph-executor.ts` writes a `source: "node"` result for
   EVERY node carrying a `skillName` — implementation work in the wip lane, already inside
   `cumulativeActiveMs`. That writer ALWAYS stamps `source: "node"`, so keying the exclusion on it
   cannot be evaded by a legacy row.

Everything else that carries a real window is a gate running outside both counters and is KEPT:
code review, optional-group gates (browser verification and friends), ordinary custom pre-merge
prompt/script gates from `docs/workflow-steps.md` (written by `executor/run-graph-custom-node.ts`
with a phase and no `source`), and post-merge results.

Aggregation is an INTERVAL UNION rather than a sum: `foreach` instances and re-runs produce
overlapping windows, and summing them would inflate the bucket by the overlap.

An OPEN gate (`startedAt` with no `completedAt`) is skipped only when a LIVE WIP EXECUTION SEGMENT is
actually running (`liveWipSegmentCovers`), because that segment already covers the same wall clock —
the remediation case, where a bounce returned the card to implementation with a gate row still open.
With no live segment there is nothing covering it, so the open gate counts to `nowMs`; skipping it on
lane alone would silently erase the only timing a card with a running gate has.

`getWorkflowRuntimeMs` above is deliberately UNCHANGED: `TaskTokenStatsPanel` uses its naive per-step
sum for the step breakdown, which is a different question.
*/
export function getVerificationRuntimeMs(
  results: WorkflowStepResult[] | undefined,
  nowMs: number,
  options?: { liveWipSegmentCovers?: boolean },
): number {
  if (!results || results.length === 0) return 0;

  const intervals: Array<[number, number]> = [];
  for (const step of results) {
    // Skill-node progress already lives in cumulativeActiveMs.
    if (step.source === "node") continue;
    // Plan Review already lives in cumulativePlanningMs; never let it into this bucket.
    if (step.reviewKind === "plan" || step.workflowStepId === PLAN_REVIEW_STEP_ID) continue;

    const startedMs = parseTimestampToMs(step.startedAt);
    if (startedMs == null) continue;

    let endMs: number;
    if (step.completedAt) {
      const completedMs = parseTimestampToMs(step.completedAt);
      if (completedMs == null || completedMs < startedMs) continue;
      endMs = completedMs;
    } else {
      if (options?.liveWipSegmentCovers) continue;
      endMs = Math.max(startedMs, nowMs);
    }

    if (endMs > startedMs) intervals.push([startedMs, endMs]);
  }

  if (intervals.length === 0) return 0;

  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [spanStart, spanEnd] = intervals[0]!;
  for (const [start, end] of intervals.slice(1)) {
    if (start <= spanEnd) {
      spanEnd = Math.max(spanEnd, end);
      continue;
    }
    total += spanEnd - spanStart;
    spanStart = start;
    spanEnd = end;
  }
  return total + (spanEnd - spanStart);
}

/**
 * FNXC:TaskRuntimeBreakdown 2026-09-16-06:16:
 * FN-457 — the single source of truth behind the card's clock chip label AND its hover detail.
 *
 * Before this, the chip computed three different things depending on the lane: wall clock since
 * column entry in the wip lane (so waiting and pauses counted), planning + execution in
 * review/complete (so verification-gate time counted nowhere), and a third shape during merge. The
 * number was not comparable between two cards, which is the only thing an operator wants from it.
 *
 * The three buckets are DISJOINT by construction, so `planningMs + executionMs + verificationMs` is
 * the honest total and the tooltip's three lines add up to the label:
 *   planning     = cumulativePlanningMs + the live planning segment (includes the Plan Review gate)
 *   execution    = getActiveRuntimeMs, i.e. implementation work with pause already deducted
 *   verification = getVerificationRuntimeMs (allow-listed gates, interval-unioned) + live merge
 *
 * `totalMs` is clamped to the card's real wall-clock age, which can make it SMALLER than the sum of
 * the three buckets on a historically poisoned row. The clamp deficit is then charged to the
 * LARGEST bucket (see `scaleBreakdownToTotal`) so the displayed lines still sum to the displayed
 * label — one documented rule rather than three lanes' worth of ad-hoc behavior.
 *
 * Returns null when the card has no timing source at all, so the chip stays hidden exactly as before.
 */
export interface TaskRuntimeBreakdown {
  planningMs: number;
  executionMs: number;
  verificationMs: number;
  totalMs: number;
}

/** Charge a wall-clock clamp deficit to the largest bucket so the lines still sum to the label. */
function scaleBreakdownToTotal(planningMs: number, executionMs: number, verificationMs: number, totalMs: number): TaskRuntimeBreakdown {
  const sum = planningMs + executionMs + verificationMs;
  const deficit = sum - totalMs;
  if (deficit <= 0 || sum === 0) return { planningMs, executionMs, verificationMs, totalMs };

  const buckets = { planningMs, executionMs, verificationMs };
  const largest = (Object.keys(buckets) as Array<keyof typeof buckets>)
    .reduce((a, b) => (buckets[b] > buckets[a] ? b : a));
  buckets[largest] = Math.max(0, buckets[largest] - deficit);

  // A deficit larger than the biggest bucket would still leave the lines over the label; fall back
  // to proportional scaling so the invariant holds for any input.
  const adjusted = buckets.planningMs + buckets.executionMs + buckets.verificationMs;
  if (adjusted > totalMs) {
    const ratio = totalMs / adjusted;
    return {
      planningMs: Math.round(buckets.planningMs * ratio),
      executionMs: Math.round(buckets.executionMs * ratio),
      verificationMs: totalMs - Math.round(buckets.planningMs * ratio) - Math.round(buckets.executionMs * ratio),
      totalMs,
    };
  }
  return { ...buckets, totalMs };
}

export function getTaskRuntimeBreakdown(
  task: Task,
  nowMs: number,
  columnFlags?: ColumnRoleFlags,
  liveMergeElapsedMs?: number,
): TaskRuntimeBreakdown | null {
  const isWipLane = isWipColumnRole(columnFlags, task.column);

  const planningStartMs = parseTimestampToMs(task.planningStartedAt);
  const planningMs = Math.max(0, task.cumulativePlanningMs ?? 0)
    + (planningStartMs != null ? Math.max(0, nowMs - planningStartMs) : 0);

  const activeMs = getActiveRuntimeMs(task, nowMs, columnFlags);

  /* Only a RUNNING wip segment can absorb an open gate's wall clock; see getVerificationRuntimeMs. */
  const liveWipSegmentCovers = isWipLane && parseTimestampToMs(task.executionStartedAt) != null;

  let executionMs: number;
  let verificationMs = getVerificationRuntimeMs(task.workflowStepResults, nowMs, { liveWipSegmentCovers })
    + Math.max(0, liveMergeElapsedMs ?? 0);

  /*
  FALLBACK LADDER, preserved from the four helpers this replaced. Every rung below the first is a
  WALL-CLOCK WINDOW that already spans the gates, so it also forces `verificationMs` to 0 — the
  anti-double-count rule `getInstrumentedDurationMs` carried and the reason the old review/complete
  branch never added workflow runtime on top of the end-to-end window.
  */
  const legacyWindowMs = activeMs == null
    ? getEndToEndDurationMs(task.executionStartedAt, task.executionCompletedAt, nowMs)
    : null;

  if (activeMs != null) {
    executionMs = activeMs;
  } else if (legacyWindowMs != null) {
    // Legacy row with no cumulative accounting: the first-to-last execution window is all we have.
    executionMs = legacyWindowMs;
    verificationMs = 0;
  } else if (typeof task.timedExecutionMs === "number") {
    // The server aggregate is canonical and MAY already include workflow runtime.
    executionMs = Math.max(0, task.timedExecutionMs);
    verificationMs = 0;
  } else {
    executionMs = Math.max(0, getTimedDurationMs(task.log) ?? 0);
  }

  let usedLegacyColumnFallback = false;
  if (planningMs === 0 && executionMs === 0 && verificationMs === 0) {
    if (activeMs != null || legacyWindowMs != null || typeof task.timedExecutionMs === "number") {
      // Instrumented and genuinely zero: keep a real zero rather than inventing wall clock.
      return { planningMs: 0, executionMs: 0, verificationMs: 0, totalMs: 0 };
    }
    /* LAST RESORT, and wall clock by nature: a legacy row with no instrumentation at all would
       otherwise lose its chip entirely. Reached only when every timing source is absent. */
    if (!isWipLane) return null;
    const columnMs = parseTimestampToMs(task.columnMovedAt ?? task.updatedAt);
    if (columnMs == null) return null;
    executionMs = Math.max(0, nowMs - columnMs);
    usedLegacyColumnFallback = true;
  }

  const rawTotal = planningMs + executionMs + verificationMs;
  const totalMs = usedLegacyColumnFallback
    ? rawTotal
    : clampRuntimeToWallClock(rawTotal, task.createdAt ?? task.firstExecutionAt, nowMs);

  return scaleBreakdownToTotal(planningMs, executionMs, verificationMs, totalMs);
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

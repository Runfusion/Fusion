import type { ActivityLogEntry, RunAuditEvent } from "@fusion/core";

/**
 * Discovery notes (FN-4360):
 * - post-merge audit failures are not emitted via recordRunAuditEvent in merger post-merge audit path; represented as no-audit-coverage.
 * - FileScopeViolationError is thrown/handled in merger but no dedicated run_audit emission was found for invariant failures; represented as no-audit-coverage.
 * - recoverAlreadyMergedReviewTasks currently has no run_audit emission in self-healing; represented as no-audit-coverage.
 * - merge attempts are inferred from git-domain run_audit events with metadata.phase matching /^merge-attempt-/.
 */

export type NullMetricReason = "no-audit-coverage" | "insufficient-samples" | "no-in-review-entries";

export interface NullableMetric<T> {
  value: T | null;
  reason?: NullMetricReason;
}

export interface MergeAttemptsMetric {
  mean: number | null;
  max: number | null;
  histogram: Record<string, number>;
  reason?: NullMetricReason;
}

export interface InReviewDurationMetric {
  p50Ms: number | null;
  p95Ms: number | null;
  sampleCount: number;
  reason?: NullMetricReason;
}

export interface ReliabilityPerDayCounts {
  tasksEnteredInReview: number;
  tasksBouncedToInProgress: number;
  postMergeAuditFailures: { block: number; warn: number; off: number } | null;
  fileScopeInvariantFailures: number | null;
  recoverAlreadyMergedReviewTasksRecoveries: number | null;
}

const DAY_MS = 86_400_000;

export function bucketByDay(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function inWindow(timestamp: string, startMs: number, endMs: number): boolean {
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
}

function metadataColumn(entry: ActivityLogEntry, key: "from" | "to"): string | undefined {
  const raw = entry.metadata?.[key];
  return typeof raw === "string" ? raw : undefined;
}

function collectTaskMovedEvents(activity: ActivityLogEntry[], startMs: number, endMs: number): ActivityLogEntry[] {
  return activity.filter((entry) => entry.type === "task:moved" && inWindow(entry.timestamp, startMs, endMs));
}

function incrementDayCount(counts: Record<string, number>, day: string): void {
  counts[day] = (counts[day] ?? 0) + 1;
}

/*
FNXC:ReliabilityMetrics 2026-07-30-03:10 DELIBERATE-LITERAL: historical log values, not live columns.
These ids come from `metadataColumn(entry, ...)` — the `from`/`to` recorded ON A PAST MOVE EVENT in
the activity log. They are not a question about a task's current column, so there is no workflow to
resolve them against: the event was written under whatever the board looked like at the time, and a
column renamed since leaves every older entry carrying the OLD id forever.

Converting these to a trait read would ask "what role does the column named X play TODAY?" about a
record written months ago, possibly under a different workflow — which is a different question with
a different answer, and it would silently drop history from the metric rather than improve it.

The correct fix for renamed boards is at the WRITER (record a role alongside the id when the event is
emitted), not at this reader. Until events carry that, matching the recorded literal is the only
answer that keeps old data in the series.
*/
export function tasksEnteredInReviewPerDay(activity: ActivityLogEntry[], startMs: number, endMs: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of collectTaskMovedEvents(activity, startMs, endMs)) {
    if (metadataColumn(entry, "to") === "in-review") {
      incrementDayCount(counts, bucketByDay(entry.timestamp));
    }
  }
  return counts;
}

/* FNXC:ReliabilityMetrics 2026-07-30-03:10 DELIBERATE-LITERAL: historical log values — `from`/`to`
   as RECORDED on a past move event, matched as recorded. Full reasoning above
   `tasksEnteredInReviewPerDay`. */
export function tasksBouncedToInProgressPerDay(activity: ActivityLogEntry[], startMs: number, endMs: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of collectTaskMovedEvents(activity, startMs, endMs)) {
    if (metadataColumn(entry, "from") === "in-review" && metadataColumn(entry, "to") === "in-progress") {
      incrementDayCount(counts, bucketByDay(entry.timestamp));
    }
  }
  return counts;
}

export function postMergeAuditFailuresPerDay(_events: RunAuditEvent[], _startMs: number, _endMs: number): NullableMetric<Record<string, { block: number; warn: number; off: number }>> {
  return { value: null, reason: "no-audit-coverage" };
}

export function fileScopeInvariantFailuresPerDay(_events: RunAuditEvent[], _startMs: number, _endMs: number): NullableMetric<Record<string, number>> {
  return { value: null, reason: "no-audit-coverage" };
}

export function recoverAlreadyMergedReviewTasksRecoveriesPerDay(_events: RunAuditEvent[], _startMs: number, _endMs: number): NullableMetric<Record<string, number>> {
  return { value: null, reason: "no-audit-coverage" };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))] ?? 0;
}

/* FNXC:ReliabilityMetrics 2026-07-30-03:10 DELIBERATE-LITERAL: historical log values — `from`/`to`
   as RECORDED on a past move event, matched as recorded. Full reasoning above
   `tasksEnteredInReviewPerDay`. */
export function inReviewDurationMetrics(activity: ActivityLogEntry[], startMs: number, endMs: number): InReviewDurationMetric {
  const moved = activity
    .filter((entry) => entry.type === "task:moved")
    .map((entry) => ({ entry, ms: new Date(entry.timestamp).getTime() }))
    .filter((item) => Number.isFinite(item.ms))
    .sort((a, b) => a.ms - b.ms);

  const latestInReviewEntryByTask = new Map<string, number>();
  const durations: number[] = [];

  for (const { entry, ms } of moved) {
    const taskId = entry.taskId;
    if (!taskId) {
      continue;
    }

    const from = metadataColumn(entry, "from");
    const to = metadataColumn(entry, "to");

    if (to === "in-review") {
      latestInReviewEntryByTask.set(taskId, ms);
      continue;
    }

    if (from === "in-review" && to === "done" && ms >= startMs && ms <= endMs) {
      const start = latestInReviewEntryByTask.get(taskId);
      if (typeof start === "number" && ms >= start) {
        durations.push(ms - start);
      }
    }
  }

  if (durations.length < 3) {
    return { p50Ms: null, p95Ms: null, sampleCount: durations.length, reason: "insufficient-samples" };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    sampleCount: sorted.length,
  };
}

export function mergeAttemptsPerMergedTask(events: RunAuditEvent[], mergedTaskIds: Set<string>, startMs: number, endMs: number): MergeAttemptsMetric {
  const phasesByTask = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.domain !== "git" || !event.taskId || !inWindow(event.timestamp, startMs, endMs)) {
      continue;
    }
    const phaseRaw = event.metadata?.phase;
    if (typeof phaseRaw !== "string" || !/^merge-attempt-/.test(phaseRaw)) {
      continue;
    }

    const taskPhases = phasesByTask.get(event.taskId) ?? new Set<string>();
    taskPhases.add(phaseRaw);
    phasesByTask.set(event.taskId, taskPhases);
  }

  const attemptCounts = Array.from(phasesByTask.entries())
    .filter(([taskId]) => mergedTaskIds.has(taskId))
    .map(([, phases]) => phases.size);

  if (attemptCounts.length === 0) {
    return { mean: null, max: null, histogram: {}, reason: "no-audit-coverage" };
  }

  const total = attemptCounts.reduce((sum, count) => sum + count, 0);
  const max = Math.max(...attemptCounts);
  const histogram: Record<string, number> = {};

  for (const count of attemptCounts) {
    const key = count > 5 ? ">5" : String(count);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }

  return {
    mean: total / attemptCounts.length,
    max,
    histogram,
  };
}

export function dayHasSamples(counts: ReliabilityPerDayCounts): boolean {
  if (counts.tasksEnteredInReview > 0 || counts.tasksBouncedToInProgress > 0) {
    return true;
  }

  if (counts.postMergeAuditFailures) {
    const { block, warn, off } = counts.postMergeAuditFailures;
    if (block + warn + off > 0) {
      return true;
    }
  }

  return (counts.fileScopeInvariantFailures ?? 0) > 0 || (counts.recoverAlreadyMergedReviewTasksRecoveries ?? 0) > 0;
}

export function inReviewFailureRate7d(enteredByDay: Record<string, number>, bouncedByDay: Record<string, number>, endMs: number): NullableMetric<number> {
  let entered = 0;
  let bounced = 0;

  for (let i = 0; i < 7; i += 1) {
    const day = new Date(endMs - i * DAY_MS).toISOString().slice(0, 10);
    entered += enteredByDay[day] ?? 0;
    bounced += bouncedByDay[day] ?? 0;
  }

  if (entered === 0) {
    return { value: null, reason: "no-in-review-entries" };
  }

  return { value: bounced / entered };
}

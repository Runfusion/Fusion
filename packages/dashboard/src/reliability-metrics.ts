import type { ActivityLogEntry, RunAuditEvent } from "@fusion/core";
import { resolveProjectColumnsForRoles, REVIEW_ROLES } from "@fusion/core";

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

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:55 (#2875 review — greptile P1, "resolved lanes discarded
downstream"): THE PRODUCER WAS CONVERTED AND THIS CONSUMER THREW THE ANSWER AWAY.

`getInReviewDurationEvents` now fetches moves using the project's RESOLVED review lanes, and this
function then matched `to === "in-review"` and `to === "done"` against them. On a renamed board every
fetched event was discarded, the sample count stayed under three, and the Reliability panel reported
`insufficient-samples` forever — a metric that is silently absent rather than visibly wrong, which is
why nothing surfaced it.

The lane sets are OPTIONAL and the production caller supplies them: `server.ts` already resolves
`reviewLanes` for `countEntriesInto`/`countBouncesOut` two statements above this call, so wiring costs
no extra read. Omitted, the legacy ids answer — the documented degraded path for the pure function's
own tests, not a floor anything in production takes.
*/
export function inReviewDurationMetrics(
  activity: ActivityLogEntry[],
  startMs: number,
  endMs: number,
  lanes?: { review?: ReadonlySet<string>; complete?: ReadonlySet<string> },
): InReviewDurationMetric {
  const reviewLanes = lanes?.review ?? new Set(["in-review"]);
  const completeLanes = lanes?.complete ?? new Set(["done"]);
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

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:30 (#2875 review — greptile P1, "internal review moves
    reset duration"): ENTERING REVIEW IS A CROSSING, NOT AN ARRIVAL.

    A board may declare several review-role lanes — merge orchestration beside a human sign-off lane —
    and a card moving BETWEEN them has not re-entered review. Overwriting the timestamp on every move
    whose destination is a review lane made the metric measure only the LAST lane, so the number shrank
    exactly on the boards that review most carefully. It read plausible, which is why it needed the
    review to find.

    The start is therefore recorded only when the card was NOT already in a review lane. An unknown
    `from` (absent metadata) still records, because a first observation with no prior lane is an entry
    as far as this data can tell — dropping it would lose the sample entirely, which is worse than
    dating it slightly late.
    */
    if (to !== undefined && reviewLanes.has(to)) {
      const alreadyInReview = from !== undefined && reviewLanes.has(from);
      if (!alreadyInReview) latestInReviewEntryByTask.set(taskId, ms);
      continue;
    }

    if (from !== undefined && to !== undefined
      && reviewLanes.has(from) && completeLanes.has(to)
      && ms >= startMs && ms <= endMs) {
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

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-17:05:
Per-day move counts across a SET of lanes, because `getTaskMovedCountsByDay` takes one column a side.

The Reliability headline was built from two queries naming `in-review` and `in-progress`. On a board
that renamed either, both return `{}` — so `tasksEnteredInReview` and `tasksBouncedToInProgress` are
zero for every day and `inReviewFailureRate7d` divides one zero by another and reports healthy. That
is the worst shape this class takes: it produces a NUMBER, not an error, and the number is reassuring.

WHY A UNION IS RIGHT HERE AND NOT A COMPROMISE. These read MOVE HISTORY, and a past move recorded the
column name as it was at the time — the same reasoning that keeps `tasksEnteredInReviewPerDay` above
matching recorded values verbatim. A board renamed last month therefore has old rows under the old id
and new rows under the new one, so the correct query covers BOTH. `resolveProjectColumnsForRoles`
always unions the legacy id in, which is exactly that set. Asking for either name alone is what is
broken today.

Summing across pairs cannot double-count: a move event has exactly one (from, to) pair, so the
queries partition the events rather than overlapping. On the built-in board this issues the same two
queries as before.
*/
export interface MovedCountsStore {
  getTaskMovedCountsByDay(options: { since: string; until: string; fromColumn?: string; toColumn?: string }): Promise<Record<string, number>>;
}

function mergeDayCounts(into: Record<string, number>, from: Record<string, number>): Record<string, number> {
  for (const [day, count] of Object.entries(from)) into[day] = (into[day] ?? 0) + count;
  return into;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-18:20 (#2861 review — greptile P1 and P2, both right):
ENTRIES INTO THE SET, not moves into its members; and the reads run concurrently.

P1, and it is a defect the single-lane version could not have: a board with two review-role lanes
(`signoff` and `waiting`, say) has moves BETWEEN them, and counting only by destination scores
`signoff -> waiting` as another entry into review. That inflates the denominator while the bounce
count is unchanged, so the headline UNDERSTATES the review-failure rate — a metric that is wrong in
the reassuring direction, which is the same failure this whole change set is about. Generalising a
one-lane query to a set introduced a question one lane never had to answer.

The subtraction is skipped when there is only one lane, because a move requires the column to change
so there are no intra-set moves to remove. That keeps the built-in board at exactly the queries it
had before rather than paying for a case it cannot have.

P2: the per-pair reads are independent, so they run under `Promise.all` rather than sequentially.
Latency is now one round trip deep instead of N + NxM.
*/

/** Moves into any of `toColumns`, summed per day. */
export async function countMovesInto(
  store: MovedCountsStore,
  window: { since: string; until: string },
  toColumns: ReadonlySet<string>,
): Promise<Record<string, number>> {
  const results = await Promise.all(
    [...toColumns].map((toColumn) => store.getTaskMovedCountsByDay({ ...window, toColumn })),
  );
  return results.reduce<Record<string, number>>((acc, counts) => mergeDayCounts(acc, counts), {});
}

/**
 * Moves into the lane SET from outside it — the "entered review" shape.
 *
 * Subtracts moves BETWEEN members, which are not entries. No-op for a single-lane set.
 */
export async function countEntriesInto(
  store: MovedCountsStore,
  window: { since: string; until: string },
  lanes: ReadonlySet<string>,
): Promise<Record<string, number>> {
  const [into, within] = await Promise.all([
    countMovesInto(store, window, lanes),
    lanes.size > 1 ? countBouncesOut(store, window, lanes, lanes) : Promise.resolve<Record<string, number>>({}),
  ]);
  for (const [day, count] of Object.entries(within)) {
    const remaining = (into[day] ?? 0) - count;
    if (remaining > 0) into[day] = remaining;
    else delete into[day];
  }
  return into;
}

/** Moves OUT of any `fromColumns` into any `toColumns` — the review-bounce shape — summed per day. */
export async function countBouncesOut(
  store: MovedCountsStore,
  window: { since: string; until: string },
  fromColumns: ReadonlySet<string>,
  toColumns: ReadonlySet<string>,
): Promise<Record<string, number>> {
  const pairs = [...fromColumns].flatMap((fromColumn) => [...toColumns].map((toColumn) => ({ fromColumn, toColumn })));
  const results = await Promise.all(
    pairs.map((pair) => store.getTaskMovedCountsByDay({ ...window, ...pair })),
  );
  return results.reduce<Record<string, number>>((acc, counts) => mergeDayCounts(acc, counts), {});
}

/**
 * FNXC:WorkflowResolvedColumns 2026-07-31-23:55:
 * The Reliability endpoint's three lane reads, behind one seam.
 *
 * WHY THIS EXISTS. These resolves lived inline in the `/api/health/reliability` route closure, which
 * has no route-level test — the only way in was booting `createServer` behind a mock-the-world
 * shell, which the slow-test rule forbids. So all three were UNCOVERED and unpinnable: blinding any
 * of them left the whole dashboard suite green. `reliability-metrics.test.ts` looks like it covers
 * them and does not — it exercises the collaborators (`countEntriesInto` and friends) with lane sets
 * passed in by hand, which can never fail when the CALLER's resolve is blinded.
 *
 * This function is that missing caller-side seam: it resolves, so a test of it fails when a resolve
 * is blinded.
 *
 * WHAT THE LANES MEAN. `review` and `wip` are the two sides of the entered/bounced counts;
 * `complete` is the other half of the review -> done transition the duration metric measures.
 * Keyed on literals, a renamed board returned {} from every query, so the headline divided one zero
 * by another and reported a healthy rate — a NUMBER, not an error, saying everything is fine.
 */
export async function resolveReliabilityLanes(
  store: Parameters<typeof resolveProjectColumnsForRoles>[0],
): Promise<{ review: ReadonlySet<string>; wip: ReadonlySet<string>; complete: ReadonlySet<string> }> {
  const [review, wip, complete] = await Promise.all([
    resolveProjectColumnsForRoles(store, REVIEW_ROLES),
    resolveProjectColumnsForRoles(store, ["countsTowardWip"]),
    resolveProjectColumnsForRoles(store, ["complete"]),
  ]);
  return { review, wip, complete };
}

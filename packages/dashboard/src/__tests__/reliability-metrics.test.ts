import { describe, expect, it, vi } from "vitest";

import type { ActivityLogEntry, RunAuditEvent } from "@fusion/core";

import {
  bucketByDay,
  countBouncesOut,
  countMovesInto,
  dayHasSamples,
  fileScopeInvariantFailuresPerDay,
  inReviewDurationMetrics,
  inReviewFailureRate7d,
  mergeAttemptsPerMergedTask,
  postMergeAuditFailuresPerDay,
  recoverAlreadyMergedReviewTasksRecoveriesPerDay,
  tasksBouncedToInProgressPerDay,
  tasksEnteredInReviewPerDay,
} from "../reliability-metrics";

function moved(timestamp: string, taskId: string, from: string, to: string): ActivityLogEntry {
  return { id: `${taskId}-${timestamp}`, timestamp, type: "task:moved", taskId, details: "moved", metadata: { from, to } };
}

describe("reliability-metrics", () => {
  it("buckets timestamps by UTC day", () => {
    expect(bucketByDay("2026-05-13T23:59:59.000Z")).toBe("2026-05-13");
  });

  it("counts in-review entries and bounces per day", () => {
    const activity: ActivityLogEntry[] = [
      moved("2026-05-11T10:00:00.000Z", "FN-1", "todo", "in-review"),
      moved("2026-05-11T11:00:00.000Z", "FN-2", "in-review", "in-progress"),
      moved("2026-05-12T12:00:00.000Z", "FN-3", "todo", "in-review"),
    ];
    const start = Date.parse("2026-05-10T00:00:00.000Z");
    const end = Date.parse("2026-05-13T00:00:00.000Z");

    expect(tasksEnteredInReviewPerDay(activity, start, end)).toEqual({ "2026-05-11": 1, "2026-05-12": 1 });
    expect(tasksBouncedToInProgressPerDay(activity, start, end)).toEqual({ "2026-05-11": 1 });
  });

  it("returns no-audit-coverage for audit-gap metrics", () => {
    const events: RunAuditEvent[] = [];
    const start = Date.parse("2026-05-10T00:00:00.000Z");
    const end = Date.parse("2026-05-13T00:00:00.000Z");

    expect(postMergeAuditFailuresPerDay(events, start, end)).toEqual({ value: null, reason: "no-audit-coverage" });
    expect(fileScopeInvariantFailuresPerDay(events, start, end)).toEqual({ value: null, reason: "no-audit-coverage" });
    expect(recoverAlreadyMergedReviewTasksRecoveriesPerDay(events, start, end)).toEqual({ value: null, reason: "no-audit-coverage" });
  });

  it("computes in-review duration percentiles", () => {
    const activity: ActivityLogEntry[] = [
      moved("2026-05-10T10:00:00.000Z", "FN-1", "todo", "in-review"),
      moved("2026-05-10T11:00:00.000Z", "FN-1", "in-review", "done"),
      moved("2026-05-10T12:00:00.000Z", "FN-2", "todo", "in-review"),
      moved("2026-05-10T14:00:00.000Z", "FN-2", "in-review", "done"),
      moved("2026-05-10T15:00:00.000Z", "FN-3", "todo", "in-review"),
      moved("2026-05-10T18:00:00.000Z", "FN-3", "in-review", "done"),
    ];

    const metric = inReviewDurationMetrics(
      activity,
      Date.parse("2026-05-10T00:00:00.000Z"),
      Date.parse("2026-05-11T00:00:00.000Z"),
    );

    expect(metric.sampleCount).toBe(3);
    expect(metric.p50Ms).toBe(2 * 60 * 60 * 1000);
    expect(metric.p95Ms).toBe(3 * 60 * 60 * 1000);
  });

  it("returns insufficient-samples when too few review exits", () => {
    const activity: ActivityLogEntry[] = [
      moved("2026-05-10T10:00:00.000Z", "FN-1", "todo", "in-review"),
      moved("2026-05-10T11:00:00.000Z", "FN-1", "in-review", "done"),
    ];

    expect(
      inReviewDurationMetrics(activity, Date.parse("2026-05-10T00:00:00.000Z"), Date.parse("2026-05-11T00:00:00.000Z")),
    ).toEqual({ p50Ms: null, p95Ms: null, sampleCount: 1, reason: "insufficient-samples" });
  });

  it("computes merge attempts per merged task", () => {
    const events: RunAuditEvent[] = [
      {
        id: "1",
        timestamp: "2026-05-10T10:00:00.000Z",
        taskId: "FN-1",
        agentId: "a",
        runId: "r1",
        domain: "git",
        mutationType: "merge:start",
        target: "FN-1",
        metadata: { phase: "merge-attempt-1" },
      },
      {
        id: "2",
        timestamp: "2026-05-10T10:01:00.000Z",
        taskId: "FN-1",
        agentId: "a",
        runId: "r1",
        domain: "git",
        mutationType: "merge:start",
        target: "FN-1",
        metadata: { phase: "merge-attempt-2" },
      },
      {
        id: "3",
        timestamp: "2026-05-10T10:00:00.000Z",
        taskId: "FN-2",
        agentId: "a",
        runId: "r2",
        domain: "git",
        mutationType: "merge:start",
        target: "FN-2",
        metadata: { phase: "merge-attempt-1" },
      },
    ];

    const mergedTaskIds = new Set(["FN-1", "FN-2"]);

    const metric = mergeAttemptsPerMergedTask(events, mergedTaskIds, Date.parse("2026-05-10T00:00:00.000Z"), Date.parse("2026-05-11T00:00:00.000Z"));
    expect(metric.mean).toBe(1.5);
    expect(metric.max).toBe(2);
    expect(metric.histogram).toEqual({ "1": 1, "2": 1 });
  });

  it("returns no-audit-coverage when merge attempts cannot be inferred", () => {
    const metric = mergeAttemptsPerMergedTask([], new Set<string>(), Date.parse("2026-05-10T00:00:00.000Z"), Date.parse("2026-05-11T00:00:00.000Z"));
    expect(metric).toEqual({ mean: null, max: null, histogram: {}, reason: "no-audit-coverage" });
  });

  it("computes in-review failure rate and null reason", () => {
    const endMs = Date.parse("2026-05-13T00:00:00.000Z");
    expect(inReviewFailureRate7d({ "2026-05-13": 10 }, { "2026-05-13": 2 }, endMs)).toEqual({ value: 0.2 });
    expect(inReviewFailureRate7d({}, {}, endMs)).toEqual({ value: null, reason: "no-in-review-entries" });
  });

  it("returns no-in-review-entries when all seven days are empty", () => {
    const endMs = Date.parse("2026-05-13T00:00:00.000Z");
    expect(inReviewFailureRate7d({ "2026-05-13": 0, "2026-05-12": 0 }, { "2026-05-13": 0 }, endMs)).toEqual({
      value: null,
      reason: "no-in-review-entries",
    });
  });

  it("filters task movement counts by start/end window", () => {
    const activity: ActivityLogEntry[] = [
      moved("2026-05-10T23:59:59.000Z", "FN-1", "todo", "in-review"),
      moved("2026-05-11T00:00:00.000Z", "FN-2", "todo", "in-review"),
      moved("2026-05-12T00:00:00.000Z", "FN-3", "in-review", "in-progress"),
    ];

    const start = Date.parse("2026-05-11T00:00:00.000Z");
    const end = Date.parse("2026-05-12T00:00:00.000Z");

    expect(tasksEnteredInReviewPerDay(activity, start, end)).toEqual({ "2026-05-11": 1 });
    expect(tasksBouncedToInProgressPerDay(activity, start, end)).toEqual({ "2026-05-12": 1 });
  });

  it("reports hasSamples semantics for per-day rows", () => {
    expect(dayHasSamples({
      tasksEnteredInReview: 0,
      tasksBouncedToInProgress: 0,
      postMergeAuditFailures: null,
      fileScopeInvariantFailures: null,
      recoverAlreadyMergedReviewTasksRecoveries: null,
    })).toBe(false);

    expect(dayHasSamples({
      tasksEnteredInReview: 0,
      tasksBouncedToInProgress: 1,
      postMergeAuditFailures: null,
      fileScopeInvariantFailures: null,
      recoverAlreadyMergedReviewTasksRecoveries: null,
    })).toBe(true);

    expect(dayHasSamples({
      tasksEnteredInReview: 0,
      tasksBouncedToInProgress: 0,
      postMergeAuditFailures: { block: 0, warn: 1, off: 0 },
      fileScopeInvariantFailures: 0,
      recoverAlreadyMergedReviewTasksRecoveries: 0,
    })).toBe(true);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-17:05:

THE INVARIANT: the Reliability move counts cover every lane that carries the role, old name and new.

The route issued two queries naming `in-review` and `in-progress`. On a board that renamed either,
both return `{}`, every per-day count is zero, and `inReviewFailureRate7d` divides one zero by
another and reports a healthy rate. A metric that answers with a REASSURING NUMBER instead of an
error is the worst shape this class takes — an operator has no reason to suspect it is blind.

The union covers history as well as the present, which matters because these read MOVE RECORDS: a
board renamed last month has old rows under the old id and new rows under the new one. Asking for
either name alone is what is broken today, not a trade-off between them.

REVERT PROOF, measured: replace the sets with the single literals and the renamed-lane cases fail
with `expected {} to deeply equal { '2026-07-01': 2 }`.
*/
describe("reliability move counts span every lane carrying the role", () => {
  const store = (rows: Record<string, Record<string, number>>) => ({
    getTaskMovedCountsByDay: vi.fn(async (o: { fromColumn?: string; toColumn?: string }) =>
      rows[`${o.fromColumn ?? ""}->${o.toColumn ?? ""}`] ?? {}),
  });

  const WINDOW = { since: "2026-07-01T00:00:00.000Z", until: "2026-07-08T00:00:00.000Z" };

  it("sums entries across a renamed review lane and the legacy one", async () => {
    // A board mid-rename: old move rows under `in-review`, new ones under `signoff`.
    const counts = await countMovesInto(
      store({ "->in-review": { "2026-07-01": 1 }, "->signoff": { "2026-07-01": 1, "2026-07-02": 3 } }) as never,
      WINDOW,
      new Set(["in-review", "signoff"]),
    );

    expect(counts).toEqual({ "2026-07-01": 2, "2026-07-02": 3 });
  });

  it("sums bounces across every (review, wip) pair without double-counting", async () => {
    // Each move event has exactly one (from, to) pair, so the queries partition rather than overlap.
    const counts = await countBouncesOut(
      store({
        "in-review->in-progress": { "2026-07-01": 1 },
        "signoff->building": { "2026-07-01": 1 },
        "signoff->in-progress": { "2026-07-03": 5 },
      }) as never,
      WINDOW,
      new Set(["in-review", "signoff"]),
      new Set(["in-progress", "building"]),
    );

    expect(counts).toEqual({ "2026-07-01": 2, "2026-07-03": 5 });
  });

  it("issues exactly the two legacy queries on the built-in board", async () => {
    // The common path must not get more expensive to fix the uncommon one.
    const entered = store({ "->in-review": { "2026-07-01": 4 } });
    const bounced = store({ "in-review->in-progress": { "2026-07-01": 1 } });

    expect(await countMovesInto(entered as never, WINDOW, new Set(["in-review"]))).toEqual({ "2026-07-01": 4 });
    expect(await countBouncesOut(bounced as never, WINDOW, new Set(["in-review"]), new Set(["in-progress"]))).toEqual({ "2026-07-01": 1 });
    expect(entered.getTaskMovedCountsByDay).toHaveBeenCalledTimes(1);
    expect(bounced.getTaskMovedCountsByDay).toHaveBeenCalledTimes(1);
  });

  it("returns an empty map rather than throwing when no lane is supplied", async () => {
    expect(await countMovesInto(store({}) as never, WINDOW, new Set())).toEqual({});
  });
});

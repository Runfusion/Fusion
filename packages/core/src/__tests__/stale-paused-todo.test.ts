import { describe, expect, it } from "vitest";
import { DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS, getStalePausedTodoSignal } from "../stale-paused-todo.js";

const NOW = Date.parse("2026-05-14T12:00:00.000Z");

const baseTask = {
  column: "todo" as const,
  paused: true,
  columnMovedAt: new Date(NOW - DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS).toISOString(),
  updatedAt: new Date(NOW - DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS).toISOString(),
  pausedReason: "manual-hold",
  pausedByAgentId: "agent-1",
};

describe("getStalePausedTodoSignal", () => {
  it("returns signal for paused todo older than threshold", () => {
    const signal = getStalePausedTodoSignal({ ...baseTask }, { now: NOW });
    expect(signal?.code).toBe("stale-paused-todo");
    expect(signal?.ageMs).toBe(DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS);
    expect(signal?.thresholdMs).toBe(DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS);
  });

  it("returns undefined when not paused", () => {
    expect(getStalePausedTodoSignal({ ...baseTask, paused: false }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined for non-todo columns", () => {
    expect(getStalePausedTodoSignal({ ...baseTask, column: "in-progress" }, { now: NOW })).toBeUndefined();
    expect(getStalePausedTodoSignal({ ...baseTask, column: "in-review" }, { now: NOW })).toBeUndefined();
  });

  it("returns undefined when age is under threshold", () => {
    const signal = getStalePausedTodoSignal(
      { ...baseTask, columnMovedAt: new Date(NOW - DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS + 1).toISOString() },
      { now: NOW },
    );
    expect(signal).toBeUndefined();
  });

  it("respects custom threshold override", () => {
    const signal = getStalePausedTodoSignal({ ...baseTask }, { now: NOW, thresholdMs: DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS + 1_000 });
    expect(signal).toBeUndefined();
  });

  it("returns undefined when threshold is zero or negative", () => {
    expect(getStalePausedTodoSignal({ ...baseTask }, { now: NOW, thresholdMs: 0 })).toBeUndefined();
    expect(getStalePausedTodoSignal({ ...baseTask }, { now: NOW, thresholdMs: -1 })).toBeUndefined();
  });

  it("suppresses signal during activation grace warmup", () => {
    const signal = getStalePausedTodoSignal({ ...baseTask }, {
      now: NOW,
      engineActiveSinceMs: NOW - 60_000,
      engineActivationGraceMs: 5 * 60_000,
    });
    expect(signal).toBeUndefined();
  });

  it("fires once activation floor is sufficiently in the past", () => {
    const signal = getStalePausedTodoSignal({ ...baseTask }, {
      now: NOW,
      engineActiveSinceMs: NOW - DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS - 5_000,
      engineActivationGraceMs: 0,
    });
    expect(signal?.code).toBe("stale-paused-todo");
    expect(signal?.ageMs).toBe(DEFAULT_STALE_PAUSED_TODO_THRESHOLD_MS);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-27-21:30 (Phase B / U6 — vocabulary conversion):
RED-GREEN PROOF for the hold-column guard in `getStalePausedTodoSignal`.

Written BEFORE the conversion and asserted to FAIL against the literal `"todo"`
implementation. That ordering is the whole point of this phase: a guard converted
first and tested after proves nothing, because a guard that silently stops
matching disables its recovery path without failing anything — which is how 82
dead column guards passed a merge gate before this program existed.

The signal detects a card that has sat PAUSED in the capacity-hold column past a
threshold. "Hold column" is the lifecycle role; `todo` is merely the id the
built-in coding workflow happens to give it. A workflow that names its hold
column `drafting` has exactly the same stall condition and must produce exactly
the same signal.
*/
describe("getStalePausedTodoSignal — hold column is resolved, not literal (U6)", () => {
  const staleAnchor = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  const pausedCard = (column: string) => ({
    column,
    paused: true as const,
    columnMovedAt: staleAnchor,
    updatedAt: staleAnchor,
    pausedReason: "operator",
    pausedByAgentId: undefined,
  });

  it("fires for the DEFAULT workflow's hold column (regression floor)", () => {
    expect(getStalePausedTodoSignal(pausedCard("todo"))).toMatchObject({
      code: "stale-paused-todo",
    });
  });

  it("fires for a RENAMED hold column when the caller resolves it", () => {
    // THE conversion assertion. Fails against the literal implementation.
    expect(
      getStalePausedTodoSignal(pausedCard("drafting"), { holdColumn: "drafting" }),
    ).toMatchObject({ code: "stale-paused-todo" });
  });

  it("does NOT fire for a non-hold column in a renamed workflow", () => {
    // The other half: conversion must not make the guard match everything.
    expect(
      getStalePausedTodoSignal(pausedCard("writing"), { holdColumn: "drafting" }),
    ).toBeUndefined();
  });

  it("does NOT fire for the legacy id when the workflow's hold column is different", () => {
    // Proves the guard follows the WORKFLOW, not the legacy vocabulary: a card
    // parked in `todo` under a workflow whose hold column is `drafting` is not
    // stalled-in-hold, it is sitting in some other column entirely.
    expect(
      getStalePausedTodoSignal(pausedCard("todo"), { holdColumn: "drafting" }),
    ).toBeUndefined();
  });
});

/*
FNXC:MergeReliability 2026-07-15-21:55 (FN-8004 follow-up):
`isStaleMergeActiveStatus` is the SINGLE definition of "orphaned merge-active stamp", shared by
SelfHealingManager.recoverStaleMergingStatus (which clears it automatically) and the dashboard's
manual Retry gate (which must not refuse a task no merger owns).

Before the split those two disagreed: the sweep recovered stale stamps after a bounded delay, but
manual Retry rejected EVERY merge-active status outright ("Task is not in a retryable state
(current status: landing)"). So a merger killed mid-flight — crash, engine restart, operator
SIGTERM — left a stamp only the sweep could clear, blocking the operator's escape hatch exactly
when it was needed. Observed on FN-8004.

The safety-critical invariant, asserted below: a LIVE merge is never classified stale, because a
live merger either holds the in-process lease or keeps refreshing `updatedAt`. Both signals must
independently block staleness — the manual gate leans on this to avoid yanking a running merge.
*/
import { describe, expect, it } from "vitest";
import {
  ACTIVE_MERGE_STATUSES,
  DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS,
  isMergeActiveStatus,
  isStaleMergeActiveStatus,
} from "../merge-active-status.js";

const NOW = Date.parse("2026-07-16T00:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
/** Comfortably past the staleness floor. */
const LONG_AGO = ago(DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS + 60_000);

const task = (over: Partial<{ id: string; status: string | null; updatedAt: string }> = {}) => ({
  id: "FN-1",
  status: "landing",
  updatedAt: LONG_AGO,
  ...over,
});

describe("isMergeActiveStatus", () => {
  it("covers every phase a merger can die in", () => {
    // reviewing/landing are as reclaimable as merging — a process killed in either
    // leaves the identical orphaned stamp. FN-8004 died in `landing`.
    for (const s of ["merging", "merging-pr", "merging-fix", "reviewing", "landing"]) {
      expect(isMergeActiveStatus(s)).toBe(true);
      expect(ACTIVE_MERGE_STATUSES.has(s)).toBe(true);
    }
  });

  it("does not treat terminal or absent statuses as merge-active", () => {
    for (const s of ["failed", "stuck-killed", "needs-replan", null, undefined, ""]) {
      expect(isMergeActiveStatus(s as string | null | undefined)).toBe(false);
    }
  });
});

describe("isStaleMergeActiveStatus — the FN-8004 wedge", () => {
  it("classifies an orphaned `landing` stamp as stale so manual Retry is unblocked", () => {
    expect(isStaleMergeActiveStatus(task(), { nowMs: NOW })).toBe(true);
  });

  it("classifies every merge-active phase as stale once orphaned", () => {
    for (const status of [...ACTIVE_MERGE_STATUSES]) {
      expect(isStaleMergeActiveStatus(task({ status }), { nowMs: NOW })).toBe(true);
    }
  });

  it("NEVER classifies a task holding the live in-process merge lease as stale", () => {
    // Safety invariant: a live owner must be protected no matter how old updatedAt looks.
    expect(
      isStaleMergeActiveStatus(task({ id: "FN-1" }), { activeMergeTaskId: "FN-1", nowMs: NOW }),
    ).toBe(false);
  });

  it("still classifies a stale task when a DIFFERENT task holds the lease", () => {
    // The lease only protects its own owner; an unrelated live merge must not keep
    // every other orphaned stamp un-retryable.
    expect(
      isStaleMergeActiveStatus(task({ id: "FN-1" }), { activeMergeTaskId: "FN-2", nowMs: NOW }),
    ).toBe(true);
  });

  it("NEVER classifies a merge that is slow but progressing as stale", () => {
    // Each merge phase writes a log entry, refreshing updatedAt. This is what stops the
    // manual Retry button from yanking a running merge.
    expect(
      isStaleMergeActiveStatus(task({ updatedAt: ago(30_000) }), { nowMs: NOW }),
    ).toBe(false);
  });

  it("respects the staleness floor exactly at the boundary", () => {
    const atFloor = ago(DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS);
    const justUnder = ago(DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS - 1_000);
    expect(isStaleMergeActiveStatus(task({ updatedAt: atFloor }), { nowMs: NOW })).toBe(true);
    expect(isStaleMergeActiveStatus(task({ updatedAt: justUnder }), { nowMs: NOW })).toBe(false);
  });

  it("honors a custom minAgeMs and refuses a non-positive one", () => {
    expect(isStaleMergeActiveStatus(task({ updatedAt: ago(90_000) }), { nowMs: NOW, minAgeMs: 60_000 })).toBe(true);
    expect(isStaleMergeActiveStatus(task({ updatedAt: ago(90_000) }), { nowMs: NOW, minAgeMs: 120_000 })).toBe(false);
    // A disabled/invalid floor must not make everything stale.
    for (const minAgeMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isStaleMergeActiveStatus(task(), { nowMs: NOW, minAgeMs })).toBe(false);
    }
  });

  it("fails closed on a missing or unparseable updatedAt", () => {
    // No staleness evidence must never be read as "stale" — that could yank a live merge.
    expect(isStaleMergeActiveStatus(task({ updatedAt: "" }), { nowMs: NOW })).toBe(false);
    expect(isStaleMergeActiveStatus(task({ updatedAt: "not-a-date" }), { nowMs: NOW })).toBe(false);
    expect(
      isStaleMergeActiveStatus({ id: "FN-1", status: "landing" } as never, { nowMs: NOW }),
    ).toBe(false);
  });

  it("never classifies a non-merge-active status as stale, however old", () => {
    for (const status of ["failed", "stuck-killed", null]) {
      expect(isStaleMergeActiveStatus(task({ status }), { nowMs: NOW })).toBe(false);
    }
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-08-02-18:45 (fleet: the pure lifecycle predicates):

THE INVARIANT: a pure predicate answers with the lanes its CALLER resolved, and keeps the legacy ids when the
caller supplies none.

Three of these have a failure mode worth naming separately, because none of them errors:

  - `getTaskAgeStalenessSignal` returned `undefined` for every card, so **age-staleness silently reported
    nothing**. A monitoring signal that goes quiet is indistinguishable from health — the board looks fine
    while cards sit for days.
  - `isStaleBlockedByBlocker` answered "not stale" for a blocker that was finished, paused in review, or
    permanently failed, so the blocked card **waited forever** with no signal.
  - `areAllDependenciesDone` is the third place "satisfied" is asked; it now gives the same answer as the
    store's `blockedBy` computation (#2720) and the merge blocker. Three surfaces, one rule.

THE OPTIONAL PARAMETER IS THE DESIGN, and both halves are asserted for each: supplying lanes makes a renamed
board work, omitting them preserves every existing caller. A required parameter would have compiled
everywhere and then answered "not active" / "not stale" / "not satisfied" for everything — the silent
direction, and the one a type checker cannot catch.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";

import { getTaskAgeStalenessSignal } from "../task-age-staleness.js";
import { isStaleBlockedByBlocker } from "../blocker-fanout.js";

function task(overrides: Partial<Task>): Task {
  return {
    id: "FN-1", column: "building", dependencies: [], steps: [], currentStep: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as Task;
}

const NOW = Date.parse("2026-01-08T00:00:00.000Z"); // a week later — well past any threshold

describe("age staleness follows the caller's active lanes", () => {
  it("produces a signal for a renamed WIP lane", () => {
    // Pre-fix: `building` matched neither literal, so the signal was undefined and the board looked healthy.
    const signal = getTaskAgeStalenessSignal(task({ column: "building" }), {
      now: NOW,
      wipColumn: "building",
      reviewColumn: "signoff",
    });

    expect(signal).toBeDefined();
  });

  it("produces a signal for a renamed REVIEW lane", () => {
    expect(getTaskAgeStalenessSignal(task({ column: "signoff" }), {
      now: NOW, wipColumn: "building", reviewColumn: "signoff",
    })).toBeDefined();
  });

  it("stays silent for a card in neither active lane", () => {
    // The paired negative: intake and terminal cards have no age-staleness signal by design.
    expect(getTaskAgeStalenessSignal(task({ column: "backlog" }), {
      now: NOW, wipColumn: "building", reviewColumn: "signoff",
    })).toBeUndefined();
  });

  it("keeps the LEGACY lanes when the caller supplies none", () => {
    expect(getTaskAgeStalenessSignal(task({ column: "in-progress" }), { now: NOW })).toBeDefined();
    expect(getTaskAgeStalenessSignal(task({ column: "in-review" }), { now: NOW })).toBeDefined();
    // And a renamed lane is NOT recognised without them — which is why the board list wires a resolver.
    expect(getTaskAgeStalenessSignal(task({ column: "building" }), { now: NOW })).toBeUndefined();
  });
});

describe("blocker staleness follows the caller's lanes", () => {
  const lanes = { terminal: new Set(["shipped", "filed"]), review: new Set(["signoff"]) };

  it("treats a blocker in the board's COMPLETE lane as stale", () => {
    // Pre-fix: the blocked card kept waiting on a finished blocker, forever, with no signal.
    expect(isStaleBlockedByBlocker(task({ column: "shipped" }), 3, lanes)).toBe(true);
  });

  it("treats a PAUSED blocker in the board's review lane as stale", () => {
    expect(isStaleBlockedByBlocker(task({ column: "signoff", paused: true }), 3, lanes)).toBe(true);
  });

  it("treats a retry-exhausted review blocker as stale", () => {
    expect(isStaleBlockedByBlocker(
      task({ column: "signoff", status: "failed", mergeRetries: 5 }), 3, lanes,
    )).toBe(true);
  });

  it("does NOT treat a healthy blocker as stale", () => {
    // The paired negative: a live blocker must still block.
    expect(isStaleBlockedByBlocker(task({ column: "building" }), 3, lanes)).toBe(false);
    expect(isStaleBlockedByBlocker(task({ column: "signoff" }), 3, lanes)).toBe(false);
  });

  it("keeps the LEGACY ids when the caller supplies no lanes", () => {
    expect(isStaleBlockedByBlocker(task({ column: "done" }), 3)).toBe(true);
    expect(isStaleBlockedByBlocker(task({ column: "archived" }), 3)).toBe(true);
    expect(isStaleBlockedByBlocker(task({ column: "shipped" }), 3)).toBe(false);
  });
});

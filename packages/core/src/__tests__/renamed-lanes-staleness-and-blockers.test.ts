import { describe, expect, it } from "vitest";
import { getTaskAgeStalenessSignal } from "../task-age-staleness.js";
import { computeBlockerFanoutMap, isStaleBlockedByBlocker } from "../blocker-fanout.js";
import type { Task } from "../types.js";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-04:10 (fleet — two signals that go quiet on a renamed board):

DEFECT 1 — AGE STALENESS NEVER FIRES. `getTaskAgeStalenessSignal` returns undefined unless the card
is in wip OR review, then picks warning/critical thresholds by which of the two it is. Keyed on the
literals, a renamed board produced NO age-staleness badge at all. This is the worst shape of failure
for a monitoring signal: the absence of a warning is indistinguishable from health, so nobody
notices that "this card has been sitting in progress for a day" simply stopped being said.

DEFECT 2 — A BLOCKER THAT BLOCKS FOREVER. `isStaleBlockedByBlocker` decides whether a `blockedBy`
marker is stale. Keyed on the literals, a FINISHED blocker on a renamed board never read as stale,
so the dependent kept its marker permanently and its "waiting on" badge pointed at work that shipped
days ago. Every path that clears a stale marker consults this predicate first, so nothing else
rescues it.

Both live in files that already resolve roles elsewhere — `blocker-fanout` carries notes about two
separate P1s on exactly this question — and both were the unconverted sibling.

The cases are DIFFERENTIAL: the same scenario under two vocabularies whose roles are identical and
only the ids differ. No renamed id collides with a legacy literal, so a surviving `=== "done"`
cannot pass by luck.
*/

const HOUR_MS = 60 * 60_000;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

describe("age-staleness resolves the ACTIVE lanes", () => {
  const now = Date.parse("2026-01-02T00:00:00.000Z");
  /* Aged well past the default warning threshold, so only the lane question can suppress it. */
  const aged = { columnMovedAt: new Date(now - 48 * HOUR_MS).toISOString() };

  it("default vocabulary: a long-sitting wip card raises the signal", () => {
    const signal = getTaskAgeStalenessSignal(makeTask({ column: "in-progress", ...aged }), { now });

    expect(signal).toBeDefined();
    expect(signal?.column).toBe("in-progress");
  });

  /* The defect: `building` matched neither literal, so the signal was silently undefined. */
  it("renamed vocabulary: a long-sitting wip card raises the signal", () => {
    const signal = getTaskAgeStalenessSignal(
      makeTask({ column: "building", ...aged }),
      { now, wipColumn: "building", reviewColumn: "checking" },
    );

    expect(signal).toBeDefined();
    /* The REPORTED lane stays on the legacy id — the signal's public shape is a separate contract. */
    expect(signal?.column).toBe("in-progress");
  });

  it("renamed vocabulary: a long-sitting REVIEW card raises the signal on the review thresholds", () => {
    const signal = getTaskAgeStalenessSignal(
      makeTask({ column: "checking", ...aged }),
      { now, wipColumn: "building", reviewColumn: "checking" },
    );

    expect(signal).toBeDefined();
    expect(signal?.column).toBe("in-review");
  });

  /* The paired negative: resolving lanes must not make EVERY column raise the signal. */
  it("a card in a non-active lane still raises nothing, under both vocabularies", () => {
    expect(getTaskAgeStalenessSignal(makeTask({ column: "done", ...aged }), { now })).toBeUndefined();
    expect(
      getTaskAgeStalenessSignal(
        makeTask({ column: "shipped", ...aged }),
        { now, wipColumn: "building", reviewColumn: "checking" },
      ),
    ).toBeUndefined();
  });

  it("both vocabularies agree — no column-id literal survives on this path", () => {
    const byDefault = getTaskAgeStalenessSignal(makeTask({ column: "in-progress", ...aged }), { now });
    const renamed = getTaskAgeStalenessSignal(
      makeTask({ column: "building", ...aged }),
      { now, wipColumn: "building", reviewColumn: "checking" },
    );

    expect(renamed?.level).toBe(byDefault?.level);
    expect(renamed?.column).toBe(byDefault?.column);
  });
});

describe("a finished blocker reads as STALE under a renamed vocabulary", () => {
  const RENAMED = {
    terminal: new Set(["shipped", "filed"]),
    review: new Set(["checking"]),
  };

  it("default vocabulary: a completed blocker is stale", () => {
    expect(isStaleBlockedByBlocker(makeTask({ column: "done" }), 3)).toBe(true);
    expect(isStaleBlockedByBlocker(makeTask({ column: "archived" }), 3)).toBe(true);
  });

  /* The defect: `shipped` matched neither literal, so the marker never cleared. */
  it("renamed vocabulary: a completed blocker is stale", () => {
    expect(isStaleBlockedByBlocker(makeTask({ column: "shipped" }), 3, RENAMED)).toBe(true);
    expect(isStaleBlockedByBlocker(makeTask({ column: "filed" }), 3, RENAMED)).toBe(true);
  });

  it("renamed vocabulary: a PAUSED review blocker is stale, an active one is not", () => {
    expect(isStaleBlockedByBlocker(makeTask({ column: "checking", paused: true }), 3, RENAMED)).toBe(true);
    expect(isStaleBlockedByBlocker(makeTask({ column: "checking" }), 3, RENAMED)).toBe(false);
  });

  /* The paired negative: staleness must not degrade into "every blocker is stale". */
  it("a live wip blocker is NOT stale, under both vocabularies", () => {
    expect(isStaleBlockedByBlocker(makeTask({ column: "in-progress" }), 3)).toBe(false);
    expect(isStaleBlockedByBlocker(makeTask({ column: "building" }), 3, RENAMED)).toBe(false);
  });

  /*
  The wiring, not just the predicate. `computeBlockerFanoutMap` is the only production caller, and a
  converted predicate whose sole caller still passes the defaults changes nothing while the census
  scores it as progress — the half-conversion this program keeps re-finding.
  */
  it("computeBlockerFanoutMap clears the marker for a terminal blocker via classify", () => {
    const blocker = makeTask({ id: "FN-BLOCK", column: "shipped" });
    const dependent = makeTask({ id: "FN-DEP", column: "building", blockedBy: "FN-BLOCK" });

    const map = computeBlockerFanoutMap([blocker, dependent], 3, {
      classify: (task: Task) => ({
        isHold: task.column === "drafting",
        isTerminal: RENAMED.terminal.has(task.column),
      }),
    });

    expect(
      map.get("FN-BLOCK")?.staleBlockedByDependentIds,
      "a shipped blocker's dependents must be reported as stale-blocked",
    ).toEqual(["FN-DEP"]);
  });

  /* Paired negative for the wiring: a LIVE blocker's dependents must not be reported stale. */
  it("computeBlockerFanoutMap keeps the marker for a live blocker", () => {
    const blocker = makeTask({ id: "FN-BLOCK", column: "building" });
    const dependent = makeTask({ id: "FN-DEP", column: "drafting", blockedBy: "FN-BLOCK" });

    const map = computeBlockerFanoutMap([blocker, dependent], 3, {
      classify: (task: Task) => ({
        isHold: task.column === "drafting",
        isTerminal: RENAMED.terminal.has(task.column),
      }),
    });

    expect(map.get("FN-BLOCK")?.staleBlockedByDependentIds).toEqual([]);
  });
});

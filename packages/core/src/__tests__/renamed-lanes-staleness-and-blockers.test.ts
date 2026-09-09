import { describe, expect, it } from "vitest";
import { computeBlockerFanoutMap, isStaleBlockedByBlocker } from "../tasks/blocker-fanout.js";
import type { Task } from "../types.js";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-09:00 (fleet — a blocker that blocked forever):

`isStaleBlockedByBlocker` decides whether a `blockedBy` marker is stale. Keyed on the literals, a
FINISHED blocker on a renamed board never read as stale, so the dependent kept its marker
permanently and its "waiting on" badge pointed at work that shipped days ago. Every path that clears
a stale marker consults this predicate first, so nothing else rescues it.

It is the unconverted sibling in a file that already resolves roles everywhere else —
`computeBlockerFanoutMap` takes `terminalColumns`/`holdColumn`/`classify`, and the notes there record
two separate P1s about getting exactly this right.

The WIRING is proven separately from the predicate. Converting the predicate while its only
production caller kept passing the defaults would have changed nothing at runtime while the census
scored it as progress — the half-conversion this program keeps re-finding.

The cases are DIFFERENTIAL: the same scenario under two vocabularies whose roles are identical and
only the ids differ. No renamed id collides with a legacy literal, so a surviving `=== "done"`
cannot pass by luck.

(The age-staleness half of this suite is gone: #2746 landed that conversion on main first, with a
`lifecycle` param instead of my flat pair. What survived is the hydration-site gap it left, pinned in
reads-age-staleness-lane-hydration.test.ts.)
*/


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

describe("a finished blocker reads as STALE under a renamed vocabulary", () => {
  const RENAMED = {
    terminal: new Set(["shipped"]),
    review: new Set(["checking"]),
  };

  it("default vocabulary: a completed blocker is stale", () => {
    expect(isStaleBlockedByBlocker(makeTask({ column: "done" }), 3)).toBe(true);
  });

  /* The defect: `shipped` matched neither literal, so the marker never cleared. */
  it("renamed vocabulary: a completed blocker is stale", () => {
    expect(isStaleBlockedByBlocker(makeTask({ column: "shipped" }), 3, RENAMED)).toBe(true);
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

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-10:00 (PR #2749 review — greptile P1):
  THE SET-SHAPED PATH IS THE ONE PRODUCTION TAKES.

  The cases above drive `classify`, but the ONLY production caller — `buildUnblockWeightMap` in
  task-priority.ts — passes `terminalColumns` and no `classify` at all. So a fix reachable only
  through `classify` never fires in production: converted predicate, green tests, unchanged
  behaviour. That is the guard-that-cannot-fire pattern turned on my own fix.

  These drive the set-shaped path end to end, including the REVIEW half, which `classify` does not
  answer at all (it reports `isTerminal`/`isHold` only).
  */
  it("set-shaped path: a renamed TERMINAL blocker is stale without classify", () => {
    const blocker = makeTask({ id: "FN-BLOCK", column: "shipped" });
    const dependent = makeTask({ id: "FN-DEP", column: "building", blockedBy: "FN-BLOCK" });

    const map = computeBlockerFanoutMap([blocker, dependent], 3, {
      terminalColumns: RENAMED.terminal,
      reviewColumns: RENAMED.review,
    });

    expect(map.get("FN-BLOCK")?.staleBlockedByDependentIds).toEqual(["FN-DEP"]);
  });

  it("set-shaped path: a renamed PAUSED review blocker is stale without classify", () => {
    const blocker = makeTask({ id: "FN-BLOCK", column: "checking", paused: true });
    const dependent = makeTask({ id: "FN-DEP", column: "building", blockedBy: "FN-BLOCK" });

    const map = computeBlockerFanoutMap([blocker, dependent], 3, {
      terminalColumns: RENAMED.terminal,
      reviewColumns: RENAMED.review,
    });

    expect(map.get("FN-BLOCK")?.staleBlockedByDependentIds).toEqual(["FN-DEP"]);
  });

  it("set-shaped path: a renamed RETRY-EXHAUSTED review blocker is stale without classify", () => {
    const blocker = makeTask({ id: "FN-BLOCK", column: "checking", status: "failed", mergeRetries: 5 });
    const dependent = makeTask({ id: "FN-DEP", column: "building", blockedBy: "FN-BLOCK" });

    const map = computeBlockerFanoutMap([blocker, dependent], 3, {
      terminalColumns: RENAMED.terminal,
      reviewColumns: RENAMED.review,
    });

    expect(map.get("FN-BLOCK")?.staleBlockedByDependentIds).toEqual(["FN-DEP"]);
  });

  /* Paired negative on the same path: a LIVE renamed review blocker still blocks. */
  it("set-shaped path: a live renamed review blocker is NOT stale", () => {
    const blocker = makeTask({ id: "FN-BLOCK", column: "checking" });
    const dependent = makeTask({ id: "FN-DEP", column: "building", blockedBy: "FN-BLOCK" });

    const map = computeBlockerFanoutMap([blocker, dependent], 3, {
      terminalColumns: RENAMED.terminal,
      reviewColumns: RENAMED.review,
    });

    expect(map.get("FN-BLOCK")?.staleBlockedByDependentIds).toEqual([]);
  });
});

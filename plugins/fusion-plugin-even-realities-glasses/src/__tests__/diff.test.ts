import { describe, expect, it } from "vitest";
import { diffSnapshots } from "../notifications/diff.js";
import type { Snapshot } from "../notifications/types.js";

function task(id: string, column: "triage" | "todo" | "in-progress" | "in-review" | "done", updatedAt: string) {
  return {
    id,
    column,
    updatedAt,
    description: id,
    dependencies: [],
    steps: [],
    currentStep: 1,
    log: [],
  } as never;
}

describe("diffSnapshots", () => {
  it("emits new-task only for watched columns on initial run", () => {
    const events = diffSnapshots(new Map() as Snapshot, [task("FN-1", "in-review", "2026-01-01T00:00:00.000Z"), task("FN-2", "todo", "2026-01-01T00:00:01.000Z")], {
      notifyOnColumns: new Set(["in-review"]),
      alsoNotifyOnDone: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("new-task");
  });

  it.each([
    ["todo", "in-review", "entered-column"],
    ["in-review", "todo", "left-column"],
  ] as const)("handles transitions %s -> %s", (from, to, reason) => {
    const prev = new Map([["FN-1", { taskId: "FN-1", lastColumn: from, updatedAt: "2026-01-01T00:00:00.000Z" }]]) as Snapshot;
    const events = diffSnapshots(prev, [task("FN-1", to, "2026-01-01T00:00:02.000Z")], {
      notifyOnColumns: new Set(["in-review"]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe(reason);
  });

  it("emits completed when done unwatched", () => {
    const prev = new Map([["FN-1", { taskId: "FN-1", lastColumn: "in-progress", updatedAt: "2026-01-01T00:00:00.000Z" }]]) as Snapshot;
    const events = diffSnapshots(prev, [task("FN-1", "done", "2026-01-01T00:00:02.000Z")], {
      notifyOnColumns: new Set(["in-review"]),
      alsoNotifyOnDone: true,
    });
    expect(events.map((e) => e.reason)).toEqual(["completed"]);
  });

  it("emits entered-column and completed when done watched", () => {
    const prev = new Map([["FN-1", { taskId: "FN-1", lastColumn: "in-progress", updatedAt: "2026-01-01T00:00:00.000Z" }]]) as Snapshot;
    const events = diffSnapshots(prev, [task("FN-1", "done", "2026-01-01T00:00:02.000Z")], {
      notifyOnColumns: new Set(["done"]),
      alsoNotifyOnDone: true,
    });
    expect(events.map((e) => e.reason)).toEqual(["entered-column", "completed"]);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-01:20:
  THE INVARIANT: "completed" is decided by the caller's resolved complete lanes, not by `"done"`.

  The two cases above pass only because their fixture board is the built-in one. On a renamed board
  the wearer was notified of every column transition EXCEPT the one they care about — the card
  finishing — and nothing surfaced that, because the parameter meant to carry the answer
  (`completeColumnsByTaskId`) had no caller anywhere and the literal decided every real poll.

  Both directions are asserted: a card in the resolved lane fires, and a card in the LEGACY `done`
  fires only when the caller's lanes say so. The second half is the one that proves the resolved set
  is actually consulted rather than unioned with the old literal.

  REVERT PROOF, measured: restore `task.column === "done"` as the test and the renamed case fails
  with `expected [] to deeply equal [ 'completed' ]`.
  */
  it("emits completed for a RENAMED complete lane the caller resolved", () => {
    const prev = new Map([["FN-1", { taskId: "FN-1", lastColumn: "building", updatedAt: "2026-01-01T00:00:00.000Z" }]]) as Snapshot;

    const events = diffSnapshots(prev, [task("FN-1", "shipped" as never, "2026-01-01T00:00:02.000Z")], {
      notifyOnColumns: new Set(["in-review"]),
      alsoNotifyOnDone: true,
      completeColumnsByTaskId: new Map([["FN-1", new Set(["shipped"])]]),
    });

    expect(events.map((e) => e.reason)).toEqual(["completed"]);
  });

  it("does NOT treat the legacy `done` as complete once the caller resolved other lanes", () => {
    // The resolved set REPLACES the default; unioning the literal back in would make a board that
    // reuses `done` as a non-terminal lane fire a completion notification for live work.
    const prev = new Map([["FN-1", { taskId: "FN-1", lastColumn: "building", updatedAt: "2026-01-01T00:00:00.000Z" }]]) as Snapshot;

    const events = diffSnapshots(prev, [task("FN-1", "done", "2026-01-01T00:00:02.000Z")], {
      notifyOnColumns: new Set(["in-review"]),
      alsoNotifyOnDone: true,
      completeColumnsByTaskId: new Map([["FN-1", new Set(["shipped"])]]),
    });

    expect(events).toEqual([]);
  });

  it("returns no event when column unchanged", () => {
    const prev = new Map([["FN-1", { taskId: "FN-1", lastColumn: "todo", updatedAt: "2026-01-01T00:00:00.000Z" }]]) as Snapshot;
    const events = diffSnapshots(prev, [task("FN-1", "todo", "2026-01-01T00:00:02.000Z")], {
      notifyOnColumns: new Set(["todo"]),
    });
    expect(events).toEqual([]);
  });

  it("sorts deterministically", () => {
    const prev = new Map([
      ["FN-2", { taskId: "FN-2", lastColumn: "todo", updatedAt: "2026-01-01T00:00:00.000Z" }],
      ["FN-1", { taskId: "FN-1", lastColumn: "todo", updatedAt: "2026-01-01T00:00:00.000Z" }],
    ]) as Snapshot;
    const events = diffSnapshots(prev, [task("FN-2", "in-review", "2026-01-01T00:00:01.000Z"), task("FN-1", "in-review", "2026-01-01T00:00:01.000Z")], {
      notifyOnColumns: new Set(["in-review"]),
    });
    expect(events.map((e) => e.taskId)).toEqual(["FN-1", "FN-2"]);
  });
});

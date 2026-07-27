/*
FNXC:WorkflowLifecycleColumns 2026-07-28-02:40 (PR #2470 review, P1):

`computeBlockerFanoutMap` accepts resolved `terminalColumns` / `holdColumn`, but
`computeDependencyBlockedTodoReport` called it with NEITHER — so the fan-out fell
back to the legacy {done, archived} / "todo" defaults even for a workflow that
renames them. That is the "convertible rather than converted" defect: the module
takes the roles, the caller never passes them, and end-to-end the bug is still
live.

Concretely, for a workflow whose terminal column is `published` and whose hold
column is `queued`:
  - a FINISHED blocker in `published` counted as ACTIVE, so it kept appearing as
    a live blocker in the report;
  - dependents resting in `queued` were not counted as blocked todos at all
    (`activeTodoCount` keyed on the literal "todo"), so genuinely-blocked work
    was invisible to the report.

The two errors point in OPPOSITE directions — over-reporting dead blockers while
under-reporting real ones — which is why both are asserted separately rather
than through a single aggregate count.

The report also had two literals of its OWN beyond the unthreaded call: its
`todoTaskIds` filter and its `blocker.column === "done" || "archived"` skip.
Threading the fan-out alone would have left those, so a renamed workflow would
still report nothing. All three now read the same resolved roles.

Written against the unthreaded implementation and observed FAILING first.
*/
import { describe, expect, it } from "vitest";

import {
  computeDependencyBlockedTodoReport,
  type DependencyBlockedTodoReportContext,
} from "../dependency-blocked-todo-report.js";
import type { Task } from "../types.js";

const NOW = Date.parse("2026-05-01T12:00:00.000Z");
/** Old enough to be a "stale" blocker, so age bucketing never masks a miss. */
const MOVED_AT = new Date(NOW - 5 * 60 * 60_000).toISOString();

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: MOVED_AT,
    updatedAt: MOVED_AT,
    columnMovedAt: MOVED_AT,
    ...over,
  } as Task;
}

/**
 * One blocker plus two dependents resting in the hold column, expressed under a
 * caller-supplied vocabulary. The SHAPE is identical across vocabularies, so any
 * difference in the report is attributable to a surviving literal.
 */
function board(names: { hold: string; terminal: string }, blockerColumn: string): Task[] {
  return [
    task({ id: "BLOCKER", column: blockerColumn }),
    task({ id: "DEP-1", column: names.hold, dependencies: ["BLOCKER"] }),
    task({ id: "DEP-2", column: names.hold, dependencies: ["BLOCKER"] }),
  ];
}

const DEFAULT_NAMES = { hold: "todo", terminal: "done" };
/* Neither renamed id collides with a legacy literal. */
const RENAMED = { hold: "queued", terminal: "published" };
const RENAMED_ROLES: DependencyBlockedTodoReportContext = {
  now: NOW,
  holdColumn: RENAMED.hold,
  terminalColumns: [RENAMED.terminal, "retired"],
};

describe("dependency-blocked-todo report under a renamed column vocabulary", () => {
  it("counts dependents resting in a RENAMED hold column as blocked todos", async () => {
    // Blocker is live (in the wip column), dependents wait in the renamed hold.
    const report = computeDependencyBlockedTodoReport(board(RENAMED, "building"), 0, RENAMED_ROLES);

    expect(report.totalBlockedTodoCount).toBe(2);
    expect(report.uniqueBlockerCount).toBe(1);
    expect(report.groups[0]?.blockerId).toBe("BLOCKER");
    expect(report.groups[0]?.blockedTodoIds).toEqual(["DEP-1", "DEP-2"]);
  });

  it("drops a blocker that already reached a RENAMED terminal column", async () => {
    /* The opposite-direction error: a finished blocker kept being reported as a
       live one because `published` is not in the legacy terminal set. */
    const report = computeDependencyBlockedTodoReport(
      board(RENAMED, RENAMED.terminal),
      0,
      RENAMED_ROLES,
    );

    expect(report.groups).toEqual([]);
    expect(report.totalBlockedTodoCount).toBe(0);
  });

  it("honors a SECOND declared terminal column, not just the first", async () => {
    /* terminalColumns is a set, not a single id — a fix that only handled the
       primary terminal column would pass the test above and fail here. */
    const report = computeDependencyBlockedTodoReport(board(RENAMED, "retired"), 0, RENAMED_ROLES);

    expect(report.groups).toEqual([]);
  });

  it("is byte-identical for the builtin vocabulary when roles are omitted (regression floor)", async () => {
    const live = computeDependencyBlockedTodoReport(board(DEFAULT_NAMES, "in-progress"), 0, { now: NOW });
    expect(live.totalBlockedTodoCount).toBe(2);
    expect(live.groups[0]?.blockedTodoIds).toEqual(["DEP-1", "DEP-2"]);

    const finished = computeDependencyBlockedTodoReport(board(DEFAULT_NAMES, "done"), 0, { now: NOW });
    expect(finished.groups).toEqual([]);

    const archived = computeDependencyBlockedTodoReport(board(DEFAULT_NAMES, "archived"), 0, { now: NOW });
    expect(archived.groups).toEqual([]);
  });

  it("still counts a legacy-named board correctly when roles ARE supplied explicitly", async () => {
    /* Supplying the legacy ids explicitly must behave exactly like omitting
       them — otherwise threading the caller would itself change behavior for
       builtin:coding. */
    const report = computeDependencyBlockedTodoReport(board(DEFAULT_NAMES, "in-progress"), 0, {
      now: NOW,
      holdColumn: "todo",
      terminalColumns: ["done", "archived"],
    });

    expect(report.totalBlockedTodoCount).toBe(2);
    expect(report.groups[0]?.blockedTodoIds).toEqual(["DEP-1", "DEP-2"]);
  });
});

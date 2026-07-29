/*
FNXC:WorkflowLifecycleColumns 2026-07-29-15:05 (U11 — post-#2515 P0 audit):

#2515 merged Todo into Planning on the DEFAULT lineage: one pre-implementation
column, id `todo`, display "Planning". `triage` stayed a legal id, so nothing
throws — but every bare `column === "triage"` guard simply stopped matching for
default-workflow cards.

`hasAdvancedPastPlanning` carried two such guards, and they are NOT the same rule:

  1. The FN-8596 "second strand" rescue: a card holding execution stamps that
     PREDATE its arrival in the planner lane is replanning, not advanced. Its own
     comment records what happens when nobody owns that card — "Nobody owned the
     card and it sat indefinitely."

  2. "The planner column itself is never advanced."

Rule 1 must recognise the merged Planning column. Rule 2 must NOT: on the merged
lineage `todo` is ALSO the released/hold lane, so treating it as blanket
"not advanced" would make a released card with steps read as still-planning and
break `hasAdvancedPastPlanning(t) || releasedToTodo`.

That asymmetry is the whole fix, and these tests pin both halves.
*/
import { describe, expect, it } from "vitest";

import { hasAdvancedPastPlanning, isTaskStillInPlanningStage } from "../replan-target.js";

const ARRIVED = "2026-07-29T12:00:00.000Z";
const BEFORE_ARRIVAL = "2026-07-29T11:00:00.000Z";
const AFTER_ARRIVAL = "2026-07-29T13:00:00.000Z";

function card(over: Record<string, unknown> = {}) {
  return {
    column: "todo",
    status: null,
    steps: [],
    worktree: null,
    columnMovedAt: ARRIVED,
    ...over,
  } as never;
}

describe("hasAdvancedPastPlanning on the merged Planning column (post-#2515 default lineage)", () => {
  it("rescues a merged-Planning card whose execution stamps predate its arrival", () => {
    /*
    The stall. Pre-#2515 this card sat in `triage` and the FN-8596 rescue caught it.
    Post-merge it sits in `todo` with status cleared to null by the stale-status
    sweep, so the rescue stopped firing and every guarded planning write no-ops.
    */
    const replanning = card({
      column: "todo",
      firstExecutionAt: BEFORE_ARRIVAL,
      executionStartedAt: BEFORE_ARRIVAL,
      steps: [{ id: "s1" }],
    });
    expect(hasAdvancedPastPlanning(replanning)).toBe(false);
    expect(isTaskStillInPlanningStage(replanning)).toBe(true);
  });

  it("still reads a merged-Planning card claimed AFTER arrival as advanced", () => {
    /* The FN-8361 race must keep its answer: a stamp NEWER than arrival is a live
       claim, and recovery must not clear the status out from under execution. */
    expect(
      hasAdvancedPastPlanning(
        card({ column: "todo", executionStartedAt: AFTER_ARRIVAL, steps: [{ id: "s1" }] }),
      ),
    ).toBe(true);
  });

  it("keeps a RELEASED merged-Planning card with steps reading as advanced", () => {
    /*
    The direction the fix must NOT break. On the merged lineage `todo` is also the
    hold lane, so rule 2 stays keyed to a DEDICATED planner column. A released card
    carries steps and no stamps; treating the column as blanket "not advanced" here
    would strand the release path instead.
    */
    expect(hasAdvancedPastPlanning(card({ column: "todo", steps: [{ id: "s1" }] }))).toBe(true);
  });

  it("keeps an actively-planning merged card not-advanced via its status", () => {
    expect(hasAdvancedPastPlanning(card({ column: "todo", status: "planning", steps: [{ id: "s1" }] }))).toBe(false);
  });

  it("leaves the dedicated-planner lineage byte-identical", () => {
    /* Coding (Ideas) and every workflow that still declares `triage`. */
    expect(hasAdvancedPastPlanning(card({ column: "triage", steps: [{ id: "s1" }] }))).toBe(false);
    expect(
      hasAdvancedPastPlanning(
        card({ column: "triage", firstExecutionAt: BEFORE_ARRIVAL, steps: [{ id: "s1" }] }),
      ),
    ).toBe(false);
    expect(
      hasAdvancedPastPlanning(
        card({ column: "triage", firstExecutionAt: AFTER_ARRIVAL, steps: [{ id: "s1" }] }),
      ),
    ).toBe(true);
  });

  it("keeps every implementation column advanced", () => {
    for (const column of ["in-progress", "in-review", "done", "archived"]) {
      expect(hasAdvancedPastPlanning(card({ column, steps: [{ id: "s1" }] }))).toBe(true);
    }
  });

  it("honours an explicitly supplied merged planning column", () => {
    /* A renamed workflow that also merges planning into its hold lane. */
    const renamed = card({
      column: "drafting",
      firstExecutionAt: BEFORE_ARRIVAL,
      steps: [{ id: "s1" }],
    });
    expect(hasAdvancedPastPlanning(renamed)).toBe(true);
    expect(hasAdvancedPastPlanning(renamed, "triage", { mergedPlanningColumn: "drafting" })).toBe(false);
  });
});

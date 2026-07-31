/*
FNXC:WorkflowLifecycleColumns 2026-07-29-10:05 (U11 conversion — replan-target):

`replan-target.ts` decides two things by literal column id:

  1. `hasAdvancedPastPlanning` — "is this card resting in the planner column?"
     Two comparisons against `"triage"`. A card in a renamed planner column reads
     as ADVANCED, which is the dangerous direction: the replan guards then treat a
     card that is still being planned as one that has moved on, so recovery paths
     stop protecting it and planning writes get skipped.

  2. `resolveReplanTargetColumn` — where a rejected plan is sent back to. It asks
     `workflowHasColumn(ir, "triage")` then `("todo")`. For a workflow using
     neither name BOTH lookups miss and it falls through to `"triage"` — a column
     that workflow does not declare. Today that strands the card; after U11
     deletes `todo` it also removes the second chance.

The final fallback stays a DELIBERATE LITERAL and is not converted — see the
existing FNXC note in the source. Its value is precisely that it is NOT
trait-resolved: it fires only when a workflow declares no planner lane at all, and
resolving it against that workflow (to its own entry column) is the stranded-card
bug it was written to fix.

Written against the literal implementation and observed FAILING first.
*/
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";

import { hasAdvancedPastPlanning, isTaskStillInPlanningStage } from "../replan-target.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    column: "drafting",
    status: null,
    steps: [],
    worktree: undefined,
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as Task;
}

describe("hasAdvancedPastPlanning under a renamed planner column", () => {
  it("does NOT treat a card resting in the renamed planner column as advanced", () => {
    /*
    The dangerous direction. Reading "still planning" as "advanced" makes the
    replan guards stop protecting a card that is mid-plan, so planning writes are
    silently skipped and the card is never re-specified.
    */
    /* STEPS ARE LOAD-BEARING HERE. With an empty step list the final branch
       returns false anyway, so the assertion would pass without the planner-lane
       check ever running. A card carrying steps from its previous planning pass is
       the case that actually distinguishes the two. */
    const planned = task({ column: "drafting", steps: [{ name: "s", status: "done" }] } as Partial<Task>);
    expect(hasAdvancedPastPlanning(planned, "drafting")).toBe(false);
    expect(isTaskStillInPlanningStage(planned, "drafting")).toBe(true);
  });

  it("still treats a card in a NON-planner column as advanced", () => {
    /* The negative half: the parameter must narrow, not blanket-answer. */
    expect(hasAdvancedPastPlanning(task({ column: "building", steps: [{ name: "s", status: "done" }] } as Partial<Task>), "drafting")).toBe(true);
  });

  it("defaults to the legacy planner column when no column is supplied", () => {
    /* Byte-identical for every caller that cannot resolve a workflow — including
       the three in self-healing.ts, which are another worker's slice. */
    const planned = task({ column: "triage", steps: [{ name: "s", status: "done" }] } as Partial<Task>);
    expect(hasAdvancedPastPlanning(planned)).toBe(false);
    expect(isTaskStillInPlanningStage(planned)).toBe(true);
  });
});

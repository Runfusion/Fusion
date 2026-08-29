/*
FNXC:WorkflowColumns 2026-07-30-04:15 (U12 — THIS FILE'S EQUIVALENCE CASES ARE RETIRED, ON PURPOSE):
The compatibility flag is deleted in this same PR, so the two-flag-states comparison below cannot
run any more — there is only one path now. Its result is preserved in the commit that added it and
in the deletion's own comment: identical persisted rows across 128 fields plus an equal timing shape,
mutation-verified in both directions. That was the evidence the flip needed, and it discharged.

What SURVIVES here are the seam-2 cases, which never depended on the flag being flippable: a move to
a column the task's workflow does not declare is rejected, and the #1411 `recoveryRehome` carve-out
still lets a stranded custom-workflow card be rescued. Those remain live behaviour worth pinning
after the flip — the carve-out especially, because it is the thing that keeps recovery working on
custom boards and it looks like dead weight to anyone tidying up.

--- original header, kept for the record ---

FNXC:WorkflowColumns 2026-07-30-02:00 (U12 — precondition 1 for flipping the move-path flag):
DO THE TWO COLUMN-SIDE-EFFECT IMPLEMENTATIONS AGREE?

`moves.ts` gates six behaviours on the raw compatibility flag (#2639 pins all six). Seam 3 is the one
that is genuinely an EQUIVALENCE question: flag-OFF runs an inline legacy block, flag-ON routes the
same column side effects through the default-workflow trait hooks — timing accumulation,
reset-on-entry, abort-on-exit, `merge.onEnter`. Neither is the observed baseline, because they have
never both run in production, so "the suite is green after the flip" says nothing.

WHY THIS IS BUILDABLE NOW, which I had assumed it was not. The flag reads
`settings.experimentalFeatures.workflowColumns`, and `updateSettings` is public — so a test can run
the SAME move under both flag states against a live store and diff the persisted row. No production
change, no mock of the thing under test.

WHAT IT COMPARES. The full persisted task, minus fields whose difference carries no meaning
(identity, and wall-clock stamps that advance between two runs). Comparing whole rows rather than a
curated field list is deliberate: a curated list only proves the fields I already suspected, and the
entire risk here is a side effect nobody enumerated. `moves.ts` mutates ~15 fields in that branch.

WHAT IT DOES NOT COVER, stated so this is not mistaken for a full clearance:
  - `resetPromptCheckboxes` writes to the task DIRECTORY, not the row, so a row diff cannot see it.
  - Plugin hooks (seam 5) and the transition-pending marker (seam 4) are separate seams.
  - Seam 2 turns on NEW REJECTIONS rather than swapping implementations, so it is not an equivalence
    question at all; #2647's `move-target-declared-census.test.ts` measures that exposure instead.
This test discharges seam 3 for the row state, which is the part that was pure assertion before.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../__test-utils__/pg-test-harness.js";
import type { TaskDetail } from "../types.js";
import type { TaskStore } from "../store.js";







pgDescribe("move-path side effects are equivalent with the compatibility flag OFF and ON (U12 seam 3)", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_moves_flag_equiv" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  /*
  FNXC:WorkflowColumns 2026-07-30-03:00 (U12 — seam 2, demonstrated rather than inferred):
  WHAT THE FLIP WOULD BREAK ON A CUSTOM BOARD.

  Precondition 2's census established that 20 of 41 literal engine `moveTask` targets carry no
  `recoveryRehome`, and inferred that those would start rejecting on a lineage that does not declare
  the legacy ids. Inference is not enough to hand someone as a work order, so this reproduces it.

  Seam 2 is NOT an equivalence question: with the flag off there is no target validation at all, so
  flipping introduces refusals for moves that succeed today. This case is the refusal, and the second
  case is the #1411 carve-out that the other 21 sites rely on — which is what makes that carve-out
  load-bearing for the flip rather than incidental.

  If the first expectation ever starts passing, seam 2 stopped rejecting undeclared targets and the
  20 call sites are no longer a blocker — delete this and flip.
  */
  it("REJECTS an engine move to a column the task's own workflow does not declare", async () => {
    const store = harness.store();

    // A lineage with none of the legacy ids: no todo, no in-progress, no done.
    const definition = await store.createWorkflowDefinition({
      name: "no-legacy-ids",
      ir: {
        version: "v2",
        name: "no-legacy-ids",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);

    const task = await store.createTask({ description: "custom lineage card", workflowId: definition.id } as never);

    /*
    A plain engine-shaped move to `todo` — the shape 20 census sites use. It must reject, because
    `todo` is not a column this workflow declares. This is the break the flip would ship.
    */
    await expect(store.moveTask(task.id, "todo")).rejects.toThrow();
  });

  it("ACCEPTS the same move when it carries the #1411 recoveryRehome carve-out", async () => {
    const store = harness.store();

    const definition = await store.createWorkflowDefinition({
      name: "no-legacy-ids-rescue",
      ir: {
        version: "v2",
        name: "no-legacy-ids-rescue",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);

    const task = await store.createTask({ description: "rescued card", workflowId: definition.id } as never);

    /*
    The carve-out exists so a custom-workflow card can still be rescued to a guaranteed-safe landing
    column. The 21 census sites that pass it are already flip-safe; this pins that, so nobody "cleans
    up" the carve-out and breaks recovery on custom boards.
    */
    const moved = await store.moveTask(task.id, "todo", { recoveryRehome: true, bypassGuards: true } as never);
    expect(moved.column).toBe("todo");
  });
});

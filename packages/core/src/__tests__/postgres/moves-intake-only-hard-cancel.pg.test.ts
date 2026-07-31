/*
FNXC:WorkflowTaskCancellation 2026-07-30-23:20 (PR #2705 review — greptile):

THE OPERATOR HARD CANCEL MUST FIRE ON A WORKFLOW THAT HAS NO HOLD COLUMN.

`moveTaskInternal`'s two hard-cancel guards resolved their target as
`moveLifecycle?.hold ?? "todo"`. A workflow may legitimately declare an INTAKE column and no hold
column — Coding (Ideas)'s `ideas` lane is the shipped example — and then `"todo"` names a column
that workflow does not declare. The comparison never matches, so the card moves while its merge
request stays live and its active work items are never cancelled.

That is a cancellation contract failing OPEN, which is the worst direction available: the operator
sees the card parked and believes the work stopped.

WHY A LIVE STORE. The bug is in which column id the guard compares against, and that id comes from
the task's own persisted workflow. A mock that hands back a lifecycle struct would be asserting my
own assumption about what `resolveLifecycleColumns` returns for an intake-only lineage — the exact
substitution that has produced vacuous tests all through this program. This drives a real
PostgreSQL store and a real workflow definition, and asserts on OBSERVED PERSISTED STATE.

WHAT IS ASSERTED. The completion-handoff marker is cleared only inside the guarded block, so it is
a precise witness that the block ran. Reverting the production fallback to `?? "todo"` leaves the
marker in place and fails this test.

LANE. `.pg.test.ts`, skipped by `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits

import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../../__test-utils__/pg-test-harness.js";

pgDescribe("operator hard cancel on a workflow with an intake lane and no hold lane", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_moves_intake_cancel" });

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(async () => { await harness.beforeEach(); });
  afterEach(async () => { await harness.afterEach(); });

  /** Intake, wip, review, complete — deliberately NO hold column, and no legacy ids. */
  async function intakeOnlyWorkflow(store: ReturnType<typeof harness.store>) {
    return store.createWorkflowDefinition({
      name: "intake-only",
      ir: {
        version: "v2",
        name: "intake-only",
        columns: [
          { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
          { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "inbox" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
  }

  it("clears the completion-handoff marker when the operator parks a review card in the INTAKE lane", async () => {
    const store = harness.store();
    const definition = await intakeOnlyWorkflow(store);
    const task = await store.createTask({ description: "intake-only card", workflowId: definition.id } as never);

    await store.moveTask(task.id, "signoff" as never, { bypassGuards: true } as never);

    await store.setCompletionHandoffAcceptedMarker(task.id, { source: "test" });
    expect(await store.getCompletionHandoffAcceptedMarker(task.id)).not.toBeNull();

    /*
    The operator hard cancel: review -> the pre-implementation lane, by USER.

    `bypassGuards` is here because this lineage declares no edge back from `signoff`, and that
    ADJACENCY question is a different one from the side-effect contract under test. Without it the
    move is rejected before reaching the guard, and the test would pass or fail on transition
    legality rather than on which column id the cancel compares against.
    */
    await store.moveTask(task.id, "inbox" as never, { moveSource: "user" } as never);

    store.taskCache.delete(task.id);
    expect((await store.getTask(task.id)).column).toBe("inbox");
    /*
    The witness. With the pre-fix `?? "todo"` fallback this guard never matched on this lineage, so
    the marker survived and the merge request was left running behind a card the operator had
    already parked.
    */
    expect(await store.getCompletionHandoffAcceptedMarker(task.id)).toBeNull();
  });

  it("does NOT hard-cancel an ENGINE move into the same lane", async () => {
    /*
    The paired negative, so the fix cannot pass by cancelling on every move into intake. Only an
    operator move is a hard cancel; an engine rebound must leave the handoff alone.
    */
    const store = harness.store();
    const definition = await intakeOnlyWorkflow(store);
    const task = await store.createTask({ description: "engine rebound card", workflowId: definition.id } as never);

    await store.moveTask(task.id, "signoff" as never, { bypassGuards: true } as never);
    await store.setCompletionHandoffAcceptedMarker(task.id, { source: "test" });

    await store.moveTask(task.id, "inbox" as never, { moveSource: "engine", recoveryRehome: true, bypassGuards: true } as never);

    expect(await store.getCompletionHandoffAcceptedMarker(task.id)).not.toBeNull();
  });
});

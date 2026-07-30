/*
FNXC:WorkflowResolvedColumns 2026-07-30-07:55 (batch-core):

THE MERGE QUEUE MUST FILL AND DRAIN ON A BOARD THAT RENAMED ITS REVIEW LANE.

`enqueueMergeQueueInTransaction` admitted a card only from the literal `in-review`, and
`dequeueMergeQueueOnColumnExitInTransaction` removed it only when leaving that same literal. Both run
inside the move transaction with a `tx` handle and no store, so neither could resolve the lane itself
— the resolved set now comes from `moves.ts`, which already resolves the workflow for the move.

WHY THE PAIR IS TESTED TOGETHER AND NOT SEPARATELY. Converting one half alone is undetectable: if
enqueue keeps the literal, nothing is ever queued on a renamed board, so a dequeue test has nothing to
observe and passes vacuously. If dequeue keeps the literal, the queue fills and never drains — a leak
that only shows up on the SECOND move. One test drives the whole cycle so neither half can regress
without failing.

WHY A LIVE STORE. The bug is which column id the guard compares against, and that id comes from the
task's own persisted workflow. A mock handing back a lifecycle struct would assert my own assumption
about what `resolveReviewColumns` returns — the substitution that has produced vacuous tests all
through this program. This drives real PostgreSQL and asserts on OBSERVED QUEUE ROWS.

LANE. `.pg.test.ts`, skipped by `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits

import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../../__test-utils__/pg-test-harness.js";

pgDescribe("merge queue fills and drains on a renamed review lane", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_mq_renamed_review" });

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(async () => { await harness.beforeEach(); });
  afterEach(async () => { await harness.afterEach(); });

  /** `signoff` carries the merge trait; this board declares no `in-review` column at all. */
  async function renamedReviewWorkflow(store: ReturnType<typeof harness.store>) {
    return store.createWorkflowDefinition({
      name: "renamed-review",
      ir: {
        version: "v2",
        name: "renamed-review",
        columns: [
          { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "inbox" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
  }

  it("enqueues on entering the renamed review lane and dequeues on leaving it", async () => {
    const store = harness.store();
    const definition = await renamedReviewWorkflow(store);
    const task = await store.createTask({ description: "renamed review card", workflowId: definition.id } as never);

    /* Adjacency is derived from the graph, so the card walks the board rather than jumping. */
    await store.moveTask(task.id, "building" as never, { bypassGuards: true } as never);
    /*
    The merge queue is filled by the COMPLETION HANDOFF, not by a bare move into the review lane —
    `moveTask` alone walks the board without enqueuing. Driving the real handoff is what exercises
    `enqueueMergeQueueInTransaction`, which is the guard under test.
    */
    await store.handoffToReview(task.id, { ownerAgentId: null, evidence: { reason: "test", runId: "r1", agentId: "test" } } as never);

    /*
    Half one. With the literal, `taskRow.column !== "in-review"` rejected every card on this board and
    the enqueue recorded a `mergeQueue:enqueue-rejected` audit instead of a row — the merge queue was
    simply never used, and nothing surfaced that as an error.
    */
    expect(await store.getMergeQueuedTaskIdsAsync()).toContain(task.id);

    await store.moveTask(task.id, "building" as never, { bypassGuards: true } as never);

    /*
    Half two, and the one that fails independently: with dequeue on the literal, `previousColumn !==
    "in-review"` is true for `signoff`, so the helper returns early and the row stays. The queue would
    fill and never drain, and the leak only becomes visible on this second move.
    */
    expect(await store.getMergeQueuedTaskIdsAsync()).not.toContain(task.id);
  });

  it("does NOT dequeue when moving between two review lanes on the same board", async () => {
    /*
    The paired negative, and the reason the set is broad rather than `lifecycle.review`. A board may
    declare a merge-orchestration lane AND a separate human sign-off lane; a card moving between them
    has not left review. A single-id answer would treat the second lane as "outside review" and drop
    the card out of the merge queue mid-review.
    */
    const store = harness.store();
    const definition = await store.createWorkflowDefinition({
      name: "two-review-lanes",
      ir: {
        version: "v2",
        name: "two-review-lanes",
        columns: [
          { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
          { id: "signoff", name: "Signoff", traits: [{ trait: "merge" }] },
          { id: "approval", name: "Approval", traits: [{ trait: "human-review" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "inbox" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);
    const task = await store.createTask({ description: "two-lane card", workflowId: definition.id } as never);

    await store.handoffToReview(task.id, { ownerAgentId: null, evidence: { reason: "test", runId: "r1", agentId: "test" } } as never);
    expect(await store.getMergeQueuedTaskIdsAsync()).toContain(task.id);

    await store.moveTask(task.id, "approval" as never, { bypassGuards: true } as never);

    expect(await store.getMergeQueuedTaskIdsAsync()).toContain(task.id);
  });
});

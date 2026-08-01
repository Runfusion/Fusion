/*
FNXC:WorkflowLifecycleColumns 2026-07-30-15:10 (PR #2734 review — greptile, on my own code):

THE PRODUCER IS THE THING UNDER TEST, not the hook.

`moves.ts` builds `lifecycleColumnSets.review` and hands it to the default-workflow hooks. It built
that set from `columnsWithFlag(ir, "mergeOrchestration")` alone, so a workflow hosting review on a
`humanReview`-only lane produced an EMPTY review set — and `applyInReviewEnterEffects` then never ran
for a card plainly in review, leaving the recovery counters it clears set.

WHY THIS FILE EXISTS RATHER THAN A UNIT CASE. My first attempt asserted the hook directly, passing
`lifecycleColumnSets: { review: ["signoff"] }` by hand. That exercises the hook — which was already
correct — and passes with the producer's bug fully in place. Reverting the producer left it green.
Only driving a real move through a real store reaches the code that was wrong.

LANE. `.pg.test.ts`, skipped by `pgDescribe` when no PostgreSQL is reachable, so the merge gate is
unaffected. Throwaway per-file database; never port 4040.
*/
import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import "@fusion/core"; // registers the built-in column traits

import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../../__test-utils__/pg-test-harness.js";

pgDescribe("moves.ts supplies EVERY review lane to the lifecycle hooks", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_moves_review_set" });

  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(async () => { await harness.beforeEach(); });
  afterEach(async () => { await harness.afterEach(); });

  it("runs the in-review enter effects for a humanReview-ONLY lane", async () => {
    const store = harness.store();
    const definition = await store.createWorkflowDefinition({
      name: "human-review-only",
      ir: {
        version: "v2",
        name: "human-review-only",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          /* No `merge` trait: review is hosted by human-review alone. */
          { id: "signoff", name: "Sign-off", traits: [{ trait: "human-review" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);

    const task = await store.createTask({ description: "human-review card", workflowId: definition.id } as never);
    await store.moveTask(task.id, "building" as never, { bypassGuards: true } as never);

    /*
    The witness: `applyInReviewEnterEffects` clears `recoveryRetryCount`. Seed it so its absence after
    the move can only mean the enter-effects ran.
    */
    await store.updateTask(task.id, { recoveryRetryCount: 3 } as never);
    store.taskCache.delete(task.id);
    expect((await store.getTask(task.id)).recoveryRetryCount).toBe(3);

    await store.moveTask(task.id, "signoff" as never, { bypassGuards: true } as never);

    store.taskCache.delete(task.id);
    const moved = await store.getTask(task.id);
    expect(moved.column).toBe("signoff");
    expect(moved.recoveryRetryCount).toBeUndefined();
  });

  it("does NOT run them entering a lane that carries no review trait", async () => {
    /* The negative half: widening the set must not make every column a review lane. */
    const store = harness.store();
    const definition = await store.createWorkflowDefinition({
      name: "human-review-only-neg",
      ir: {
        version: "v2",
        name: "human-review-only-neg",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "signoff", name: "Sign-off", traits: [{ trait: "human-review" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);

    const task = await store.createTask({ description: "non-review move", workflowId: definition.id } as never);
    await store.updateTask(task.id, { recoveryRetryCount: 3 } as never);

    await store.moveTask(task.id, "building" as never, { bypassGuards: true } as never);

    store.taskCache.delete(task.id);
    expect((await store.getTask(task.id)).recoveryRetryCount).toBe(3);
  });
});

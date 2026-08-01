/*
FNXC:WorkflowResolvedColumns 2026-07-30-02:20 (merge re-enqueue was BROKEN on a renamed board):

`enqueueMergeQueueInTransaction` gates on the task's column being a review column, and takes the
board's review columns as an optional trailing argument. The two `moves.ts` callers — the automatic
handoff-to-review path — resolved and passed them. The public `enqueueMergeQueue` wrapper reached
through `store.enqueueMergeQueue` did not, so it fell back to `new Set(["in-review"])`.

The consequence is not the usual quiet legacy-id degradation. The guard's reject branch records
`mergeQueue:enqueue-rejected` and THROWS `MergeQueueInvalidColumnError`. So on any board whose review
lane is renamed, every re-enqueue through the store method failed outright — and its production
callers are `merger.ts` and `self-healing.ts`, i.e. the merge and recovery paths.

WHY IT SURVIVED. Partial supply. Two of three call sites passed the argument, so a check asking
"does SOME caller supply this?" reported the seam as satisfied, and the census counted the
conversion. Nothing looked at whether EVERY caller supplied it.

THE CASES ARE DIFFERENTIAL: the same enqueue against two vocabularies whose roles are identical and
only the ids differ. `checking` collides with no legacy literal, so a surviving `"in-review"` cannot
pass by luck.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";

pgDescribe("merge-queue enqueue under a renamed review column", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_mq_renamed_review",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /**
   * The BUILTIN coding workflow with its column ids renamed — nothing else changed.
   *
   * Deriving from the builtin rather than hand-rolling a graph keeps the ONLY difference between the
   * two runs the vocabulary, which is the whole differential claim. A hand-built fixture ends up
   * testing the fixture's transition table as much as the code.
   */
  async function seedRenamedWorkflow(): Promise<string> {
    const RENAME: Record<string, string> = {
      todo: "drafting",
      "in-progress": "building",
      "in-review": "checking",
      done: "shipped",
    };
    const rename = (id: string | undefined) => (id && RENAME[id]) ?? id;
    const ir = JSON.parse(JSON.stringify(BUILTIN_CODING_WORKFLOW_IR)) as {
      id: string;
      nodes?: { column?: string }[];
      columns?: { id: string }[];
    };
    ir.id = "custom:renamed-review-merge-queue";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    /* Prove the rename landed: without it a surviving "in-review" literal would pass by accident. */
    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("checking");
    expect(ids).not.toContain("in-review");

    const created = await h.store().createWorkflowDefinition({
      name: "Renamed Review (merge queue)",
      kind: "workflow",
      ir,
    } as never);
    return (created as { id: string }).id;
  }

  /**
   * A task walked into the board's review lane. `path` walks the graph rather than jumping, because
   * moves are transition-validated and a direct hop is rejected under BOTH vocabularies.
   */
  async function seedTaskInReviewLane(path: readonly string[], workflowId?: string): Promise<string> {
    const store = h.store();
    const task = await store.createTask({
      title: "awaiting merge",
      description: "test",
      column: "todo",
    });
    if (workflowId) await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    for (const step of path) await store.moveTask(task.id, step as never);
    store.taskCache.delete(task.id);

    /* Prove the fixture before asserting on it: a task that never reached the review lane would
       fail to enqueue for a reason that has nothing to do with column vocabulary. */
    const seeded = await store.getTask(task.id);
    expect(seeded.column).toBe(path[path.length - 1]);
    return task.id;
  }

  /* Control: the default vocabulary enqueues. Passes before and after the fix, so a generally
     broken enqueue path cannot hide behind the renamed case below. */
  it("default vocabulary: a task in the review lane enqueues for merge", async () => {
    const id = await seedTaskInReviewLane(["in-progress", "in-review"]);

    const entry = await h.store().enqueueMergeQueue(id);

    expect(entry.taskId).toBe(id);
  });

  /*
  The defect. Before the fix this threw `MergeQueueInvalidColumnError`, because the wrapper omitted
  the board's review columns and the guard compared `checking` against the legacy `in-review`.
  */
  it("renamed vocabulary: a task in the RENAMED review lane enqueues for merge", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedTaskInReviewLane(["drafting", "building", "checking"], wf);

    const entry = await h.store().enqueueMergeQueue(id);

    expect(entry.taskId).toBe(id);
  });

  /*
  The paired negative, and the reason this is a supply fix rather than a deleted guard: the gate must
  still REJECT a task that is not in a review lane at all. Wiring the real columns must not degrade
  into "every column is a review column", which would let work merge straight out of the WIP lane.
  */
  it("renamed vocabulary: a task in the WIP lane is still REJECTED", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedTaskInReviewLane(["drafting", "building"], wf);

    await expect(h.store().enqueueMergeQueue(id)).rejects.toThrow();
  });

  /* Same negative under the default vocabulary, so the rejection is not an artifact of the rename. */
  it("default vocabulary: a task in the WIP lane is still REJECTED", async () => {
    const id = await seedTaskInReviewLane(["in-progress"]);

    await expect(h.store().enqueueMergeQueue(id)).rejects.toThrow();
  });
});

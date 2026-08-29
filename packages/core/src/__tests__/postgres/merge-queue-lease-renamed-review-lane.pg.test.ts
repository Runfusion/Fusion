/*
FNXC:WorkflowResolvedColumns 2026-07-30-14:35 (#2819 review — greptile, "renamed entries remain unleaseable"):

A QUEUED CARD ON A RENAMED BOARD MUST ACTUALLY BE LEASEABLE.

The first pass on this PR taught only the STALE SWEEP to resolve review lanes, so the row survived
cleanup — and then both eligibility predicates in `acquireMergeQueueLease` still demanded the literal
`in-review`, matched nothing, and the row sat in the queue forever. That is a worse failure than the
one it replaced: a deleted row at least emits `mergeQueue:auto-cleanup-stale-row`, while an
unleaseable row is a silent permanent stall with a healthy-looking queue.

WHY THE SWEEP FIX ALONE LOOKED GREEN. Its test asserted the row still EXISTS after acquisition. Row
survival and row leaseability are different questions, and the sweep fix answered only the first —
the acquire returning `null` was consistent with an empty queue and nothing distinguished them. So
these cases assert the LEASE, which is the outcome the merger actually depends on.

BOTH ACQUIRE MODES ARE COVERED. Targeted acquire (`targetTaskId`) and queue-head acquire are separate
code paths with separate predicates; the merger uses targeted, self-healing recovery uses the head.
Converting one and leaving the other is the half-converted-pair shape this program keeps hitting.

WHY A LIVE STORE. The predicate is SQL evaluated by PostgreSQL against a column id that comes from
the task's own persisted workflow. A mock cannot exercise it at all.

LANE. `.pg.test.ts`, skipped by `pgDescribe` when PostgreSQL is unreachable; throwaway per-file
database; never port 4040.
*/

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../../index.js";

pgDescribe("merge-queue lease acquisition under a renamed review lane", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_mq_lease_renamed",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /**
   * The BUILTIN coding workflow with its column ids renamed and nothing else changed, so the only
   * difference between the control and the defect case is the vocabulary. `checking` collides with no
   * legacy literal, so a surviving `"in-review"` cannot pass by luck.
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
    ir.id = "custom:renamed-review-merge-queue-lease";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;

    const ids = (ir.columns ?? []).map((column) => column.id);
    expect(ids).toContain("checking");
    expect(ids).not.toContain("in-review");

    const created = await h.store().createWorkflowDefinition({
      name: "Renamed Review (merge queue lease)",
      kind: "workflow",
      ir,
    } as never);
    return (created as { id: string }).id;
  }

  /** A card walked into its board's review lane and enqueued for merge. */
  async function seedQueuedTask(path: readonly string[], workflowId?: string): Promise<string> {
    const store = h.store();
    const task = await store.createTask({ title: "awaiting merge", description: "test", column: "todo" });
    if (workflowId) await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    for (const step of path) await store.moveTask(task.id, step as never);
    store.taskCache.delete(task.id);

    /* Prove the fixture: an unqueued card would fail to lease for a reason unrelated to vocabulary. */
    const entry = await store.enqueueMergeQueue(task.id);
    expect(entry.taskId).toBe(task.id);
    return task.id;
  }

  /* Control. Passes before and after the fix, so a generally broken acquire cannot hide below. */
  it("default vocabulary: a queued card can be leased by the queue head", async () => {
    const id = await seedQueuedTask(["in-progress", "in-review"]);

    const lease = await h.store().acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000 });

    expect(lease?.taskId).toBe(id);
  });

  /*
  The defect, queue-head mode. Before the fix the head SELECT joined on
  `tasks.column = 'in-review'`, matched no row on this board, and returned null — the merger saw an
  empty queue while the card sat in it.
  */
  it("renamed vocabulary: a queued card can be leased by the QUEUE HEAD", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedQueuedTask(["drafting", "building", "checking"], wf);

    const lease = await h.store().acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000 });

    expect(lease?.taskId).toBe(id);
  });

  /*
  The defect, targeted mode — the path the merger itself uses. Separate predicate, separate failure:
  the candidate SELECT found nothing, so this recorded `mergeQueue:lease-target-unavailable` and
  returned null without ever attempting the update.
  */
  it("renamed vocabulary: a queued card can be leased by TARGETED acquire", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedQueuedTask(["drafting", "building", "checking"], wf);

    const lease = await h
      .store()
      .acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000, targetTaskId: id });

    expect(lease?.taskId).toBe(id);
  });

  /*
  The paired negative, and the reason this is a resolved-lane fix rather than a deleted predicate. A
  card that has LEFT review must not be leaseable — otherwise the merger would merge work that was
  pulled back for rework. Widening to "any column is a review column" would pass every case above and
  break exactly this one.
  */
  it("renamed vocabulary: a card moved BACK out of the review lane is not leaseable", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedQueuedTask(["drafting", "building", "checking"], wf);
    await h.store().moveTask(id, "building" as never);
    h.store().taskCache.delete(id);

    const lease = await h
      .store()
      .acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000, targetTaskId: id });

    expect(lease).toBeNull();
  });
});

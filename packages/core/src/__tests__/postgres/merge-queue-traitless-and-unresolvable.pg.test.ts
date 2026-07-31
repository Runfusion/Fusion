/*
FNXC:WorkflowResolvedColumns 2026-07-30-15:30 (#2819 review — greptile, two findings):

THE TWO WAYS THIS CONVERSION COULD RE-CREATE THE BUG IT FIXES.

Both are the same mistake in different clothes — treating "I have no answer" as "the answer is no
review lane" — and both land on boards that are not even custom.

  1. TRAITLESS (v1-UPGRADED) BOARDS. `synthesizeDefaultColumns` (workflow-ir.ts:158) upgrades a v1
     graph by emitting the default column ids with `traits: []`. `resolveReviewColumns` therefore
     returns EMPTY while the board's `in-review` column plainly exists and holds the card. Forwarding
     that empty set to the enqueue guard makes it match nothing and throw
     `MergeQueueInvalidColumnError` — moving the failure off custom boards and onto EVERY pre-v2
     project. Three states, not two: unreadable and traitless both take the legacy id; only a board
     that expresses traits and still declares no review lane is answering.

  2. FAILED RESOLUTION DURING THE STALE SWEEP. The sweep's SQL predicate is a candidate superset and
     each row is verified per task before deletion. The first pass deleted a row whose resolution
     FAILED, which is the original bug behind a narrower trigger: a transient workflow-read failure
     silently drops a valid card out of the merge queue, with an audit event claiming
     `reason: "not-in-review"` for a task sitting in review. Sparing is recoverable (the lease
     predicates refuse it anyway, and the next sweep removes it once resolution succeeds); deleting
     is not.

WHY A LIVE STORE. Both defects live in the seam between a resolver and SQL evaluated by PostgreSQL.
A mock supplying a lifecycle struct would assert my own assumption about what the resolver returns,
which is the substitution that has produced vacuous tests throughout this program.

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

pgDescribe("merge queue on traitless and unresolvable workflows", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_mq_traitless",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /**
   * A v1 graph. The store upgrades it on read, and the upgrade emits the DEFAULT column ids with
   * EMPTY trait arrays — the exact shape that makes `resolveReviewColumns` return nothing while
   * `in-review` exists. Written as v1 on purpose: hand-authoring a v2 board with `traits: []` would
   * be my reconstruction of the upgrade rather than the upgrade itself.
   */
  async function seedV1Workflow(): Promise<string> {
    const created = await h.store().createWorkflowDefinition({
      name: "Legacy v1 (traitless after upgrade)",
      kind: "workflow",
      ir: {
        version: "v1",
        name: "legacy-v1",
        nodes: [
          { id: "start", kind: "start" },
          { id: "impl", kind: "agent", seam: "execute" },
          { id: "review", kind: "agent", seam: "review" },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "impl" },
          { from: "impl", to: "review" },
          { from: "review", to: "end" },
        ],
      },
    } as never);
    return (created as { id: string }).id;
  }

  async function seedTaskInReview(workflowId: string): Promise<string> {
    const store = h.store();
    const task = await store.createTask({ title: "v1 card", description: "test", column: "todo" });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    for (const step of ["in-progress", "in-review"]) await store.moveTask(task.id, step as never);
    store.taskCache.delete(task.id);

    /* Prove the fixture before asserting on it. */
    expect((await store.getTask(task.id)).column).toBe("in-review");
    return task.id;
  }

  /*
  Finding 1. Before the three-state guard this threw `MergeQueueInvalidColumnError`: the upgraded
  board resolved to an empty review set, so the guard compared `in-review` against nothing.
  */
  it("a v1-upgraded (traitless) board still enqueues a card resting in `in-review`", async () => {
    const wf = await seedV1Workflow();
    const id = await seedTaskInReview(wf);

    const entry = await h.store().enqueueMergeQueue(id);

    expect(entry.taskId).toBe(id);
  });

  /*
  Finding 1, continued — the enqueue is worth nothing if the row cannot then be leased. The lease
  predicate resolves the same set, so an empty answer would stall the queue rather than throw, which
  is the quieter half of the same defect.
  */
  it("a v1-upgraded (traitless) board can then LEASE the queued card", async () => {
    const wf = await seedV1Workflow();
    const id = await seedTaskInReview(wf);
    await h.store().enqueueMergeQueue(id);

    const lease = await h.store().acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000 });

    expect(lease?.taskId).toBe(id);
  });

  /**
   * A RENAMED board, needed for finding 2 and not interchangeable with the v1 one.
   *
   * The sweep's SQL selects a CANDIDATE SUPERSET — `column IS DISTINCT FROM 'in-review'` — and only
   * candidates reach the per-task verification the finding is about. A v1-upgraded board uses the
   * DEFAULT ids, so its card sits in `in-review` and is never a candidate: written against it, the
   * case below passes with the fix reverted. I found that by mutating, not by reading.
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
    ir.id = "custom:traitless-sweep-renamed";
    for (const node of ir.nodes ?? []) node.column = rename(node.column);
    for (const column of ir.columns ?? []) column.id = rename(column.id) as string;
    expect((ir.columns ?? []).map((c) => c.id)).toContain("checking");

    const created = await h.store().createWorkflowDefinition({
      name: "Renamed (sweep verification)",
      kind: "workflow",
      ir,
    } as never);
    return (created as { id: string }).id;
  }

  async function seedRenamedTaskInReview(workflowId: string): Promise<string> {
    const store = h.store();
    const task = await store.createTask({ title: "renamed card", description: "test", column: "todo" });
    await store.writeTaskWorkflowSelection(task.id, workflowId, []);
    for (const step of ["drafting", "building", "checking"]) await store.moveTask(task.id, step as never);
    store.taskCache.delete(task.id);
    expect((await store.getTask(task.id)).column).toBe("checking");
    return task.id;
  }

  /*
  Finding 2. A resolver that THROWS stands in for a transient workflow-read failure. The row must
  survive the sweep: deletion is unrecoverable, and the acquire that follows refuses the lease anyway
  because it resolves the same lanes. Asserting the row is still queued afterwards is the point —
  the previous behaviour deleted it and reported an empty queue as normal.
  */
  it("a row whose workflow cannot be resolved is SPARED by the stale sweep, not deleted", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedRenamedTaskInReview(wf);
    await h.store().enqueueMergeQueue(id);

    await h.store().acquireMergeQueueLease("worker-1", {
      leaseDurationMs: 60_000,
      resolveReviewColumnsFor: async () => {
        throw new Error("transient workflow read failure");
      },
    });

    expect(await h.store().getMergeQueuedTaskIdsAsync()).toContain(id);
  });

  /*
  The paired negative: sparing on failure must not become "never clean anything up". A row whose task
  has genuinely left review, with resolution WORKING, is still deleted.
  */
  it("a row whose task genuinely left the review lane is still swept", async () => {
    const wf = await seedRenamedWorkflow();
    const id = await seedRenamedTaskInReview(wf);
    await h.store().enqueueMergeQueue(id);
    await h.store().moveTask(id, "building" as never);
    h.store().taskCache.delete(id);

    await h.store().acquireMergeQueueLease("worker-1", { leaseDurationMs: 60_000 });

    expect(await h.store().getMergeQueuedTaskIdsAsync()).not.toContain(id);
  });
});

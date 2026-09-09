/*
FNXC:WorkflowWorkItemCas 2026-07-27-22:10 (U7, PR #2491 review — greptile P1):

`WorkflowWorkItemTransitionPatch.expectedState` is a compare-and-set guard: the
transition applies only if the row's state read INSIDE the transaction still
equals it, and is otherwise a no-op returning the row untouched.

WHY IT EXISTS: a caller that decided from a due-poll SNAPSHOT and then writes
unconditionally can clobber a newer state another node reached in between. The
concrete case is the planning drain's fairness deferral — it pushes an
operator-parked item's `retryAfter` forward so the item stops re-filling the FIFO
due batch. Written blind, that would reset a `running` claim back to `runnable`
and let the item be claimed twice. The pre-existing terminal-state check already
refuses cancelled/succeeded/failed (it throws), so `running` was the one
unguarded state, and it is the one a live worker holds.

Losing the CAS is an ordinary outcome for a snapshot-driven caller, not an error —
hence a silent no-op rather than a throw. A throw would push every caller into a
try/catch whose only correct body is "do nothing".

These run against real PostgreSQL through the shared harness, so the guard is
proven where it actually lives: inside the transaction that re-reads the row.
*/
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../__test-utils__/pg-test-harness.js";
import * as schema from "../postgres/schema/index.js";

function continuation(taskId: string) {
  return {
    runId: `${taskId}:continuation:cas`,
    taskId,
    nodeId: "plan-review",
    kind: "task" as const,
    state: "runnable" as const,
    stableWorkflowRunId: `${taskId}:workflow`,
    continuationSequence: 0,
    waitReason: "planning" as const,
    sourceColumn: "todo",
    targetColumn: "todo",
    irHash: "ir-test",
  };
}

const LATER = "2026-07-27T12:01:00.000Z";

pgDescribe("workflow work-item transition compare-and-set", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_workitem_cas" });
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("applies the patch when the observed state still matches (the control)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "cas match", column: "todo" });
    const item = await store.upsertWorkflowWorkItem(continuation(task.id));

    const result = await store.transitionWorkflowWorkItem(item.id, "runnable", {
      expectedState: "runnable",
      retryAfter: LATER,
    });

    expect(result.state).toBe("runnable");
    expect(result.retryAfter).toBe(LATER);
  });

  it("is a silent NO-OP when another writer claimed the item first — the claim is not reset", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "cas claim race", column: "todo" });
    const item = await store.upsertWorkflowWorkItem(continuation(task.id));

    // Another node claims it after our snapshot said `runnable`.
    const claimed = await store.transitionWorkflowWorkItem(item.id, "running", {
      leaseOwner: "other-node",
    });
    expect(claimed.state).toBe("running");

    // Our snapshot-driven deferral now loses the CAS.
    const result = await store.transitionWorkflowWorkItem(item.id, "runnable", {
      expectedState: "runnable",
      retryAfter: LATER,
    });

    // The live claim survives untouched: state, owner, and retryAfter all unchanged.
    expect(result.state).toBe("running");
    expect(result.leaseOwner).toBe("other-node");
    expect(result.retryAfter).not.toBe(LATER);

    // And the persisted row agrees — not just the returned value.
    const persisted = (await store.listWorkflowWorkItemsForTask(task.id)).find((i) => i.id === item.id);
    expect(persisted?.state).toBe("running");
    expect(persisted?.leaseOwner).toBe("other-node");
    expect(persisted?.retryAfter).not.toBe(LATER);
  });

  it("is a silent NO-OP when the state matches but a successor owns the lease", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "lease-owner cas", column: "todo" });
    const item = await store.upsertWorkflowWorkItem({
      ...continuation(task.id),
      state: "running",
      leaseOwner: "triage:old-attempt",
      leaseExpiresAt: "2026-07-27T12:00:30.000Z",
    });
    await store.transitionWorkflowWorkItem(item.id, "running", {
      expectedState: "running",
      expectedLeaseOwner: "triage:old-attempt",
      leaseOwner: "workflow:new-attempt",
      leaseExpiresAt: "2026-07-27T12:02:00.000Z",
    });

    const staleRenewal = await store.transitionWorkflowWorkItem(item.id, "running", {
      expectedState: "running",
      expectedLeaseOwner: "triage:old-attempt",
      leaseOwner: "triage:old-attempt",
      leaseExpiresAt: LATER,
    });

    expect(staleRenewal).toMatchObject({
      state: "running",
      leaseOwner: "workflow:new-attempt",
      leaseExpiresAt: "2026-07-27T12:02:00.000Z",
    });
  });

  /*
  FNXC:WorkflowWorkItemLeaseCas 2026-09-06-01:52:
  A sequential owner replacement does not prove PostgreSQL's statement-time CAS. Hold the successor's
  uncommitted owner write open so the stale transition reads the old owner and then blocks on UPDATE;
  once the successor commits, the stale UPDATE must re-check its owner predicate and affect zero rows.
  */
  it("atomically loses an owner CAS when the owner changes between SELECT and UPDATE", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "lease-owner statement cas", column: "todo" });
    const item = await store.upsertWorkflowWorkItem({
      ...continuation(task.id),
      state: "running",
      leaseOwner: "triage:old-attempt",
      leaseExpiresAt: "2026-07-27T12:00:30.000Z",
    });
    const successorExpiry = "2026-07-27T12:02:00.000Z";
    let staleTransition!: ReturnType<typeof store.transitionWorkflowWorkItem>;

    await h.adminDb().transaction(async (tx) => {
      await tx.update(schema.project.workflowWorkItems)
        .set({
          leaseOwner: "workflow:new-attempt",
          leaseExpiresAt: successorExpiry,
        })
        .where(eq(schema.project.workflowWorkItems.id, item.id));

      const holderRows = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>;
      const holderPid = holderRows[0]?.pid;
      expect(holderPid).toBeTypeOf("number");

      staleTransition = store.transitionWorkflowWorkItem(item.id, "running", {
        expectedState: "running",
        expectedLeaseOwner: "triage:old-attempt",
        leaseOwner: "triage:old-attempt",
        leaseExpiresAt: LATER,
      });

      const blockProbeDeadline = Date.now() + 5_000;
      let blockedBySuccessor = false;
      while (!blockedBySuccessor && Date.now() < blockProbeDeadline) {
        const blockedRows = await tx.execute(sql`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity activity
            WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
          ) AS blocked
        `) as unknown as Array<{ blocked: boolean }>;
        blockedBySuccessor = blockedRows[0]?.blocked === true;
        if (!blockedBySuccessor) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedBySuccessor).toBe(true);
    });

    await expect(staleTransition).resolves.toMatchObject({
      state: "running",
      leaseOwner: "workflow:new-attempt",
      leaseExpiresAt: successorExpiry,
    });
    await expect(store.getWorkflowWorkItem(item.id)).resolves.toMatchObject({
      state: "running",
      leaseOwner: "workflow:new-attempt",
      leaseExpiresAt: successorExpiry,
    });
  });

  it("reclaims only a durable principal availability hold after it becomes due", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "availability hold recovery", column: "todo" });
    const held = await store.upsertWorkflowWorkItem({
      ...continuation(task.id),
      state: "held",
      blockedReason: "workflow-principal-named-principal-unavailable:executor",
    });

    const claimed = await store.acquireWorkflowWorkItemLease(held.id, "recovery-worker", {
      leaseDurationMs: 60_000,
      now: "2026-08-07T07:02:00.000Z",
    });

    expect(claimed).toMatchObject({
      id: held.id,
      state: "running",
      leaseOwner: "recovery-worker",
      blockedReason: "workflow-principal-named-principal-unavailable:executor",
    });
  });

  it("does not claim a generic held item through workflow recovery", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "manual hold remains inert", column: "todo" });
    const held = await store.upsertWorkflowWorkItem({
      ...continuation(task.id),
      state: "held",
      blockedReason: "operator-approval-required",
    });

    await expect(store.acquireWorkflowWorkItemLease(held.id, "recovery-worker", {
      leaseDurationMs: 60_000,
      now: "2026-08-07T07:02:00.000Z",
    })).resolves.toBeNull();
    expect((await store.getWorkflowWorkItem(held.id))?.state).toBe("held");
  });

  it("is a NO-OP rather than a throw for a terminalized item", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "cas terminal race", column: "todo" });
    const item = await store.upsertWorkflowWorkItem(continuation(task.id));
    await store.transitionWorkflowWorkItem(item.id, "cancelled", {});

    // Without the CAS this same call throws (terminal state); with it the guard
    // fires FIRST, so a snapshot-driven caller needs no try/catch to be correct.
    const result = await store.transitionWorkflowWorkItem(item.id, "runnable", {
      expectedState: "runnable",
      retryAfter: LATER,
    });

    expect(result.state).toBe("cancelled");
    expect(result.retryAfter).not.toBe(LATER);
  });

  it("without expectedState the pre-existing unconditional behavior is unchanged", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "cas omitted", column: "todo" });
    const item = await store.upsertWorkflowWorkItem(continuation(task.id));
    await store.transitionWorkflowWorkItem(item.id, "running", { leaseOwner: "other-node" });

    // No guard requested → the write lands, exactly as before this field existed.
    const result = await store.transitionWorkflowWorkItem(item.id, "runnable", { retryAfter: LATER });

    expect(result.state).toBe("runnable");
    expect(result.retryAfter).toBe(LATER);

    // And a terminal row still THROWS when no guard is requested.
    await store.transitionWorkflowWorkItem(item.id, "cancelled", {});
    await expect(
      store.transitionWorkflowWorkItem(item.id, "runnable", { retryAfter: LATER }),
    ).rejects.toThrow(/terminal/);
  });
});

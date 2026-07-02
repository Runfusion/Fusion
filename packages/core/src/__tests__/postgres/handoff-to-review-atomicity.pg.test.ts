/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:40:
 * PostgreSQL test for the handoff-to-review transactional invariant
 * (VAL-DATA-013 / review finding #12).
 *
 * The invariant: the column move, mergeQueue insert, workflow-work upsert, and
 * handoff audit fan-out must run in ONE transaction. An observer must never see
 * `column = "in-review"` without the matching merge_queue row, and an outer
 * rollback must never leave orphaned workflow_work_items committed.
 *
 * Review finding #12 documented that `createCompletionHandoffWorkflowWork`
 * runs its cancel/upsert in their OWN fresh-pool transactions, not the outer
 * handoff tx — so an outer rollback leaves committed workflow-work rows. This
 * test exercises both the happy-path atomicity and the rollback invariant so a
 * regression is caught.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { HandoffInvariantViolationError } from "../../task-store/errors.js";

const pgTest = pgDescribe;

pgTest("handoff-to-review transactional invariant (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_handoff_atomic",
  });

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("atomically moves column + enqueues merge queue + creates workflow work item", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "handoff happy path", column: "in-progress" });

    const moved = await store.handoffToReview(task.id, {
      ownerAgentId: "agent-1",
      evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" },
    });
    expect(moved.column).toBe("in-review");

    // VAL-DATA-013: the merge_queue row must exist alongside column=in-review.
    const queued = await store.getMergeQueuedTaskIdsAsync();
    expect(queued.has(task.id)).toBe(true);

    // The task row itself must be in-review in the database.
    const row = await h
      .adminDb()
      .select({ column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))
      .limit(1);
    expect(row[0]?.column).toBe("in-review");

    // A workflow work item for the completion-handoff must exist.
    const workItems = await h
      .adminDb()
      .select({ id: schema.project.workflowWorkItems.id, kind: schema.project.workflowWorkItems.kind })
      .from(schema.project.workflowWorkItems)
      .where(eq(schema.project.workflowWorkItems.taskId, task.id));
    expect(workItems.length).toBeGreaterThan(0);
    expect(workItems.some((wi) => wi.kind === "merge" || wi.kind === "manual-hold")).toBe(true);

    // A task:handoff audit row must exist.
    const audits = await h
      .adminDb()
      .select({ mutationType: schema.project.runAuditEvents.mutationType })
      .from(schema.project.runAuditEvents)
      .where(eq(schema.project.runAuditEvents.taskId, task.id));
    expect(audits.some((a) => a.mutationType === "task:handoff")).toBe(true);
  });

  it("rejects handoff of a soft-deleted task without partial writes", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "handoff deleted", column: "in-progress" });
    await store.deleteTask(task.id);

    await expect(
      store.handoffToReview(task.id, {
        ownerAgentId: "agent-1",
        evidence: { reason: "fn_task_done", runId: "run-2", agentId: "agent-1" },
      }),
    ).rejects.toBeInstanceOf(HandoffInvariantViolationError);

    // No partial writes: no merge_queue row, no workflow_work_item.
    const queued = await store.getMergeQueuedTaskIdsAsync();
    expect(queued.has(task.id)).toBe(false);
    const workItems = await h
      .adminDb()
      .select({ id: schema.project.workflowWorkItems.id })
      .from(schema.project.workflowWorkItems)
      .where(eq(schema.project.workflowWorkItems.taskId, task.id));
    expect(workItems.length).toBe(0);
  });

  /*
   * FNXC:FixPgTestsAndCi 2026-06-26-09:45:
   * Review finding #12: createCompletionHandoffWorkflowWork runs its cancel/
   * upsert in their OWN transactions (store.asyncLayer), NOT the outer handoff
   * tx. So an outer rollback leaves committed workflow_work_items — an
   * atomicity violation of VAL-DATA-013.
   *
   * FNXC:PostgresCutover 2026-06-27-10:30:
   * The outer tx is now threaded into createCompletionHandoffWorkflowWork,
   * so the workflow work item commits/rolls back with the handoff. This test
   * now passes (converted from it.fails to it).
   */
  it("rollback of the outer handoff tx must not leave orphaned workflow work items (#12)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "handoff rollback", column: "in-progress" });

    // Drive the handoff inside an outer transaction that we force to roll back
    // AFTER createCompletionHandoffWorkflowWork runs. If the workflow-work
    // upsert used the outer tx, the row is rolled back too. If it used its own
    // transaction (the #12 bug), the row survives the outer rollback.
    const layer = h.layer();
    let threw = false;
    try {
      await layer.transactionImmediate(async (tx) => {
        // Move the task column into in-review within this tx.
        await tx
          .update(schema.project.tasks)
          .set({ column: "in-review" })
          .where(eq(schema.project.tasks.id, task.id));
        // Run the completion-handoff workflow work creation. This currently
        // uses store.asyncLayer (its own pool), NOT the tx passed here.
        await store.createCompletionHandoffWorkflowWork(
          { id: task.id, autoMerge: true, priority: 0 },
          { runId: "run-rollback", now: new Date().toISOString(), source: "rollback-test" },
          tx,
        );
        // Force the outer transaction to roll back.
        throw new Error("__force_rollback__");
      });
    } catch (err) {
      if (err instanceof Error && err.message === "__force_rollback__") {
        threw = true;
      } else {
        throw err;
      }
    }
    expect(threw).toBe(true);

    // After the outer rollback, the task column must be back to in-progress
    // (the outer tx wrote in-review then rolled back).
    const taskRow = await h
      .adminDb()
      .select({ column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))
      .limit(1);
    expect(taskRow[0]?.column).toBe("in-progress");

    // INVARIANT (#12): the workflow work item must NOT survive the outer
    // rollback. If it does, createCompletionHandoffWorkflowWork is running
    // outside the handoff transaction and the atomicity invariant is broken.
    // This assertion is the regression guard for review finding #12.
    const leakedWorkItems = await h
      .adminDb()
      .select({ id: schema.project.workflowWorkItems.id, runId: schema.project.workflowWorkItems.runId })
      .from(schema.project.workflowWorkItems)
      .where(
        and(
          eq(schema.project.workflowWorkItems.taskId, task.id),
          eq(schema.project.workflowWorkItems.runId, "run-rollback"),
        ),
      );
    // NOTE: This assertion documents the expected invariant. If it fails, the
    // fix is to thread the outer `tx` into createCompletionHandoffWorkflowWork
    // (and its cancel/upsert children) so they participate in the handoff tx.
    expect(leakedWorkItems.length).toBe(0);
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;

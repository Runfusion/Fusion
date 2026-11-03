/*
FNXC:ReviewLaneDispatch 2026-09-09-00:00 (STAS-205):
The dispatch invariant is only auditable if a card's arrival in the review lane is a committed
fact, whichever path wrote the column. These tests pin the store-chokepoint write against real
PostgreSQL: exactly one `task:entered-review` row per genuine crossing (the `moveSource: "user"`
path is the CLI-direct and dashboard-drag path, because the CLI bundle links this same store
code), no row for a same-column move or a non-review transition, a payload naming the previous
column, the target column and the writer, project scoping equal to the task's own partition, and
an append that shares the move's transaction so a failure cannot leave a move without its event
or an event without its move.
*/
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { appendTaskLifecycleEventInTransaction } from "../../task-store/lifecycle-outbox.js";

const pgTest = pgDescribe;
const REVIEW = "in-review";

type EntryPath = { label: string; moveSource: "user" | "engine" | "scheduler"; workflowMoveSource?: string };

pgTest("task:entered-review lifecycle write at the move chokepoint (PostgreSQL)", () => {
  let h: PgTestHarness | undefined;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  async function taskProjectId(taskId: string): Promise<string> {
    const rows = await h!.layer.db
      .select({ projectId: schema.project.tasks.projectId })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, taskId))
      .limit(1);
    return rows[0]!.projectId;
  }

  function entryRows(taskId: string, projectId: string) {
    return h!.layer.db
      .select()
      .from(schema.project.taskLifecycleEvents)
      .where(and(
        eq(schema.project.taskLifecycleEvents.projectId, projectId),
        eq(schema.project.taskLifecycleEvents.taskId, taskId),
        eq(schema.project.taskLifecycleEvents.eventType, "task:entered-review"),
      ));
  }

  it("records exactly one review-entry event per entry path, with from, to, and the writer", async () => {
    h = await createTaskStoreForTest({ prefix: "review_entry_paths", copyFromGolden: true });

    const paths: EntryPath[] = [
      { label: "dashboard drag / CLI-direct", moveSource: "user" },
      { label: "engine move", moveSource: "engine" },
      { label: "scheduler move", moveSource: "scheduler" },
      { label: "workflow-graph move", moveSource: "engine", workflowMoveSource: "workflow-graph" },
    ];

    for (const path of paths) {
      const task = await h.store.createTask({ description: `entry path: ${path.label}`, column: "in-progress" });
      await h.store.moveTask(task.id, REVIEW, {
        moveSource: path.moveSource,
        workflowMoveSource: path.workflowMoveSource,
        allowDirectInReviewMove: true,
      });

      const projectId = await taskProjectId(task.id);
      const rows = await entryRows(task.id, projectId);
      expect(rows, path.label).toHaveLength(1);

      const [row] = rows;
      expect(row!.eventType).toBe("task:entered-review");
      expect(row!.projectId).toBe(projectId);
      expect(row!.occurredAt).toBeTruthy();
      expect(row!.payload).toMatchObject({
        taskId: task.id,
        previousColumn: "in-progress",
        toColumn: REVIEW,
        actor: path.moveSource,
      });
    }
  });

  it("records one event for a completion handoff and no second event for its idempotent retry", async () => {
    h = await createTaskStoreForTest({ prefix: "review_entry_handoff", copyFromGolden: true });
    const task = await h.store.createTask({ description: "handoff entry", column: "in-progress" });

    const evidence = { reason: "fn_task_done", runId: "run-1", agentId: "agent-1" };
    await h.store.handoffToReview(task.id, { ownerAgentId: "agent-1", evidence });
    const projectId = await taskProjectId(task.id);
    const afterHandoff = await entryRows(task.id, projectId);
    expect(afterHandoff).toHaveLength(1);
    expect(afterHandoff[0]!.payload).toMatchObject({ previousColumn: "in-progress", toColumn: REVIEW });

    await h.store.handoffToReview(task.id, { ownerAgentId: "agent-1", evidence: { ...evidence, runId: "run-2" } });
    expect(await entryRows(task.id, projectId), "a same-column retry is not a new entry").toHaveLength(1);
  });

  it("writes nothing for a non-review transition or a same-column move", async () => {
    h = await createTaskStoreForTest({ prefix: "review_entry_noop", copyFromGolden: true });
    const task = await h.store.createTask({ description: "no-op guard" });
    const projectId = await taskProjectId(task.id);

    await h.store.moveTask(task.id, "in-progress", { moveSource: "engine" });
    expect(await entryRows(task.id, projectId), "implementation progress is not a lane entry").toHaveLength(0);

    await h.store.moveTask(task.id, REVIEW, { moveSource: "engine", allowDirectInReviewMove: true });
    expect(await entryRows(task.id, projectId)).toHaveLength(1);

    await h.store.moveTask(task.id, REVIEW, { moveSource: "engine", allowDirectInReviewMove: true });
    expect(await entryRows(task.id, projectId), "the no-op move must not fabricate a second entry").toHaveLength(1);
  });

  it("rolls the event and the move back together, and accepts no other event type", async () => {
    h = await createTaskStoreForTest({ prefix: "review_entry_atomic", copyFromGolden: true });
    const task = await h.store.createTask({ description: "atomic append", column: "in-progress" });
    const projectId = await taskProjectId(task.id);

    await expect(h.layer.transactionImmediate(async (tx) => {
      await tx.update(schema.project.tasks).set({ column: REVIEW }).where(eq(schema.project.tasks.id, task.id));
      await appendTaskLifecycleEventInTransaction(tx, {
        projectId,
        eventType: "task:entered-review",
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: { taskId: task.id, previousColumn: "in-progress", toColumn: REVIEW, enteredAt: new Date().toISOString(), actor: "engine" },
      });
      throw new Error("__force_rollback__");
    })).rejects.toThrow("__force_rollback__");

    expect(await entryRows(task.id, projectId), "an event cannot survive a rolled-back move").toHaveLength(0);
    const rolledBack = await h.layer.db
      .select({ column: schema.project.tasks.column })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))
      .limit(1);
    expect(rolledBack[0]!.column, "a rolled-back event cannot leave the move committed").toBe("in-progress");

    const refused = await h.layer.transactionImmediate(async (tx) => {
      await appendTaskLifecycleEventInTransaction(tx, {
        projectId,
        eventType: "task:review-dispatched" as "task:deleted",
        taskId: task.id,
        occurredAt: new Date().toISOString(),
        payload: {},
      });
    }).then(() => undefined).catch((error: unknown) => error as { message?: string; cause?: { message?: string } });

    expect(refused, "an event type outside the widened CHECK must be refused").toBeTruthy();
    const constraint = await h.layer.db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'task_lifecycle_events_type_check'
    `) as unknown as Array<{ def: string }>;
    expect(constraint[0]!.def).toContain("task:deleted");
    expect(constraint[0]!.def).toContain("task:entered-review");
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;

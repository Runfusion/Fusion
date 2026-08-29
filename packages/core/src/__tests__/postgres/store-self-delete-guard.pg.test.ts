/**
 * FNXC:TaskDeletion 2026-07-01-00:00:
 * PostgreSQL twin of origin/main's `store-self-delete-guard.test.ts` (FN-7411).
 *
 * The SQLite original constructs a store via `store-test-helpers.ts`, which the
 * SQLite-to-PostgreSQL cutover quarantined (the sync SQLite Database class body
 * was removed under VAL-REMOVAL-005). The invariant it protects — a task-bound
 * runtime caller must never soft-delete the task it is currently executing —
 * had zero PostgreSQL coverage after the merge, so this twin exercises the
 * guard against the real PostgreSQL backend path (`deleteTaskBackendImpl`).
 *
 * The guard fires before any mutation, branch cleanup, or `task:deleted` audit
 * emission, so a rejected self-delete leaves the row untouched while a
 * cross-task delete proceeds normally.
 */

import { afterEach, beforeEach, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { TaskSelfDeleteError } from "../../task-store/errors.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

pgTest("TaskStore.deleteTask self-delete guard (FN-7411, PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_self_delete",
  });

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("rejects when the audit context task is the deletion target before any mutation", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "self", description: "do not delete self", column: "in-progress" });

    await expect(
      store.deleteTask(task.id, {
        auditContext: { agentId: "agent-test", runId: "run-test", taskId: task.id },
      }),
    ).rejects.toBeInstanceOf(TaskSelfDeleteError);

    // No mutation, no branch cleanup, no audit: the row stays live.
    const row = await h
      .adminDb()
      .select({ deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))
      .limit(1);
    expect(row[0]?.deletedAt).toBeNull();
  });

  it("allows a task-bound caller to delete a different task", async () => {
    const store = h.store();
    const caller = await store.createTask({ title: "caller", description: "current task", column: "in-progress" });
    const target = await store.createTask({ title: "target", description: "cleanup target", column: "todo" });

    await expect(
      store.deleteTask(target.id, {
        auditContext: { agentId: "agent-test", runId: "run-test", taskId: caller.id },
      }),
    ).resolves.toMatchObject({ id: target.id });

    const row = await h
      .adminDb()
      .select({ deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, target.id))
      .limit(1);
    expect(row[0]?.deletedAt).toBeTruthy();
  });

  it("allows deletion when no auditContext.taskId is supplied (back-compat)", async () => {
    const store = h.store();
    const target = await store.createTask({ title: "untagged", description: "no caller id", column: "todo" });

    await expect(store.deleteTask(target.id)).resolves.toMatchObject({ id: target.id });

    const row = await h
      .adminDb()
      .select({ deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, target.id))
      .limit(1);
    expect(row[0]?.deletedAt).toBeTruthy();
  });
});

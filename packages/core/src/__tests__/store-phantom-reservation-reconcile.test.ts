import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

/*
 * FNXC:TaskStoreConsistency 2026-07-12-00:00:
 * FN-7069 phantom committed-reservation archive-path tests.
 * The reconciliation logic (reconcilePhantomCommittedReservations) is a
 * PostgreSQL reconciliation preserves committed reservations and audit history
 * while removing orphaned task child rows.
 */

pgTest("TaskStore phantom committed-reservation reconciliation", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_phantom_res",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  it("archiveTask rejects cleanly when neither DB row nor task.json exists", async () => {
    const store = h.store();
    await expect(store.archiveTask("FN-7999")).rejects.toThrow("Task FN-7999 not found");
    await expect(store.archiveTask("FN-7999")).rejects.not.toThrow(/ENOENT/);
  });

  it("archives a DB-backed task even when its task directory is missing", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "Archive without task dir" });
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });

    const archived = await store.archiveTask(task.id, false);
    expect(archived).toMatchObject({ id: task.id, column: "archived" });
  });

  it("prunes PostgreSQL child rows for a phantom while preserving the committed reservation", async () => {
    const store = h.store();
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const task = await store.createTask({ description: "Phantom committed reservation" });
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });
    await layer.db.delete(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, task.id),
    ));
    await layer.db.insert(schema.project.activityLog).values({
      projectId,
      id: `activity-${task.id}`,
      timestamp: new Date().toISOString(),
      type: "task:created",
      taskId: task.id,
      details: "orphan activity",
    });
    await layer.db.insert(schema.project.agents).values({
      projectId,
      id: `agent-${task.id}`,
      name: "Phantom agent",
      role: "executor",
      taskId: task.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await store.reconcilePhantomCommittedReservations();

    expect(result.reconciled).toContain(task.id);
    expect(await layer.db.select().from(schema.project.activityLog).where(eq(schema.project.activityLog.taskId, task.id))).toHaveLength(0);
    expect(await layer.db.select().from(schema.project.agents).where(eq(schema.project.agents.taskId, task.id))).toHaveLength(0);
    const reservations = await layer.db.select().from(schema.project.distributedTaskIdReservations).where(and(
      eq(schema.project.distributedTaskIdReservations.projectId, projectId),
      eq(schema.project.distributedTaskIdReservations.taskId, task.id),
    ));
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe("committed");
    expect(await layer.db.select().from(schema.project.runAuditEvents).where(and(
      eq(schema.project.runAuditEvents.taskId, task.id),
      eq(schema.project.runAuditEvents.mutationType, "task:reconcile-phantom-committed-reservation"),
    ))).toHaveLength(1);
  });

  it("batch-reconciles multiple phantoms while retaining represented reservations", async () => {
    const store = h.store();
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const phantomTasks = await Promise.all([
      store.createTask({ description: "Batch phantom one" }),
      store.createTask({ description: "Batch phantom two" }),
    ]);
    const represented = await store.createTask({ description: "Still represented" });
    for (const task of phantomTasks) {
      await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });
    }
    await layer.db.delete(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId),
      // Both IDs are removed in one setup mutation, mirroring the batch repair.
      inArray(schema.project.tasks.id, phantomTasks.map((task) => task.id)),
    ));
    await layer.db.insert(schema.project.activityLog).values(phantomTasks.map((task) => ({
      projectId,
      id: `batch-activity-${task.id}`,
      timestamp: new Date().toISOString(),
      type: "task:created",
      taskId: task.id,
      details: "orphan activity",
    })));

    const result = await store.reconcilePhantomCommittedReservations();
    expect(result.reconciled).toEqual(expect.arrayContaining(phantomTasks.map((task) => task.id)));
    expect(result.skipped).toContainEqual({ id: represented.id, reason: "task-row-present" });
    expect(await layer.db.select().from(schema.project.activityLog).where(
      inArray(schema.project.activityLog.taskId, phantomTasks.map((task) => task.id)),
    )).toHaveLength(0);
  });

  it("does not prune a reservation represented by an archive row", async () => {
    const store = h.store();
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const task = await store.createTask({ description: "Archive representation guard" });
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });
    await layer.db.delete(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, task.id),
    ));
    await layer.db.insert(schema.project.archivedTasks).values({
      id: task.id,
      projectId,
      data: JSON.stringify(task),
      archivedAt: new Date().toISOString(),
    });

    const result = await store.reconcilePhantomCommittedReservations();

    expect(result.reconciled).not.toContain(task.id);
    expect(result.skipped).toContainEqual({ id: task.id, reason: "archived-task-present" });
  });

  it("does not prune a reservation represented only by the cold archive", async () => {
    /*
    FNXC:PostgresReservationRecoveryCoverage 2026-07-14-18:51:
    The cold archive is an independent recovery tier from project.archived_tasks. A committed reservation and its children must survive when only archive.archived_tasks still represents the task.
    */
    const store = h.store();
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const task = await store.createTask({ description: "Cold archive representation guard" });
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });
    await layer.db.delete(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, task.id),
    ));
    await layer.db.insert(schema.archive.archivedTasks).values({
      id: task.id,
      projectId,
      taskJson: JSON.stringify(task),
      archivedAt: new Date().toISOString(),
      title: task.title,
      description: task.description,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });

    const result = await store.reconcilePhantomCommittedReservations();

    expect(result.reconciled).not.toContain(task.id);
    expect(result.skipped).toContainEqual({ id: task.id, reason: "archived-task-present" });
  });

  it("does not prune a reservation while task.json still represents it", async () => {
    /*
    FNXC:PostgresReservationRecoveryCoverage 2026-07-14-19:05:
    Phantom cleanup requires absence across live, archive, and filesystem representations. Preserve task-local recovery material when PostgreSQL alone is missing the task row.
    */
    const store = h.store();
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const task = await store.createTask({ description: "Filesystem representation guard" });
    await layer.db.delete(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, task.id),
    ));

    const result = await store.reconcilePhantomCommittedReservations();

    expect(result.reconciled).not.toContain(task.id);
    expect(result.skipped).toContainEqual({ id: task.id, reason: "task-json-present" });
  });

  it("re-proves absence transactionally before deleting child rows", async () => {
    const store = h.store();
    const layer = h.layer();
    const projectId = layer.projectId?.trim() || "__legacy_unscoped__";
    const task = await store.createTask({ description: "Transactional representation guard" });
    await rm(join(h.rootDir(), ".fusion", "tasks", task.id), { recursive: true, force: true });
    await layer.db.delete(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectId),
      eq(schema.project.tasks.id, task.id),
    ));
    const originalTransaction = layer.transactionImmediate.bind(layer);
    let injected = false;
    const mutableLayer = layer as unknown as { transactionImmediate: typeof layer.transactionImmediate };
    mutableLayer.transactionImmediate = (async (callback: Parameters<typeof layer.transactionImmediate>[0]) => {
      if (!injected) {
        injected = true;
        await layer.db.insert(schema.project.archivedTasks).values({
          id: task.id,
          projectId,
          data: JSON.stringify(task),
          archivedAt: new Date().toISOString(),
        });
      }
      return originalTransaction(callback);
    }) as typeof layer.transactionImmediate;
    try {
      const result = await store.reconcilePhantomCommittedReservations();
      expect(result.reconciled).not.toContain(task.id);
      expect(result.skipped).toContainEqual({ id: task.id, reason: "representation-present-after-proof" });
    } finally {
      mutableLayer.transactionImmediate = originalTransaction;
    }
  });
});

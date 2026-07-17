/**
 * FNXC:PostgresOnlyDataAccess 2026-07-17-14:20:
 * Regression coverage for the SQLite→PostgreSQL store-migration residue fixes.
 * Each of these store paths reached the removed-SQLite stub (`store.db`) while
 * running in backend mode; the throw was either surfaced every run or swallowed
 * into a silent wrong result. These tests reproduce the original symptom
 * (exercised against the real embedded-PG backend) and assert it is gone.
 *
 * Symptom Verification:
 *  - #2 pruneAgentLogFilesAsync: the self-healing maintenance sweep called the
 *    sync `pruneAgentLogFiles`, which threw "SQLite Database is not available"
 *    every backend-mode run → agent-log pruning never ran. Assert the async
 *    variant resolves and prunes inactive-task files without throwing.
 *  - #3 cleanupOrphanedMaterializedSteps: the sync `store.db.prepare(DELETE ...)`
 *    threw, was swallowed by the best-effort catch, and orphaned workflow_steps
 *    rows leaked on a failed task-create. Assert the row is actually deleted.
 *  - #4 hard delete mission unlink: the sync path could only drive the sync
 *    MissionStore, so PG hard delete left orphaned mission feature→task links.
 *    Assert the feature is unlinked after a backend hard delete.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as schema from "../../postgres/schema/index.js";
import { AsyncMissionStore } from "../../async-mission-store.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("PostgreSQL store-migration residue fixes", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_pg_residue" });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("#3 cleanupOrphanedMaterializedSteps deletes workflow_steps rows in backend mode (no swallowed throw)", async () => {
    const store = h.store();
    expect(store.backendMode).toBe(true);

    const step = await store.createWorkflowStep({ name: "Orphan", description: "leaked step" });
    // Precondition: the row exists in PostgreSQL.
    const before = await h.adminDb()
      .select({ id: schema.project.workflowSteps.id })
      .from(schema.project.workflowSteps)
      .where(inArray(schema.project.workflowSteps.id, [step.id]));
    expect(before.map((r) => r.id)).toEqual([step.id]);

    // The old sync path threw "SQLite Database is not available" here and the
    // best-effort catch swallowed it — the row would have leaked.
    await expect(store.cleanupOrphanedMaterializedSteps([step.id])).resolves.toBeUndefined();

    const after = await h.adminDb()
      .select({ id: schema.project.workflowSteps.id })
      .from(schema.project.workflowSteps)
      .where(inArray(schema.project.workflowSteps.id, [step.id]));
    expect(after).toEqual([]);
  });

  it("#2 pruneAgentLogFilesAsync resolves in backend mode and prunes inactive-task log files", async () => {
    const store = h.store();
    expect(store.backendMode).toBe(true);

    // A soft-deleted task is "inactive" and eligible for JSONL pruning.
    const task = await store.createTask({ description: "to be deleted" });
    await store.deleteTask(task.id);

    // Seed an expired agent-log JSONL entry for the inactive task.
    const taskDir = join(store.tasksDir, task.id);
    await mkdir(taskDir, { recursive: true });
    const oldTs = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await writeFile(
      join(taskDir, "agent-log.jsonl"),
      `${JSON.stringify({ timestamp: oldTs, type: "info", message: "old", taskId: task.id })}\n`,
    );

    // The old sync `pruneAgentLogFiles` threw the removed-SQLite stub here.
    const result = await store.pruneAgentLogFilesAsync(30);
    expect(result).toBeDefined();
    expect(typeof result.prunedEntries).toBe("number");
    // The seeded expired entry for the inactive task is pruned.
    expect(result.prunedEntries).toBeGreaterThanOrEqual(1);
  });

  it("#4 hard delete unlinks the mission feature from the task in backend mode", async () => {
    const store = h.store();
    const missions = store.getMissionStore() as AsyncMissionStore;
    expect(missions).toBeInstanceOf(AsyncMissionStore);

    const mission = await missions.createMission({ title: "Residue mission" });
    const milestone = await missions.addMilestone(mission.id, { title: "MS" });
    const slice = await missions.addSlice(milestone.id, { title: "SL" });
    const feature = await missions.addFeature(slice.id, { title: "F" });
    const task = await store.createTask({ description: "linked delivery task" });

    const linked = await missions.linkFeatureToTask(feature.id, task.id);
    expect(linked.taskId).toBe(task.id);

    // Hard delete used to skip the async mission unlink → orphaned link.
    await store.deleteTask(task.id);

    const orphan = await missions.getFeatureByTaskId(task.id);
    expect(orphan).toBeUndefined();
    const refreshed = await missions.getFeature(feature.id);
    expect(refreshed?.taskId).toBeUndefined();
  });

  it("deleteWorkflowStep removes the row in backend mode and reports not-found for a missing id", async () => {
    const store = h.store();
    const step = await store.createWorkflowStep({ name: "Deletable", description: "step" });

    await store.deleteWorkflowStep(step.id);
    const rows = await h.adminDb()
      .select({ id: schema.project.workflowSteps.id })
      .from(schema.project.workflowSteps)
      .where(inArray(schema.project.workflowSteps.id, [step.id]));
    expect(rows).toEqual([]);

    // Contract preserved: deleting a non-existent step throws.
    await expect(store.deleteWorkflowStep("WS-does-not-exist")).rejects.toThrow(/not found/);
  });

  it("cleanupArchivedTasks hard-deletes archived project rows while retaining the cold snapshot", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "to be purged" });
    await store.archiveTask(task.id);

    const cleaned = await store.cleanupArchivedTasks();
    expect(cleaned).toContain(task.id);

    // Live project row is gone...
    const liveRows = await h.adminDb()
      .select({ id: schema.project.tasks.id })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id));
    expect(liveRows).toEqual([]);

    // ...but the cold-storage snapshot survives for restore.
    const coldRows = await h.adminDb()
      .select({ id: schema.archive.archivedTasks.id })
      .from(schema.archive.archivedTasks)
      .where(eq(schema.archive.archivedTasks.id, task.id));
    expect(coldRows.map((r) => r.id)).toContain(task.id);
  });
});

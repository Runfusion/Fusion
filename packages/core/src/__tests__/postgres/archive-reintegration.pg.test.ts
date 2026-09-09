import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { reconcileArchivedTasksIntoDonePass, reintegrateArchivedTasksIntoDoneOnOpen } from "../../task-store/archive-reintegration.js";
import {
  findArchivedTaskEntry,
  restoreTaskFromArchive,
  upsertArchivedTaskEntry,
} from "../../task-store/async/async-archive-lineage.js";
import { projectPartition } from "../../task-store/async/async-lifecycle.js";

pgDescribe("archived task startup reintegration", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_archive_reintegration",
    projectId: "project-archive-reintegration",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("restores cold snapshots into Done and drains the archive row", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "legacy archived delivery", column: "done" },
      { taskId: "FN-29501", applyDefaultWorkflowSteps: false },
    );
    const archivedAt = "2026-08-30T12:00:00.000Z";
    const entry = await store.taskToArchiveEntry(task, archivedAt);

    await upsertArchivedTaskEntry(h.layer().db, entry, h.layer().projectId);
    await h.layer().db
      .update(schema.project.tasks)
      .set({ column: "archived", deletedAt: archivedAt, updatedAt: archivedAt })
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, task.id),
      ));

    await expect(reintegrateArchivedTasksIntoDoneOnOpen(store)).resolves.toBe(1);

    const restored = await store.getTask(task.id);
    expect(restored.column).toBe("done");
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.log.at(-1)?.action).toBe("Archived task reintegrated into Done");
    await expect(findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).resolves.toBeUndefined();
    await expect(store.listTasks({ includeArchived: false })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id, column: "done" })]),
    );
  });

  it("recreates a populated cold snapshot without losing visible history", async () => {
    const store = h.store();
    const created = await store.createTaskWithReservedId(
      {
        description: "cold-only legacy delivery",
        column: "done",
        tokenUsage: {
          inputTokens: 20,
          outputTokens: 10,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 30,
          firstUsedAt: "2026-08-30T12:00:00.000Z",
          lastUsedAt: "2026-08-30T12:20:00.000Z",
          perModel: [],
        },
      },
      { taskId: "FN-29504", applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(created.id, {
      executionMode: "fast",
      sessionAdvisorEnabled: false,
      firstExecutionAt: "2026-08-30T12:05:00.000Z",
      cumulativeActiveMs: 0,
      cumulativePlanningMs: 250,
      columnDwellMs: { planning: 250, "in-progress": 0 },
      executionStartedAt: "2026-08-30T12:05:00.000Z",
      executionCompletedAt: "2026-08-30T12:25:00.000Z",
      modifiedFiles: [],
      mergeDetails: { commitSha: "abc123", filesChanged: 0, insertions: 0, deletions: 0 },
    });
    await h.layer().db.update(schema.project.tasks).set({
      columnDwellMs: { planning: 250, "in-progress": 0 },
      modifiedFiles: [],
    }).where(and(
      eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
      eq(schema.project.tasks.id, created.id),
    ));
    const task = await store.getTask(created.id);
    const archivedAt = "2026-08-30T12:30:00.000Z";
    const entry = await store.taskToArchiveEntry(task, archivedAt);
    Object.assign(entry as unknown as Record<string, unknown>, {
      worktree: "/stale/worktree",
      workspaceWorktrees: { ".": { worktreePath: "/stale/worktree" } },
      status: "merging",
      blockedBy: "FN-OTHER",
      error: "stale runtime failure",
    });
    await h.layer().db
      .delete(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, task.id),
      ));
    await upsertArchivedTaskEntry(h.layer().db, entry, h.layer().projectId);
    await expect(h.layer().db
      .select({ id: schema.project.tasks.id })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))).resolves.toEqual([]);

    await expect(findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).resolves.toMatchObject({ id: task.id });
    const result = await reconcileArchivedTasksIntoDonePass(store);
    expect(result).toMatchObject({ restoredCount: 1, outcomes: [{ taskId: task.id, outcome: "restored" }] });

    await expect(store.getTask(task.id)).resolves.toMatchObject({
      id: task.id,
      column: "done",
      description: task.description,
      executionMode: "fast",
      sessionAdvisorEnabled: false,
      cumulativeActiveMs: 0,
      cumulativePlanningMs: 250,
      columnDwellMs: { planning: 250, "in-progress": 0 },
      tokenUsage: task.tokenUsage,
      modifiedFiles: [],
      mergeDetails: { commitSha: "abc123", filesChanged: 0, insertions: 0, deletions: 0 },
      worktree: undefined,
      workspaceWorktrees: undefined,
      status: undefined,
      blockedBy: undefined,
      error: undefined,
    });
    await expect(findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).resolves.toBeUndefined();
  });

  it("fills only missing soft-deleted history while preserving richer live values", async () => {
    const store = h.store();
    const created = await store.createTaskWithReservedId(
      { description: "soft-deleted historical delivery", column: "done" },
      { taskId: "FN-29505", applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(created.id, {
      cumulativeActiveMs: 900,
      cumulativePlanningMs: 400,
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 16,
        firstUsedAt: "2026-08-30T10:00:00.000Z",
        lastUsedAt: "2026-08-30T11:00:00.000Z",
      },
    });
    const snapshotted = await store.getTask(created.id);
    const archivedAt = "2026-08-30T13:00:00.000Z";
    const entry = await store.taskToArchiveEntry(snapshotted, archivedAt);
    await upsertArchivedTaskEntry(h.layer().db, entry, h.layer().projectId);
    await h.layer().db.update(schema.project.tasks).set({
      deletedAt: archivedAt,
      column: "archived",
      cumulativeActiveMs: 1200,
      cumulativePlanningMs: null,
      tokenUsageInputTokens: null,
      tokenUsageOutputTokens: null,
      tokenUsageCachedTokens: null,
      tokenUsageCacheWriteTokens: null,
      tokenUsageTotalTokens: null,
      tokenUsageFirstUsedAt: null,
      tokenUsageLastUsedAt: null,
    }).where(and(
      eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
      eq(schema.project.tasks.id, created.id),
    ));

    await expect(h.layer().db.select({ cumulativeActiveMs: schema.project.tasks.cumulativeActiveMs })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, created.id),
      ))).resolves.toEqual([{ cumulativeActiveMs: 1200 }]);

    await expect(reconcileArchivedTasksIntoDonePass(store)).resolves.toMatchObject({ restoredCount: 1 });
    await expect(store.getTask(created.id)).resolves.toMatchObject({
      column: "done",
      cumulativeActiveMs: 1200,
      cumulativePlanningMs: 400,
      tokenUsage: entry.tokenUsage,
    });
  });

  it("fills missing history on a live Done collision before draining its cold proof", async () => {
    const store = h.store();
    const created = await store.createTaskWithReservedId(
      { description: "partially reintegrated live delivery", column: "done" },
      { taskId: "FN-29507", applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(created.id, {
      cumulativeActiveMs: 900,
      cumulativePlanningMs: 400,
      modifiedFiles: ["src/restored.ts"],
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 16,
        firstUsedAt: "2026-08-30T10:00:00.000Z",
        lastUsedAt: "2026-08-30T11:00:00.000Z",
      },
    });
    const entry = await store.taskToArchiveEntry(
      await store.getTask(created.id),
      "2026-08-30T13:00:00.000Z",
    );
    await upsertArchivedTaskEntry(h.layer().db, entry, h.layer().projectId);
    await h.layer().db.update(schema.project.tasks).set({
      cumulativeActiveMs: 1200,
      cumulativePlanningMs: null,
      modifiedFiles: null,
      tokenUsageInputTokens: null,
      tokenUsageOutputTokens: null,
      tokenUsageCachedTokens: null,
      tokenUsageCacheWriteTokens: null,
      tokenUsageTotalTokens: null,
      tokenUsageFirstUsedAt: null,
      tokenUsageLastUsedAt: null,
    }).where(and(
      eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
      eq(schema.project.tasks.id, created.id),
    ));

    await expect(reconcileArchivedTasksIntoDonePass(store)).resolves.toMatchObject({
      restoredCount: 0,
      outcomes: [{ taskId: created.id, outcome: "live-won" }],
    });
    await expect(store.getTask(created.id)).resolves.toMatchObject({
      column: "done",
      cumulativeActiveMs: 1200,
      cumulativePlanningMs: 400,
      modifiedFiles: ["src/restored.ts"],
      tokenUsage: entry.tokenUsage,
    });
    await expect(findArchivedTaskEntry(h.layer().db, created.id, h.layer().projectId)).resolves.toBeUndefined();
  });

  it("supplements exact artifact evidence in dry-run and apply modes idempotently", async () => {
    const store = h.store();
    const created = await store.createTaskWithReservedId(
      { description: "completed task with retained artifact proof", column: "done" },
      { taskId: "FN-29508", applyDefaultWorkflowSteps: false },
    );
    await h.layer().db.update(schema.project.tasks).set({ modifiedFiles: null }).where(and(
      eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
      eq(schema.project.tasks.id, created.id),
    ));
    const evidence = {
      executionCompletedAt: "2026-08-30T14:00:00.000Z",
      cumulativeActiveMs: 0,
      modifiedFiles: ["src/proven.ts"],
    };

    await expect(store.supplementTaskHistoryFromEvidence(created.id, evidence, { dryRun: true })).resolves.toEqual({
      outcome: "supplemented",
      fields: ["cumulativeActiveMs", "executionCompletedAt", "modifiedFiles"],
    });
    await expect(store.getTask(created.id)).resolves.toMatchObject({
      executionCompletedAt: undefined,
      cumulativeActiveMs: undefined,
    });

    await expect(store.supplementTaskHistoryFromEvidence(created.id, evidence)).resolves.toEqual({
      outcome: "supplemented",
      fields: ["cumulativeActiveMs", "executionCompletedAt", "modifiedFiles"],
    });
    await expect(store.supplementTaskHistoryFromEvidence(created.id, evidence)).resolves.toEqual({
      outcome: "no-op",
      fields: [],
    });
    await expect(store.getTask(created.id)).resolves.toMatchObject({
      executionCompletedAt: evidence.executionCompletedAt,
      cumulativeActiveMs: 0,
      modifiedFiles: ["src/proven.ts"],
    });
  });

  it("serializes concurrent cold restores without creating duplicate live rows", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "concurrent cold restore", column: "done" },
      { taskId: "FN-29506", applyDefaultWorkflowSteps: false },
    );
    const entry = await store.taskToArchiveEntry(task, "2026-08-30T13:30:00.000Z");
    await h.layer().db.delete(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
      eq(schema.project.tasks.id, task.id),
    ));
    await upsertArchivedTaskEntry(h.layer().db, entry, h.layer().projectId);
    const taskRecord = { ...store.archiveEntryToTask(entry), column: "done" };

    const results = await Promise.all([
      restoreTaskFromArchive(h.layer(), entry, { targetColumn: "done", taskRecord }),
      restoreTaskFromArchive(h.layer(), entry, { targetColumn: "done", taskRecord }),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["live-won", "restored"]);
    await expect(h.layer().db.select({ id: schema.project.tasks.id }).from(schema.project.tasks).where(and(
      eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
      eq(schema.project.tasks.id, task.id),
    ))).resolves.toEqual([{ id: task.id }]);
  });

  it("continues past malformed cold JSON and leaves the unreadable proof retained", async () => {
    const store = h.store();
    const malformed = await store.createTaskWithReservedId(
      { description: "malformed historical snapshot", column: "done" },
      { taskId: "FN-29509", applyDefaultWorkflowSteps: false },
    );
    const valid = await store.createTaskWithReservedId(
      { description: "valid historical snapshot after corruption", column: "done" },
      { taskId: "FN-29510", applyDefaultWorkflowSteps: false },
    );
    const malformedEntry = await store.taskToArchiveEntry(malformed, "2026-08-30T16:00:00.000Z");
    const validEntry = await store.taskToArchiveEntry(valid, "2026-08-30T15:00:00.000Z");
    await upsertArchivedTaskEntry(h.layer().db, malformedEntry, h.layer().projectId);
    await upsertArchivedTaskEntry(h.layer().db, validEntry, h.layer().projectId);
    await h.layer().db.update(schema.archive.archivedTasks).set({ taskJson: "{not-json" }).where(and(
      eq(schema.archive.archivedTasks.projectId, projectPartition(h.layer().projectId)),
      eq(schema.archive.archivedTasks.id, malformed.id),
    ));
    for (const taskId of [malformed.id, valid.id]) {
      await h.layer().db.delete(schema.project.tasks).where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, taskId),
      ));
    }

    const result = await reconcileArchivedTasksIntoDonePass(store, { limit: 10 });

    expect(result.outcomes).toEqual(expect.arrayContaining([
      { taskId: malformed.id, source: "cold-storage", outcome: "retained", reason: "malformed-snapshot" },
      { taskId: valid.id, source: "cold-storage", outcome: "restored" },
    ]));
    await expect(store.getTask(valid.id)).resolves.toMatchObject({ column: "done" });
    await expect(h.layer().db.select({ id: schema.archive.archivedTasks.id })
      .from(schema.archive.archivedTasks)
      .where(and(
        eq(schema.archive.archivedTasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.archive.archivedTasks.id, malformed.id),
      ))).resolves.toEqual([{ id: malformed.id }]);
  });

  it("repairs a live archived sentinel without resurrecting soft-deleted tasks", async () => {
    const store = h.store();
    const stranded = await store.createTaskWithReservedId(
      { description: "stranded restore", column: "done" },
      { taskId: "FN-29502", applyDefaultWorkflowSteps: false },
    );
    const deleted = await store.createTaskWithReservedId(
      { description: "intentional deletion", column: "done" },
      { taskId: "FN-29503", applyDefaultWorkflowSteps: false },
    );
    const now = "2026-08-30T13:00:00.000Z";
    await h.layer().db
      .update(schema.project.tasks)
      .set({ column: "archived", updatedAt: now })
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, stranded.id),
      ));
    await h.layer().db
      .update(schema.project.tasks)
      .set({ column: "archived", deletedAt: now, updatedAt: now })
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, deleted.id),
      ));

    await expect(reintegrateArchivedTasksIntoDoneOnOpen(store)).resolves.toBe(1);
    await expect(store.getTask(stranded.id)).resolves.toEqual(expect.objectContaining({ column: "done" }));
    await expect(store.getTask(deleted.id)).rejects.toThrow();
  });
});

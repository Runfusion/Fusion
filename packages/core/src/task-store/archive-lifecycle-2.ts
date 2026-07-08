/**
 * archive-lifecycle-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {TaskHasLineageChildrenError, TaskSelfDeleteError} from "./errors.js";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {eq} from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type {Task, Column, ArchivedTaskEntry, GithubIssueAction} from "../types.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {generateTaskLineageId} from "../task-lineage.js";
import {sanitizeFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {softDeleteTaskRow as softDeleteTaskRowAsync, readTaskRow as readTaskRowAsync} from "../task-store/async-persistence.js";
import {findLiveLineageChildren as findLiveLineageChildrenAsync, removeLineageReferences} from "../task-store/async-lifecycle.js";
import {archiveParentTaskWithLineageGate, findArchivedTaskEntry, deleteArchivedTaskEntry, restoreTaskFromArchive} from "../task-store/async-archive-lineage.js";
import {getArchivedRowCount, listArchivedTaskEntriesPage} from "../async-archive-db.js";

export async function taskToArchiveEntryImpl(store: TaskStore, task: Task, archivedAt: string): Promise<ArchivedTaskEntry> {
    const settings = await store.getSettingsFast();
    const agentLogMode = settings.archiveAgentLogMode ?? "compact";
    const [prompt, agentLogFields] = await Promise.all([
      store.readPromptForArchive(task.id),
      store.buildArchivedAgentLogFields(task.id, agentLogMode),
    ]);

    return {
      id: task.id,
      lineageId: task.lineageId || generateTaskLineageId(),
      title: task.title,
      description: task.description,
      priority: normalizeTaskPriority(task.priority),
      column: "archived",
      preArchiveColumn: task.preArchiveColumn,
      dependencies: task.dependencies,
      steps: task.steps,
      currentStep: task.currentStep,
      customFields: task.customFields,
      size: task.size,
      reviewLevel: task.reviewLevel,
      prInfo: task.prInfo,
      prInfos: task.prInfos,
      issueInfo: task.issueInfo,
      githubTracking: task.githubTracking,
      sourceIssue: task.sourceIssue,
      attachments: task.attachments,
      comments: task.comments,
      review: task.review,
      reviewState: task.reviewState,
      prompt,
      ...agentLogFields,
      log: [{ timestamp: archivedAt, action: "Task archived" }],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      columnMovedAt: task.columnMovedAt,
      firstExecutionAt: task.firstExecutionAt,
      cumulativeActiveMs: task.cumulativeActiveMs,
      executionStartedAt: task.executionStartedAt,
      executionCompletedAt: task.executionCompletedAt,
      archivedAt,
      modelPresetId: task.modelPresetId,
      modelProvider: task.modelProvider,
      modelId: task.modelId,
      validatorModelProvider: task.validatorModelProvider,
      validatorModelId: task.validatorModelId,
      planningModelProvider: task.planningModelProvider,
      planningModelId: task.planningModelId,
      breakIntoSubtasks: task.breakIntoSubtasks,
      noCommitsExpected: task.noCommitsExpected,
      baseBranch: task.baseBranch,
      branch: task.branch,
      branchContext: task.branchContext,
      autoMerge: task.autoMerge,
      baseCommitSha: task.baseCommitSha,
      mergeRetries: task.mergeRetries,
      error: task.error,
      modifiedFiles: task.modifiedFiles,
      missionId: task.missionId,
      sliceId: task.sliceId,
      assigneeUserId: task.assigneeUserId,
    };
  }

export async function deleteTaskBackendImpl(store: TaskStore, id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: { agentId: string; runId: string; sessionId?: string; taskId?: string }; },): Promise<Task> {
  /*
  FNXC:TaskDeletion 2026-07-01-00:00:
  Task-bound runtime callers may never soft-delete the task they are executing; this guard is the PostgreSQL-backend mirror of the SQLite-path guard in deleteTaskImpl so direct callers of deleteTaskBackend inherit the same invariant before any mutation or audit.
  */
  if (options?.auditContext?.taskId === id) {
    throw new TaskSelfDeleteError(id);
  }
    const layer = store.asyncLayer!;
    // Read the task row (forensic: include soft-deleted).
    const pgRow = await readTaskRowAsync(layer, id, { includeDeleted: true });
    if (!pgRow) {
      throw new Error(`Task ${id} not found`);
    }
    const task = store.rowToTask(store.pgRowToTaskRow(pgRow));

    // Idempotent: already soft-deleted is a no-op.
    if (task.deletedAt) {
      return task;
    }

    // Lineage-integrity gate (VAL-DATA-010).
    const lineageChildIds = await findLiveLineageChildrenAsync(layer.db, id);
    if (lineageChildIds.length > 0 && !options?.removeLineageReferences) {
      throw new TaskHasLineageChildrenError(id, lineageChildIds);
    }

    const deletedAt = new Date().toISOString();
    const allowResurrection = options?.allowResurrection === true;

    // Soft-delete + lineage clear + audit in one transaction (atomicity).
    await layer.transactionImmediate(async (tx) => {
      // Clear lineage references on live children so the parent can be deleted.
      if (lineageChildIds.length > 0) {
        await removeLineageReferences(tx, id, lineageChildIds, deletedAt);
      }
      // Soft-delete the task row.
      await softDeleteTaskRowAsync(layer, id, deletedAt, allowResurrection);
      // Record the audit event.
      await store.recordRunAuditEventBackend(tx, {
        domain: "database",
        mutationType: "task:deleted",
        target: id,
        taskId: id,
        agentId: options?.auditContext?.agentId ?? "system",
        runId: options?.auditContext?.runId ?? store.makeSyntheticDeleteRunId(id),
        metadata: {
          previousColumn: task.column,
          previousStatus: task.status ?? null,
          githubIssueAction: options?.githubIssueAction ?? "auto",
          removeDependencyReferences: !!options?.removeDependencyReferences,
          removeLineageReferences: !!options?.removeLineageReferences,
          allowResurrection,
          sessionId: options?.auditContext?.sessionId,
        },
      });
    });

    // Emit lifecycle event (best-effort, outside the transaction).
    store.emit("task:deleted", task, { githubIssueAction: options?.githubIssueAction ?? "auto" });
    return task;
  }

export async function archiveTaskBackendImpl(store: TaskStore, id: string, optionsOrCleanup: boolean | { cleanup?: boolean; removeLineageReferences?: boolean },): Promise<Task> {
    const layer = store.asyncLayer!;
    const cleanup = typeof optionsOrCleanup === "boolean" ? optionsOrCleanup : optionsOrCleanup.cleanup !== false;
    const removeLineageRefs = typeof optionsOrCleanup === "object" && optionsOrCleanup.removeLineageReferences === true;

    // Read the task (forensic: include deleted for idempotency check).
    const task = await store.getTask(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    if (task.column === "archived") {
      throw new Error(`Cannot archive ${id}: task is already archived`);
    }

    const fromColumn = task.column as Column;
    const archivedAt = new Date().toISOString();

    // Build the archive entry for cold storage.
    const entry = await store.taskToArchiveEntry(task, archivedAt);

    // Lineage gate + archive in one transaction.
    const result = await archiveParentTaskWithLineageGate(layer, id, entry, {
      removeLineageReferences: removeLineageRefs,
      now: archivedAt,
    });

    if (!result.archived) {
      throw new TaskHasLineageChildrenError(id, result.liveChildIds);
    }

    // File-system cleanup if requested.
    const dir = store.taskDir(id);
    if (cleanup) {
      await store.cleanupBranchForTask(task);
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
      if (store.isWatching) {
        store.taskCache.delete(id);
      }
    }

    // Update the task object to reflect the archived state for the event.
    task.column = "archived" as Column;
    task.columnMovedAt = archivedAt;
    task.updatedAt = archivedAt;
    task.deletedAt = archivedAt;

    store.emit("task:moved", { task, from: fromColumn, to: "archived" as Column, source: "engine" });

    // Best-effort near-duplicate cleanup.
    await store.clearNearDuplicateReferencesToFailSoft(id, {
      column: "archived",
      reason: "archived",
    });

    return store.archiveEntryToTask(entry, false);
  }

/**
 * FNXC:ArchivePagination 2026-07-08-00:00:
 * Dedicated archived-only read path for the Archived board column (FN-7659).
 * The merged `listTasks({includeArchived:true})` path re-sorts everything
 * (active + archived) by `createdAt ASC`, which is correct for the merged
 * consumers but wrong for the Archived column (must be newest-first) and
 * unbounded. This reads ONLY archive cold storage via a bounded LIMIT/OFFSET
 * page ordered `archivedAt DESC` — do not re-sort by createdAt and do not use
 * as a substitute for the merged path. Backend mode reads `archive.archived_tasks`
 * via async Drizzle; the sqlite path mirrors upstream's `archiveDb.listPage()`.
 */
export async function listArchivedTasksImpl(store: TaskStore, options?: {
  limit?: number;
  offset?: number;
  slim?: boolean;
}): Promise<{ tasks: Task[]; total: number; hasMore: boolean }> {
    const rawLimit = options?.limit ?? 100;
    const limit = Math.min(500, Math.max(1, Math.trunc(rawLimit) || 100));
    const rawOffset = options?.offset ?? 0;
    const offset = Math.max(0, Math.trunc(rawOffset) || 0);
    const slim = options?.slim ?? true;

    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const total = await getArchivedRowCount(layer.db);
      const entries = await listArchivedTaskEntriesPage(layer.db, limit, offset);
      const tasks = entries.map((entry) => store.archiveEntryToTask(entry, slim));
      return { tasks, total, hasMore: offset + tasks.length < total };
    }

    const total = store.archiveDb.getArchivedRowCount();
    const entries = store.archiveDb.listPage(limit, offset);
    const tasks = entries.map((entry) => store.archiveEntryToTask(entry, slim));
    return { tasks, total, hasMore: offset + tasks.length < total };
}

export async function unarchiveTaskImpl(store: TaskStore, id: string): Promise<Task> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-25:
     * Backend-mode unarchiveTask: uses async archive helpers to read from PG
     * archive table, restore the task to active storage, and delete the archive
     * entry — all without touching store.db or store.archiveDb (SQLite).
     */
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      // Check if task is in active storage first.
      let task: Task | null;
      try {
        task = await store.getTask(id);
      } catch {
        task = null;
      }

      if (!task) {
        // Restore from archive.
        const entry = await findArchivedTaskEntry(layer.db, id);
        if (!entry) {
          throw new Error(`Cannot unarchive ${id}: task is missing from active storage and not found in archive`);
        }
        await restoreTaskFromArchive(layer, entry);
        task = await store.getTask(id);
        if (!task) {
          throw new Error(`Task ${id} not found after restore`);
        }
      }

      if (task.column !== "archived") {
        throw new Error(`Cannot unarchive ${id}: task is in '${task.column}', must be in 'archived'`);
      }

      const preArchiveColumn = task.preArchiveColumn ?? "todo";
      const toColumn = store.resolveUnarchiveTargetColumn(preArchiveColumn);

      /*
       * FNXC:SqliteFinalRemoval 2026-06-25:
       * Directly update the column instead of calling moveTask. The VALID_TRANSITIONS
       * graph only allows archived→done, but unarchive needs to restore to the
       * preArchiveColumn (todo/in-progress/etc). The SQLite path bypasses transition
       * validation by directly setting task.column; the backend path must do the same
       * via a direct UPDATE. Using moveTask would throw "Invalid transition" for any
       * target other than "done".
       */
      const now = new Date().toISOString();
      await layer.db
        .update(schema.project.tasks)
        .set({
          column: toColumn,
          columnMovedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.project.tasks.id, id));

      const updatedTask = await store.getTask(id);

      // Log the unarchive action.
      await store.logEntry(id, "Task unarchived");

      // Remove from archive table.
      await deleteArchivedTaskEntry(layer.db, id);

      return updatedTask;
    }

    const dir = store.taskDir(id);

    // If the active row is gone, restore from cold archive storage before
    // taking the task lock. A stale directory may still exist after manual
    // filesystem edits, so database presence is the source of truth.
    if (!store.readTaskFromDb(id)) {
      const entry = await store.findInArchive(id);
      if (!entry) {
        throw new Error(
          `Cannot unarchive ${id}: task is missing from active storage and not found in archive`,
        );
      }
      await store.restoreFromArchive(entry);
    }

    return store.withTaskLock(id, async () => {
      // Re-read task.json (either existing or freshly restored)
      const task = await store.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (task.column !== "archived") {
        throw new Error(
          `Cannot unarchive ${id}: task is in '${task.column}', must be in 'archived'`,
        );
      }

      // NOTE: No getTaskMergeBlocker check here — intentionally.
      // The merge blocker validates in-review → done transitions (ensuring code
      // has been properly reviewed before merging). An unarchived task was already
      // archived in its previous lifecycle; this is just a restoration. The transient
      // field clearing below ensures no stale blocker state leaks through.
      const preArchiveColumn = task.preArchiveColumn ?? await store.readPreArchiveColumnFromTaskFile(dir);
      const toColumn = store.resolveUnarchiveTargetColumn(preArchiveColumn);
      task.column = toColumn;
      task.preArchiveColumn = undefined;
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;

      // Clear transient fields regardless of the restored column. Archived tasks
      // may have been archived with stale execution state that should not reappear
      // after unarchiving, especially when active columns are downgraded to todo.
      store.clearDoneTransientFields(task);

      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task unarchived",
      });

      await store.atomicWriteTaskJson(dir, task);
      store.archiveDb.delete(id);

      // Update cache if watcher is active
      if (store.isWatching) store.taskCache.set(id, { ...task });

      store.emit("task:moved", { task, from: "archived" as Column, to: toColumn, source: "engine" });
      return task;
    });
  }

export async function restoreFromArchiveImpl(store: TaskStore, entry: import("../types.js").ArchivedTaskEntry): Promise<Task> {
    const dir = store.taskDir(entry.id);

    // Create task directory
    await mkdir(dir, { recursive: true });

    // Build restored task (clear transient fields)
    const restoredTask: Task = {
      id: entry.id,
      lineageId: entry.lineageId || generateTaskLineageId(),
      title: entry.title,
      description: entry.description,
      priority: normalizeTaskPriority(entry.priority),
      column: "archived", // Will be changed by unarchiveTask
      preArchiveColumn: entry.preArchiveColumn,
      dependencies: entry.dependencies,
      steps: entry.steps,
      currentStep: entry.currentStep,
      customFields: entry.customFields ?? undefined,
      size: entry.size,
      reviewLevel: entry.reviewLevel,
      prInfo: entry.prInfo,
      review: entry.review,
      issueInfo: entry.issueInfo,
      githubTracking: entry.githubTracking,
      sourceIssue: entry.sourceIssue,
      attachments: entry.attachments,
      log: [...entry.log, { timestamp: new Date().toISOString(), action: "Task restored from archive" }],
      comments: entry.comments,
      createdAt: entry.createdAt,
      updatedAt: new Date().toISOString(),
      columnMovedAt: entry.columnMovedAt,
      modelPresetId: entry.modelPresetId,
      modelProvider: entry.modelProvider,
      modelId: entry.modelId,
      validatorModelProvider: entry.validatorModelProvider,
      validatorModelId: entry.validatorModelId,
      planningModelProvider: entry.planningModelProvider,
      planningModelId: entry.planningModelId,
      breakIntoSubtasks: entry.breakIntoSubtasks,
      noCommitsExpected: entry.noCommitsExpected,
      modifiedFiles: entry.modifiedFiles,
      // Intentionally NOT restoring: worktree, status, blockedBy, paused, executionStartBranch, baseCommitSha, error
    };

    // Write task.json
    await store.atomicWriteTaskJson(dir, restoredTask);

    // Generate PROMPT.md with preserved steps
    const prompt = entry.prompt ?? store.generatePromptFromArchiveEntry(entry);
    const sanitizedPrompt = sanitizeFileScopeInPromptContent(prompt);
    if (sanitizedPrompt.dropped.length > 0) {
      storeLog.log(`[file-scope-sanitize] restore ${entry.id}: dropped=[${sanitizedPrompt.dropped.join(",")}]`);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), sanitizedPrompt.sanitized);

    // Create empty attachments directory if attachments existed
    if (entry.attachments && entry.attachments.length > 0) {
      await mkdir(join(dir, "attachments"), { recursive: true });
    }

    return restoredTask;
  }


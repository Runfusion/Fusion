/**
 * archive-lifecycle-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {getFeatureByTaskId as getMissionFeatureByTaskId, unlinkFeatureFromTaskId as unlinkMissionFeatureFromTaskId} from "../async-mission-store-queries.js";
import {TaskHasLineageChildrenError, TaskSelfDeleteError} from "./errors.js";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {and, eq} from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type {Task, Column, ArchivedTaskEntry, GithubIssueAction} from "../types.js";
import "../builtin-traits.js";
import {normalizeTaskPriority} from "../task-priority.js";
import {generateTaskLineageId} from "../task-lineage.js";
import {sanitizeFileScopeInPromptContent} from "../task-store/file-scope.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {softDeleteTaskRowInTransaction, readTaskRow as readTaskRowAsync} from "../task-store/async-persistence.js";
import {findLiveLineageChildren as findLiveLineageChildrenAsync, projectPartition, removeLineageReferences} from "../task-store/async-lifecycle.js";
import {archiveParentTaskWithLineageGate, findArchivedTaskEntry, deleteArchivedTaskEntry, restoreTaskFromArchive} from "../task-store/async-archive-lineage.js";
import {getArchivedRowCount, listArchivedTaskEntriesPage} from "../async-archive-db.js";
import {disposeArchivedWorkspaceWorktrees, disposeArchivedWorktree, prepareArchivedWorkspaceWorktrees, releasePreparedWorkspaceArchiveDisposal} from "./archive-lifecycle.js";

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
      /*
      FNXC:GitLabTracking 2026-07-16-13:00:
      Archiving must retain GitLab provenance just as live TaskStore persistence does;
      restored imports need their original GitLab tracking item for reconciliation.
      */
      gitlabTracking: task.gitlabTracking,
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
      cumulativePlanningMs: task.cumulativePlanningMs,
      planningStartedAt: task.planningStartedAt,
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
      mergerModelProvider: task.mergerModelProvider,
      mergerModelId: task.mergerModelId,
      mergerThinkingLevel: task.mergerThinkingLevel,
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
      declaredSymbols: task.declaredSymbols,
      missionId: task.missionId,
      sliceId: task.sliceId,
      assigneeUserId: task.assigneeUserId,
      mergeDetails: task.mergeDetails,
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
    const lineageChildIds = await findLiveLineageChildrenAsync(layer.db, id, layer.projectId);
    if (lineageChildIds.length > 0 && !options?.removeLineageReferences) {
      throw new TaskHasLineageChildrenError(id, lineageChildIds);
    }

    const deletedAt = new Date().toISOString();
    const allowResurrection = options?.allowResurrection === true;

    // Soft-delete + lineage clear + mission unlink + audit in one transaction (atomicity).
    await layer.transactionImmediate(async (tx) => {
      // Clear lineage references on live children so the parent can be deleted.
      if (lineageChildIds.length > 0) {
        await removeLineageReferences(tx, id, lineageChildIds, deletedAt, layer.projectId);
      }
      /*
      FNXC:MissionStore 2026-07-17-17:40:
      Clear any mission feature→task link IN THIS TRANSACTION so it commits (or rolls
      back) atomically with the soft-delete. The prior post-commit / pre-commit variants
      could leave the two out of sync on a partial failure: a committed delete with a
      dangling feature pointer, or a committed unlink whose delete then failed and could
      not be recovered (getFeatureByTaskId no longer finds it). Running the tx-scoped
      taskId=NULL clear alongside the delete removes that window. The feature's status
      rollup is non-critical for a deleted task and self-heals on the next mission read.
      */
      const linkedFeature = await getMissionFeatureByTaskId(tx, id);
      if (linkedFeature) {
        await unlinkMissionFeatureFromTaskId(tx, linkedFeature.id);
      }
      // Soft-delete the task row.
      await softDeleteTaskRowInTransaction(tx, id, deletedAt, allowResurrection, layer.projectId);
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

/** PostgreSQL mirror of deleteTaskIfImpl: predicate and deletion share one task lock. */
export async function deleteTaskIfBackendImpl(
  store: TaskStore,
  id: string,
  predicate: (live: Task) => boolean | Promise<boolean>,
  options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: { agentId: string; runId: string; sessionId?: string; taskId?: string } },
): Promise<{ task: Task; deleted: boolean }> {
  if (options?.auditContext?.taskId === id) throw new TaskSelfDeleteError(id);
  return store.withTaskLock(id, async () => {
    const layer = store.asyncLayer!;
    const row = await readTaskRowAsync(layer, id, { includeDeleted: true });
    if (!row) throw new Error(`Task ${id} not found`);
    const live = store.rowToTask(store.pgRowToTaskRow(row));
    if (live.deletedAt) return { task: live, deleted: false };
    // FNXC:TaskDeletion 2026-07-29-19:15:
    // FN-8361 conditional deletion preserves delete's lineage gate even when
    // the caller predicate declines the mutation; guards precede the predicate.
    const lineageChildIds = await findLiveLineageChildrenAsync(layer.db, id, layer.projectId);
    if (lineageChildIds.length > 0 && !options?.removeLineageReferences) {
      throw new TaskHasLineageChildrenError(id, lineageChildIds);
    }
    if (!await predicate(live)) return { task: live, deleted: false };
    await deleteTaskBackendImpl(store, id, options);
    /*
    FNXC:TaskDeletion 2026-07-29-18:45:
    FN-8361 exposes `{ task, deleted }` as the authoritative conditional-delete
    result. Return the persisted archived row, not deleteTaskBackendImpl's
    pre-delete audit snapshot, so callers can safely inspect an applied result.
    */
    const deletedRow = await readTaskRowAsync(layer, id, { includeDeleted: true });
    if (!deletedRow) throw new Error(`Task ${id} disappeared after soft-delete`);
    return { task: store.rowToTask(store.pgRowToTaskRow(deletedRow)), deleted: true };
  });
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

    /*
    FNXC:WorkflowLifecycle 2026-07-16-15:30:
    Backend archive persists cold storage before its cleanup phase. Hold the
    per-repository reservations across that transaction so another process sees
    the path as unavailable until the awaited workspace disposer has removed it.
    */
    const preparedWorkspace = cleanup ? await prepareArchivedWorkspaceWorktrees(store, task) : undefined;
    let result;
    try {
      // Lineage gate + archive in one transaction.
      result = await archiveParentTaskWithLineageGate(layer, id, entry, {
        removeLineageReferences: removeLineageRefs,
        now: archivedAt,
      });
    } catch (error) {
      if (preparedWorkspace) await releasePreparedWorkspaceArchiveDisposal(preparedWorkspace);
      throw error;
    }

    if (!result.archived) {
      if (preparedWorkspace) await releasePreparedWorkspaceArchiveDisposal(preparedWorkspace);
      throw new TaskHasLineageChildrenError(id, result.liveChildIds);
    }

    // File-system cleanup if requested.
    const dir = store.taskDir(id);
    if (cleanup) {
      /*
      FNXC:WorkflowLifecycle 2026-07-16-10:00:
      PostgreSQL must accept the lineage-child gate before destructive cleanup.
      A rejected archive leaves its live task and pinned worktree untouched;
      successful archives still await disposal before publishing the move event.
      */
      const workspace = await disposeArchivedWorkspaceWorktrees(store, task, preparedWorkspace);
      if (!workspace.singularDeduplicated) await disposeArchivedWorktree(store, task);
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
      // FNXC:MultiProjectIsolation 2026-07-12 (PR #2007 review): the archived
      // board and its count are scoped to the bound project — the shared
      // cold-storage table would otherwise surface every project's archived
      // tasks in every project's dashboard.
      const total = await getArchivedRowCount(layer.db, layer.projectId);
      const entries = await listArchivedTaskEntriesPage(layer.db, limit, offset, layer.projectId);
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
      /*
      FNXC:ArchiveRestore 2026-07-14-18:48:
      Public getTask deliberately falls back to cold storage when the live row is tombstoned. Unarchive must inspect the live table directly so that fallback cannot masquerade as an already-restored row and leave deleted_at set after deleting the only cold snapshot.
      */
      const liveRow = await readTaskRowAsync(layer, id, { includeDeleted: true });
      const entry = await findArchivedTaskEntry(layer.db, id, layer.projectId);
      let task: Task;
      if (entry) {
        /*
        FNXC:ArchiveRestore 2026-07-14-21:48:
        A cold snapshot may outlive a missing project.tasks row after cleanup or partial legacy archival. Rebuild that row through the canonical snapshot restoration path before restoreTaskFromArchive consumes the snapshot; an existing live or tombstoned row keeps the established in-place restore path.
        */
        if (!liveRow) {
          await store.restoreFromArchive(entry);
        }
        await restoreTaskFromArchive(layer, entry);
        task = await store.getTask(id);
      } else if (liveRow && liveRow.deletedAt == null) {
        task = await store.getTask(id);
      } else {
        throw new Error(`Cannot unarchive ${id}: task is missing from active storage and not found in archive`);
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
          deletedAt: null,
          columnMovedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(schema.project.tasks.projectId, projectPartition(layer.projectId)),
          eq(schema.project.tasks.id, id),
        ));

      const updatedTask = await store.getTask(id);

      // Log the unarchive action.
      await store.logEntry(id, "Task unarchived");

      // Remove from archive table.
      await deleteArchivedTaskEntry(layer.db, id, layer.projectId);

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
      gitlabTracking: entry.gitlabTracking,
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
      mergerModelProvider: entry.mergerModelProvider,
      mergerModelId: entry.mergerModelId,
      mergerThinkingLevel: entry.mergerThinkingLevel,
      breakIntoSubtasks: entry.breakIntoSubtasks,
      noCommitsExpected: entry.noCommitsExpected,
      modifiedFiles: entry.modifiedFiles,
      declaredSymbols: entry.declaredSymbols,
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

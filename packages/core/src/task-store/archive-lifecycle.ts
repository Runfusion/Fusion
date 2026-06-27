/**
 * archive-lifecycle operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import {MissionStore} from "../mission-store.js";
import {TaskHasDependentsError, TaskHasLineageChildrenError} from "./errors.js";
import type {Task, Column, GithubIssueAction} from "../types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";

export async function deleteTaskImpl(store: TaskStore, id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: { agentId: string; runId: string; sessionId?: string }; },): Promise<Task> {
    // FNXC:RuntimeLifecycleAsync 2026-06-24-12:00:
    // Backend-mode deleteTask: delegate the core async operations (task read,
    // lineage gate, lineage clear, soft-delete, audit) to the async helpers.
    // This preserves the lineage-integrity gate (VAL-DATA-010/012) and
    // soft-delete semantics against PostgreSQL. The full deleteTask
    // orchestration (dependents rewrite, branch cleanup, events) is handled
    // by the async lifecycle helpers; the SQLite path below is unchanged.
    if (store.backendMode) {
      return store.deleteTaskBackend(id, options);
    }
    const deletedTask = await store.withTaskLock(id, async () => {
      // Flush buffered agent logs inside the lock so no new appends for this
      // task can sneak in between flush and soft-delete mutation.
      store.flushAgentLogBuffer();
      const task = store.readTaskFromDb(id, { includeDeleted: true });
      if (!task) {
        throw new Error(`Task ${id} not found`);
      }

      if (task.deletedAt) {
        return task;
      }

      // Refuse to delete a task that is still referenced as a dependency
      // by another live task unless the caller explicitly opts into
      // removing those incoming references as part of this delete.
      const dependentIds = store.findLiveDependents(id);
      if (dependentIds.length > 0 && !options?.removeDependencyReferences) {
        throw new TaskHasDependentsError(id, dependentIds);
      }

      // FN-5127: lineage gate must execute after idempotent short-circuit.
      const lineageChildIds = await store.findLiveLineageChildren(id);
      if (lineageChildIds.length > 0 && !options?.removeLineageReferences) {
        throw new TaskHasLineageChildrenError(id, lineageChildIds);
      }

      // Clean up the task's branch before deleting from DB
      const cleanedBranches = await store.cleanupBranchForTask(task);
      if (cleanedBranches.length > 0) {
        if (!task.log) task.log = [];
        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Cleaned up branch: ${cleanedBranches.join(", ")}`,
        });
      }

      let rewrittenDependents: Task[] = [];
      let rewrittenBlockedByResidueDependents: Task[] = [];
      let rewrittenLineageChildren: Task[] = [];
      store.db.transaction(() => {
        rewrittenDependents = store.rewriteDependentsForRemoval(id, dependentIds);
        rewrittenBlockedByResidueDependents = store.rewriteBlockedByResidueDependentsForRemoval(id, new Set(dependentIds));
        rewrittenLineageChildren = store.rewriteLineageChildrenForRemoval(id, lineageChildIds);
        const deletedAt = new Date().toISOString();
        const allowResurrection = options?.allowResurrection === true ? 1 : 0;
        store.db.prepare("UPDATE tasks SET \"column\" = 'archived', deletedAt = ?, allowResurrection = ?, updatedAt = ? WHERE id = ?").run(deletedAt, allowResurrection, deletedAt, id);
        void store.recordRunAuditEvent({
          domain: "database",
          mutationType: "task:deleted",
          target: task.id,
          taskId: task.id,
          agentId: options?.auditContext?.agentId ?? "system",
          runId: options?.auditContext?.runId ?? store.makeSyntheticDeleteRunId(task.id),
          metadata: {
            previousColumn: task.column,
            previousStatus: task.status ?? null,
            githubIssueAction: options?.githubIssueAction ?? "auto",
            removeDependencyReferences: !!options?.removeDependencyReferences,
            removeLineageReferences: !!options?.removeLineageReferences,
            allowResurrection: options?.allowResurrection === true,
            sessionId: options?.auditContext?.sessionId,
          },
        });
        store.clearLinkedAgentTaskIds(id, deletedAt);
        // FN-5143: agent log reads are gated on deletedAt (see getAgentLogs /
        // getAgentLogCount / getAgentLogsByTimeRange), so downstream readers
        // observe zero logs immediately after deletedAt is set. The JSONL file
        // remains on disk for forensic analysis; only the read API hides it.
        store.db.bumpLastModified();
      });

      // FN-5143 defense-in-depth: drop any in-memory buffer entries for this
      // task. flushAgentLogBuffer() above already ran inside the lock, but a
      // concurrent appendAgentLog from another async path could re-buffer
      // before this lock releases; the next flush would still drop them via
      // ACTIVE_TASKS_WHERE, but filtering here avoids the warn log and keeps
      // memory bounded.
      if (store.agentLogBuffer.length > 0) {
        store.agentLogBuffer = store.agentLogBuffer.filter((entry) => entry.taskId !== id);
      }

      // Remove from cache if watcher is active
      if (store.isWatching) store.taskCache.delete(id);

      for (const dependentTask of rewrittenDependents) {
        store.emit("task:updated", dependentTask);
      }
      for (const dependentTask of rewrittenBlockedByResidueDependents) {
        store.emit("task:updated", dependentTask);
      }
      for (const lineageChild of rewrittenLineageChildren) {
        store.emit("task:updated", lineageChild);
      }

      // FNXC:MissionStore 2026-06-27-16:00:
      // Best-effort mission feature/task-link cleanup on hard delete. store.missionStore
      // is now MissionStore | AsyncMissionStore; this sync transaction callback can only
      // drive the sync MissionStore. In PG backend mode (AsyncMissionStore) the cleanup is
      // skipped (graceful degrade — the async unlink would need an await this txn cannot provide).
      const missionStore = store.missionStore;
      if (missionStore instanceof MissionStore) {
        const linkedFeature = missionStore.getFeatureByTaskId(id);
        if (linkedFeature) {
          missionStore.unlinkFeatureFromTask(linkedFeature.id);
        }
      }

      store.emit("task:deleted", task, { githubIssueAction: options?.githubIssueAction ?? "auto" });
      return task;
    });

    await store.clearNearDuplicateReferencesToFailSoft(id, {
      column: "archived",
      deletedAt: deletedTask.deletedAt ?? new Date().toISOString(),
      reason: "deleted",
    });
    return deletedTask;
  }

export async function archiveTaskImpl(store: TaskStore, id: string, optionsOrCleanup: boolean | { cleanup?: boolean; removeLineageReferences?: boolean } = true,): Promise<Task> {
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:50:
    // Backend-mode archiveTask: delegates to archiveTaskBackend which uses the
    // async archive-lineage helper (archiveParentTaskWithLineageGate) to perform
    // the lineage gate + lineage clear + archive snapshot + soft-delete in one
    // transaction (VAL-CROSS-014/015). The SQLite path below is unchanged.
    if (store.backendMode) {
      return store.archiveTaskBackend(id, optionsOrCleanup);
    }
    const archivedTask = await store.withTaskLock(id, async () => {
      const dir = store.taskDir(id);
      const task = await store.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (task.column === "archived") {
        throw new Error(
          `Cannot archive ${id}: task is already archived`,
        );
      }

      const fromColumn = task.column as Column;
      task.preArchiveColumn = fromColumn;

      const cleanup = typeof optionsOrCleanup === "boolean" ? optionsOrCleanup : optionsOrCleanup.cleanup !== false;
      const removeLineageReferences = typeof optionsOrCleanup === "object" && optionsOrCleanup.removeLineageReferences === true;
      const lineageChildIds = await store.findLiveLineageChildren(id);
      if (lineageChildIds.length > 0 && !removeLineageReferences) {
        throw new TaskHasLineageChildrenError(id, lineageChildIds);
      }

      task.column = "archived";
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;
      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task archived",
      });

      let rewrittenLineageChildren: Task[] = [];

      if (!cleanup) {
        store.db.transaction(() => {
          rewrittenLineageChildren = store.rewriteLineageChildrenForRemoval(id, lineageChildIds);
          store.clearLinkedAgentTaskIds(id, task.updatedAt);
          if (rewrittenLineageChildren.length > 0) {
            store.db.bumpLastModified();
          }
        });

        await store.atomicWriteTaskJson(dir, task);
        await store.writeTaskJsonFile(dir, task);
        if (store.isWatching) store.taskCache.set(id, { ...task });
        for (const lineageChild of rewrittenLineageChildren) {
          store.emit("task:updated", lineageChild);
        }
        store.emit("task:moved", { task, from: fromColumn, to: "archived" as Column, source: "engine" });
        return task;
      }

      const cleanedBranches = await store.cleanupBranchForTask(task);
      if (cleanedBranches.length > 0) {
        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Cleaned up branch: ${cleanedBranches.join(", ")}`,
        });
      }

      const entry = await store.taskToArchiveEntry(task, task.columnMovedAt);
      store.archiveDb.upsert(entry);

      store.db.transaction(() => {
        rewrittenLineageChildren = store.rewriteLineageChildrenForRemoval(id, lineageChildIds);
        store.clearLinkedAgentTaskIds(id, task.updatedAt);
        store.purgeTaskWorkflowSelectionRows(id);
        store.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        store.db.bumpLastModified();
      });

      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });

      if (store.isWatching) {
        store.taskCache.delete(id);
      }

      for (const lineageChild of rewrittenLineageChildren) {
        store.emit("task:updated", lineageChild);
      }
      store.emit("task:moved", { task, from: fromColumn, to: "archived" as Column, source: "engine" });
      return store.archiveEntryToTask(entry, false);
    });

    await store.clearNearDuplicateReferencesToFailSoft(id, {
      column: "archived",
      reason: "archived",
    });
    return archivedTask;
  }


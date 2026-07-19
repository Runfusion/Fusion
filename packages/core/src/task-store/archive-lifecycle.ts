/**
 * archive-lifecycle operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {MissionStore} from "../mission-store.js";
import {TaskHasDependentsError, TaskHasLineageChildrenError, TaskSelfDeleteError} from "./errors.js";
import {isWorkspaceTask, type Task, type Column, type GithubIssueAction} from "../types.js";
import "../builtin-traits.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {toJson} from "../db-helpers.js";
import {getErrorMessage} from "../error-message.js";
import {ArchiveWorkspaceDisposalError, ArchiveWorkspaceDisposalIncompleteError, ArchiveWorkspaceWorktreeDisposerMissingError, getArchiveWorkspaceWorktreeDisposer, getArchiveWorktreeDisposer, type ArchiveWorkspaceDisposalResult, type WorkspaceDisposalPlanEntry} from "../archive-worktree-disposer.js";
import {acquireWorktreePathReservation, canonicalizeWorktreePath} from "../worktree-path-reservation.js";
import {basename, join, resolve} from "node:path";
import {homedir} from "node:os";

function resolveArchiveWorktreesDir(store: TaskStore, configured?: string): string {
  const value = configured?.replace(/^~(?=$|[\\/])/, homedir()).replaceAll("{repo}", basename(store.rootDir));
  return value ? resolve(store.rootDir, value) : join(store.rootDir, ".worktrees");
}

export async function buildWorkspaceDisposalPlan(store: TaskStore, task: Task): Promise<{plan: WorkspaceDisposalPlanEntry[]; singularDeduplicated: boolean}> {
  const entries = Object.entries(task.workspaceWorktrees ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const byCanonical = new Map<string, WorkspaceDisposalPlanEntry>();
  for (const [repoRel, entry] of entries) {
    const canonical = await canonicalizeWorktreePath(entry.worktreePath);
    const repoRootDir = join(store.rootDir, repoRel);
    const existing = byCanonical.get(canonical);
    if (existing) existing.aliasRepoRels.push(repoRel);
    else byCanonical.set(canonical, {repoRel, worktreePath: entry.worktreePath, branch: entry.branch, repoRootDir, aliasRepoRels: []});
  }
  let singularDeduplicated = false;
  if (task.worktree) {
    const canonical = await canonicalizeWorktreePath(task.worktree);
    const existing = byCanonical.get(canonical);
    if (existing) { existing.aliasRepoRels.push("__singular_worktree__"); singularDeduplicated = true; }
  }
  return {plan: [...byCanonical.values()], singularDeduplicated};
}

function normalizeWorkspaceDisposalResult(plan: WorkspaceDisposalPlanEntry[], result: ArchiveWorkspaceDisposalResult): {removed: Set<string>; failures: Map<string, unknown>} {
  const owners = new Set(plan.map((entry) => entry.repoRel));
  const counts = new Map<string, number>();
  for (const repoRel of result.removed) counts.set(repoRel, (counts.get(repoRel) ?? 0) + 1);
  const reportedFailures = new Map<string, unknown>();
  for (const failure of result.failed) if (owners.has(failure.repoRel)) reportedFailures.set(failure.repoRel, failure.error);
  const removed = new Set<string>();
  const failures = new Map<string, unknown>();
  for (const repoRel of owners) {
    if (counts.get(repoRel) === 1 && !reportedFailures.has(repoRel)) removed.add(repoRel);
    else failures.set(repoRel, reportedFailures.get(repoRel) ?? new ArchiveWorkspaceDisposalIncompleteError(repoRel));
  }
  return {removed, failures};
}

/*
FNXC:WorkflowLifecycle 2026-07-16-14:00:
FN-8105 reserved only the singular path. Workspace tasks retain one worktree per
sub-repo, so archive holds a canonical per-repo reservation through an awaited,
store-scoped disposal and quarantines every path not explicitly reported removed.
*/
export type PreparedWorkspaceArchiveDisposal = {
  plan: WorkspaceDisposalPlanEntry[];
  reservations: Record<string, Awaited<ReturnType<typeof acquireWorktreePathReservation>>>;
  singularDeduplicated: boolean;
};

/**
 * FNXC:WorkflowLifecycle 2026-07-16-15:30:
 * The PostgreSQL archive commits its cold-storage row before filesystem cleanup.
 * Acquire every workspace reservation before that mutation, then carry the held
 * handles into disposal so a separate process cannot recreate a deterministic
 * sub-repository worktree in the commit-to-removal window.
 */
export async function prepareArchivedWorkspaceWorktrees(store: TaskStore, task: Task): Promise<PreparedWorkspaceArchiveDisposal> {
  if (!isWorkspaceTask(task)) return {plan: [], reservations: {}, singularDeduplicated: false};
  const {plan, singularDeduplicated} = await buildWorkspaceDisposalPlan(store, task);
  const reservations: PreparedWorkspaceArchiveDisposal["reservations"] = {};
  if (plan.length === 0) return {plan, reservations, singularDeduplicated};
  try {
    const settings = await store.getSettings();
    for (const entry of plan) {
      const canonical = await canonicalizeWorktreePath(entry.worktreePath);
      reservations[entry.repoRel] = await acquireWorktreePathReservation({
        canonicalPath: canonical,
        rootDir: entry.repoRootDir,
        worktreesDir: resolveArchiveWorktreesDir({rootDir: entry.repoRootDir} as TaskStore, settings.worktreesDir),
      });
    }
    return {plan, reservations, singularDeduplicated};
  } catch (error) {
    await releasePreparedWorkspaceArchiveDisposal({plan, reservations, singularDeduplicated});
    throw error;
  }
}

export async function releasePreparedWorkspaceArchiveDisposal(prepared: PreparedWorkspaceArchiveDisposal): Promise<void> {
  for (const reservation of Object.values(prepared.reservations)) {
    if (reservation.state === "held") await reservation.release();
  }
}

export async function disposeArchivedWorkspaceWorktrees(store: TaskStore, task: Task, prepared = undefined as PreparedWorkspaceArchiveDisposal | undefined): Promise<{singularDeduplicated: boolean}> {
  const disposal = prepared ?? await prepareArchivedWorkspaceWorktrees(store, task);
  const {plan, reservations, singularDeduplicated} = disposal;
  if (plan.length === 0) return {singularDeduplicated};
  try {
    const disposer = getArchiveWorkspaceWorktreeDisposer(store);
    let result: ArchiveWorkspaceDisposalResult;
    if (!disposer) {
      storeLog.warn("archive-workspace-worktree-disposer-missing", {taskId: task.id, repos: plan.map((entry) => entry.repoRel)});
      result = {removed: [], failed: plan.map((entry) => ({repoRel: entry.repoRel, error: new ArchiveWorkspaceWorktreeDisposerMissingError(entry.repoRel)}))};
    } else {
      try { result = await disposer(task, plan, reservations); }
      catch (error) {
        result = error instanceof ArchiveWorkspaceDisposalError
          ? {removed: error.removed, failed: error.failed}
          : {removed: [], failed: plan.map((entry) => ({repoRel: entry.repoRel, error}))};
      }
    }
    const normalized = normalizeWorkspaceDisposalResult(plan, result);
    for (const [repoRel, error] of normalized.failures) await reservations[repoRel].quarantine(getErrorMessage(error));
  } finally {
    await releasePreparedWorkspaceArchiveDisposal(disposal);
  }
  return {singularDeduplicated};
}

export async function disposeArchivedWorktree(store: TaskStore, task: Task): Promise<void> {
  if (!task.worktree) return;
  const settings = await store.getSettings();
  const canonical = await canonicalizeWorktreePath(task.worktree);
  if (canonical === await canonicalizeWorktreePath(store.rootDir)) return;
  const reservation = await acquireWorktreePathReservation({canonicalPath: canonical, worktreesDir: resolveArchiveWorktreesDir(store, settings.worktreesDir), rootDir: store.rootDir});
  try {
    const disposer = getArchiveWorktreeDisposer(store);
    if (!disposer) {
      /* FNXC:WorkflowLifecycle 2026-07-16-10:00: A non-root archived worktree without a store-scoped engine disposer must be loud rather than silently leaked by an executor-less archive surface. */
      storeLog.warn("archive-worktree-disposer-missing", {taskId: task.id, worktreePath: canonical});
      return;
    }
    try { await disposer(task, reservation); }
    catch (error) {
      await reservation.quarantine(getErrorMessage(error));
      storeLog.warn("Archive worktree disposal failed; reservation quarantined", {taskId: task.id, worktreePath: canonical, error: getErrorMessage(error)});
    }
  } finally { if (reservation.state === "held") await reservation.release(); }
}

function scheduleDeleteBranchCleanup(store: TaskStore, task: Task): void {
    /*
    FNXC:TaskDeletion 2026-07-15-09:45:
    Soft-delete latency must be bounded by the database mutation, audit, and event emission; branch cleanup can spawn serialized git subprocesses and must not hold withTaskLock or the returned deleteTask Promise. Schedule the cleanup after the task is already soft-deleted, but keep the existing cleanup guarantees by still clearing stale execution-start branch references and persisting the cleaned-branch log entry on the deleted row.
    */
    void (async () => {
      try {
        const cleanedBranches = await store.cleanupBranchForTask(task);
        if (cleanedBranches.length === 0) {
          return;
        }

        const deletedTask = store.readTaskFromDb(task.id, { includeDeleted: true });
        if (!deletedTask) {
          return;
        }
        const updatedAt = new Date().toISOString();
        const nextLog = [
          ...(deletedTask.log ?? []),
          {
            timestamp: updatedAt,
            action: `Cleaned up branch: ${cleanedBranches.join(", ")}`,
          },
        ];
        store.db.prepare("UPDATE tasks SET log = ?, updatedAt = ? WHERE id = ?").run(toJson(nextLog), updatedAt, task.id);
        store.db.bumpLastModified();
      } catch (error) {
        storeLog.warn("Deferred task-delete branch cleanup failed", {
          taskId: task.id,
          error: getErrorMessage(error),
        });
      }
    })();
  }

export async function deleteTaskImpl(store: TaskStore, id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: { agentId: string; runId: string; sessionId?: string; taskId?: string }; },): Promise<Task> {
    // FNXC:RuntimeLifecycleAsync 2026-06-24-12:00:
    // Backend-mode deleteTask: delegate the core async operations (task read,
    // lineage gate, lineage clear, soft-delete, audit) to the async helpers.
    // This preserves the lineage-integrity gate (VAL-DATA-010/012) and
    // soft-delete semantics against PostgreSQL. The full deleteTask
    // orchestration (dependents rewrite, branch cleanup, events) is handled
    // by the async lifecycle helpers; the SQLite path below is unchanged.
    /*
    FNXC:TaskDeletion 2026-07-01-00:00:
    Task-bound runtime callers may clean up other tasks, but the executing task must never soft-delete itself because that hides active work before the executor can finish or report failure.
    Enforce this at the store boundary so future task-delete bridges inherit the same invariant before any mutation, branch cleanup, or task:deleted audit emission. Guard fires before the backend-mode dispatch so both SQLite and PostgreSQL paths are protected.
    */
    if (options?.auditContext?.taskId === id) {
        throw new TaskSelfDeleteError(id);
    }
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

      let rewrittenDependents: Task[] = [];
      let rewrittenBlockedByResidueDependents: Task[] = [];
      let rewrittenLineageChildren: Task[] = [];
      let deletedAt = "";
      store.db.transaction(() => {
        rewrittenDependents = store.rewriteDependentsForRemoval(id, dependentIds);
        rewrittenBlockedByResidueDependents = store.rewriteBlockedByResidueDependentsForRemoval(id, new Set(dependentIds));
        rewrittenLineageChildren = store.rewriteLineageChildrenForRemoval(id, lineageChildIds);
        deletedAt = new Date().toISOString();
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

      task.column = "archived";
      task.deletedAt = deletedAt;
      task.updatedAt = deletedAt;
      scheduleDeleteBranchCleanup(store, task);

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

      /*
      FNXC:WorkflowLifecycle 2026-07-16-10:00:
      Pinned paths must be reserved before destructive archive cleanup and held
      until the awaited engine disposer finishes. The disposer is store-scoped
      so executor-less fn/CLI archives cannot silently leak a worktree.
      */
      const workspace = await disposeArchivedWorkspaceWorktrees(store, task);
      if (!workspace.singularDeduplicated) await disposeArchivedWorktree(store, task);
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


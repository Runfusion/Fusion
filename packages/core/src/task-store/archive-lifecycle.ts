/**
 * archive-lifecycle operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore, storeLog} from "../store.js";
import {TaskSelfDeleteError} from "./errors.js";
import {isWorkspaceTask, type Task, type GithubIssueAction} from "../types.js";
import {type TaskDeleteAuditContext} from "../task-delete-attribution.js";
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

function _scheduleDeleteBranchCleanup(store: TaskStore, task: Task): void {
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

export async function deleteTaskImpl(store: TaskStore, id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: TaskDeleteAuditContext; },): Promise<Task> {
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
        return store.deleteTaskBackend(id, options);
}

export interface DeleteTaskIfResult {
  task: Task;
  deleted: boolean;
}

/**
 * FNXC:TaskDeletion 2026-07-29-12:00:
 * FN-8361 conditional deletion evaluates the recovery predicate in delete's own
 * lock. An atomic update followed by delete is two lock acquisitions and can
 * delete an advanced card; `{ task, deleted }` is the authoritative skip signal.
 */
export async function deleteTaskIfImpl(
  store: TaskStore,
  id: string,
  predicate: (live: Task) => boolean | Promise<boolean>,
  options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: TaskDeleteAuditContext },
): Promise<DeleteTaskIfResult> {
  if (options?.auditContext?.taskId === id) throw new TaskSelfDeleteError(id);
  /*
  FNXC:SqliteDualPathCleanup 2026-07-26-14:07:
  deleteTaskIf is PostgreSQL-only; the SQLite transaction arm is deleted. Delegate to the store entry which routes to deleteTaskIfBackendImpl.
  */
  /*
  FNXC:SqliteDualPathCleanup 2026-07-26-14:08:
  Avoid store.deleteTaskIf recursion; call the PG backend impl directly.
  */
  return store.deleteTaskIf(id, predicate, options);
}

export async function archiveTaskImpl(store: TaskStore, id: string, optionsOrCleanup: boolean | { cleanup?: boolean; removeLineageReferences?: boolean } = true,): Promise<Task> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:08:
    archiveTask is PostgreSQL-only via archiveTaskBackend (async archive-lineage helper).
    */
    return store.archiveTaskBackend(id, optionsOrCleanup);
}


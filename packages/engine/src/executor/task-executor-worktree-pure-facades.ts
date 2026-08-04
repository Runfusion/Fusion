/**
 * FNXC:CodeOrganization 2026-08-04-08:05:
 * Pure worktree helper facades peeled from TaskExecutor (U4). Keeps executor.ts to
 * impl/bags facades while pure.* worktree ownership helpers share TaskExecutorState fields.
 */
import * as pure from "./pure-bindings.js";
import * as bags from "./deps-bags.js";
import { bindTryCreateWorktree } from "./worktree-create-binders.js";
import { type FacadeRestArgs, type FacadeAfterSecond } from "./facade-methods.js";
import { TaskExecutorState } from "./task-executor-state.js";

export abstract class TaskExecutorWorktreePureFacades extends TaskExecutorState {
  protected hasActiveWorktreeBinding(taskId: string, worktreePath: string): boolean { return pure.hasActiveWorktreeBinding(this.activeWorktrees, taskId, worktreePath); }
  protected async shouldGenerateNewWorktreeName(conflictPath: string, currentTaskId: string): Promise<boolean> { return pure.shouldGenerateNewWorktreeName(this.activeWorktrees, this.store, conflictPath, currentTaskId); }
  protected async findActiveWorktreeOwner(worktreePath: string, requestingTaskId: string): Promise<string | null> { return pure.findActiveWorktreeOwner(this.activeWorktrees, this.store, worktreePath, requestingTaskId); }
  protected async isLiveCleanupRefusal(worktreePath: string, taskId: string): Promise<boolean> { return pure.isLiveCleanupRefusal(this.activeWorktrees, this.store, worktreePath, taskId); }
  protected async cleanupStaleBranch(branch: string, taskId: string): Promise<boolean> { return pure.cleanupStaleBranch(this.rootDir, this.store, branch, taskId); }
  protected async planSquashImportFromDep(...args: FacadeAfterSecond<typeof pure.planSquashImportFromDep>): ReturnType<typeof pure.planSquashImportFromDep> { return pure.planSquashImportFromDep(this.rootDir, this.store, ...args); }
  protected async reconcileSelfOwnedBeforeRemove(...args: FacadeRestArgs<typeof pure.reconcileSelfOwnedBeforeRemove>): ReturnType<typeof pure.reconcileSelfOwnedBeforeRemove> { return pure.reconcileSelfOwnedBeforeRemove(this.store, ...args); }
  protected async emitStaleLockAudit(...args: FacadeRestArgs<typeof pure.emitStaleLockAudit>): ReturnType<typeof pure.emitStaleLockAudit> { return pure.emitStaleLockAudit(bags.buildStaleLockRecoveryDeps(this), ...args); }
  protected async recoverIndexLockIfStale(taskId: string, path: string, conflictInfo: { lockPath?: string; message?: string }): Promise<boolean> { return pure.recoverIndexLockIfStale(bags.buildStaleLockRecoveryDeps(this), taskId, path, conflictInfo); }
  protected async recoverStaleRegistration(taskId: string, path: string, conflictInfo: { path?: string; message?: string }): Promise<boolean> { return pure.recoverExecutorStaleRegistration(bags.buildStaleLockRecoveryDeps(this), taskId, path, conflictInfo); }
  protected async normalizeReclaimableWorktreePath(...args: FacadeRestArgs<typeof pure.normalizeReclaimableWorktreePath>): ReturnType<typeof pure.normalizeReclaimableWorktreePath> { return pure.normalizeReclaimableWorktreePath(bags.buildNormalizeReclaimableWorktreePathDeps(this), ...args); }
  protected async tryFreshWorktreeAfterLiveConflict(...args: FacadeRestArgs<typeof pure.tryFreshWorktreeAfterLiveConflict>): Promise<{ path: string; branch: string }> { return pure.tryFreshWorktreeAfterLiveConflict(bags.buildTryFreshWorktreeAfterLiveConflictDeps(this, bindTryCreateWorktree(this)), ...args); }
  protected async removeOwnWorktreeWithReconcile(...args: FacadeRestArgs<typeof pure.removeOwnWorktreeWithReconcile>): ReturnType<typeof pure.removeOwnWorktreeWithReconcile> { return pure.removeOwnWorktreeWithReconcile(bags.buildRemoveOwnWorktreeWithReconcileDeps(this), ...args); }
}

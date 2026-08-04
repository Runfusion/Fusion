/**
 * FNXC:CodeOrganization 2026-08-04-08:05:
 * Pure worktree helper facades peeled from TaskExecutor (U4). Keeps executor.ts to
 * impl/bags facades while pure.* worktree ownership helpers share TaskExecutorState fields.
 *
 * FNXC:CodeOrganization 2026-08-04-08:55:
 * Also hosts impl worktree create/conflict/cleanup facades and capture helpers so
 * executor.ts drops the worktree-create tail.
 */
import * as pure from "./pure-bindings.js";
import * as impl from "./impl-bindings.js";
import * as bags from "./deps-bags.js";
import * as constants from "./executor-constants.js";
import { bindHandleWorktreeConflict, bindTryCreateWorktree } from "./worktree-create-binders.js";
import { type FacadeRestArgs, type FacadeAfterFirst, type FacadeAfterSecond } from "./facade-methods.js";
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
  protected async reclaimExistingWorktree(...args: FacadeRestArgs<typeof impl.reclaimExistingWorktreeImpl>): ReturnType<typeof impl.reclaimExistingWorktreeImpl> { return impl.reclaimExistingWorktreeImpl(bags.buildBranchConflictHandleFacadeDeps(this), ...args); }
  protected async handleBranchConflict(...args: FacadeRestArgs<typeof impl.handleBranchConflictImpl>): ReturnType<typeof impl.handleBranchConflictImpl> { return impl.handleBranchConflictImpl(bags.buildBranchConflictHandleFacadeDeps(this), ...args); }
  protected async recoverMissingWorktreeSessionStartFailure(...args: FacadeRestArgs<typeof impl.recoverMissingWorktreeSessionStartFailureImpl>): ReturnType<typeof impl.recoverMissingWorktreeSessionStartFailureImpl> { return impl.recoverMissingWorktreeSessionStartFailureImpl(bags.buildRecoverMissingWorktreeSessionStartFailureDeps(this), ...args); }
  protected async emitWorktreeReanchoredAudit(...args: FacadeRestArgs<typeof impl.emitWorktreeReanchoredAuditImpl>): ReturnType<typeof impl.emitWorktreeReanchoredAuditImpl> { return impl.emitWorktreeReanchoredAuditImpl(bags.buildStoreRunContextDeps(this), ...args); }
  listWorktreeHolders(): Array<{ taskId: string; worktreePath: string }> { return impl.listWorktreeHoldersImpl(this.activeWorktrees); }
  protected async tryCreateWorktree(...args: FacadeRestArgs<typeof impl.tryCreateWorktreeImpl>): Promise<{ path: string; branch: string }> { return impl.tryCreateWorktreeImpl(bags.buildWorktreeCreateConflictFacadeDeps(this, constants.MAX_WORKTREE_RETRIES, bindHandleWorktreeConflict(this), bindTryCreateWorktree(this)), ...args); }
  protected async handleWorktreeConflict(...args: FacadeRestArgs<typeof impl.handleWorktreeConflictImpl>): Promise<{ path: string; branch: string } | null> { return impl.handleWorktreeConflictImpl(bags.buildWorktreeCreateConflictFacadeDeps(this, constants.MAX_WORKTREE_RETRIES, bindHandleWorktreeConflict(this), bindTryCreateWorktree(this)), ...args); }
  protected async cleanupConflictingWorktree(...args: FacadeRestArgs<typeof impl.cleanupConflictingWorktreeImpl>): ReturnType<typeof impl.cleanupConflictingWorktreeImpl> { return impl.cleanupConflictingWorktreeImpl(bags.buildCleanupConflictingWorktreeDeps(this), ...args); }
  protected async resolveWorktreeStartPoint(startPoint: string, taskId: string): ReturnType<typeof impl.resolveWorktreeStartPointImpl> { return impl.resolveWorktreeStartPointImpl(this.rootDir, this.store, startPoint, taskId); }
  protected async squashImportDepIntoWorktree(...args: FacadeAfterFirst<typeof impl.squashImportDepIntoWorktreeImpl>): ReturnType<typeof impl.squashImportDepIntoWorktreeImpl> { return impl.squashImportDepIntoWorktreeImpl(this.store, ...args); }
  protected async rebaseNewWorktreeOntoRemote(...args: FacadeAfterSecond<typeof impl.rebaseNewWorktreeOntoRemoteImpl>): ReturnType<typeof impl.rebaseNewWorktreeOntoRemoteImpl> { return impl.rebaseNewWorktreeOntoRemoteImpl(this.rootDir, this.store, ...args); }
  protected async createWorktree(...args: FacadeRestArgs<typeof impl.createWorktreeImpl>): Promise<{ path: string; branch: string }> { return impl.createWorktreeImpl(bags.buildCreateWorktreeFacadeDeps(this, bindTryCreateWorktree(this)), ...args); }
  disposeStoreLifecycleDisposers(): void { impl.disposeStoreLifecycleDisposersImpl(bags.buildDisposeStoreLifecycleDisposersDeps(this)); }
  async cleanup(taskId: string): Promise<void> { return impl.cleanupTaskWorktreeImpl(bags.buildCleanupTaskWorktreeDeps(this), taskId); }
  getWorktreePath(taskId: string): string | undefined { return impl.getWorktreePathImpl(this.workspaceConfig, (id) => this.getActiveWorktreePaths(id), taskId); }
  // getActiveWorktreePaths is hosted on session facades; abstract for getWorktreePath
  protected abstract getActiveWorktreePaths(taskId: string): string[];
}

import type { Task, TaskStore } from "@fusion/core";
/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * Free builders for TaskExecutor deps bags that wire peeled worktree/session helpers (U4).
 *
 * These stay free functions so circular this-callbacks remain assembled at the facade edge.
 */
import type { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import { createRunAuditor, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import type { BranchConflictHandleDeps } from "./worktree-branch-conflict-handle.js";
import type { WorktreeCreateConflictDeps } from "./worktree-create-conflict.js";
import type { WorktreeInvariantDeps } from "./worktree-verify-invariants.js";
import type { NonContinuableSessionDeps } from "./non-continuable-session.js";

export type BranchConflictHandleDepsSource = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  findActiveWorktreeOwner: BranchConflictHandleDeps["findActiveWorktreeOwner"];
  normalizeReclaimableWorktreePath: BranchConflictHandleDeps["normalizeReclaimableWorktreePath"];
  cleanupConflictingWorktree: BranchConflictHandleDeps["cleanupConflictingWorktree"];
  getAutoRecoveryDispatcher: (audit: RunAuditor) => AutoRecoveryDispatcher;
  persistTokenUsage: (taskId: string) => Promise<void>;
  onError?: (task: Task, error: Error) => void;
};

export function buildBranchConflictHandleDeps(src: BranchConflictHandleDepsSource): BranchConflictHandleDeps {
  return {
    rootDir: src.rootDir,
    store: src.store,
    getRunContextFor: src.getRunContextFor,
    findActiveWorktreeOwner: src.findActiveWorktreeOwner,
    normalizeReclaimableWorktreePath: src.normalizeReclaimableWorktreePath,
    cleanupConflictingWorktree: src.cleanupConflictingWorktree,
    getAutoRecoveryDispatcher: src.getAutoRecoveryDispatcher,
    createRunAuditor: (runContext) => createRunAuditor(src.store, runContext),
    persistTokenUsage: src.persistTokenUsage,
    onError: src.onError,
  };
}

export type WorktreeCreateConflictDepsSource = {
  rootDir: string;
  store: TaskStore;
  maxWorktreeRetries: number;
  recoverIndexLockIfStale: WorktreeCreateConflictDeps["recoverIndexLockIfStale"];
  recoverStaleRegistration: WorktreeCreateConflictDeps["recoverStaleRegistration"];
  cleanupStaleBranch: WorktreeCreateConflictDeps["cleanupStaleBranch"];
  handleWorktreeConflict: WorktreeCreateConflictDeps["handleWorktreeConflict"];
  tryCreateWorktree: WorktreeCreateConflictDeps["tryCreateWorktree"];
  tryFreshWorktreeAfterLiveConflict: WorktreeCreateConflictDeps["tryFreshWorktreeAfterLiveConflict"];
  shouldGenerateNewWorktreeName: WorktreeCreateConflictDeps["shouldGenerateNewWorktreeName"];
  cleanupConflictingWorktree: WorktreeCreateConflictDeps["cleanupConflictingWorktree"];
  normalizeReclaimableWorktreePath: WorktreeCreateConflictDeps["normalizeReclaimableWorktreePath"];
  isLiveCleanupRefusal: WorktreeCreateConflictDeps["isLiveCleanupRefusal"];
};

export function buildWorktreeCreateConflictDeps(src: WorktreeCreateConflictDepsSource): WorktreeCreateConflictDeps {
  return {
    rootDir: src.rootDir,
    store: src.store,
    maxWorktreeRetries: src.maxWorktreeRetries,
    recoverIndexLockIfStale: src.recoverIndexLockIfStale,
    recoverStaleRegistration: src.recoverStaleRegistration,
    cleanupStaleBranch: src.cleanupStaleBranch,
    handleWorktreeConflict: src.handleWorktreeConflict,
    tryCreateWorktree: src.tryCreateWorktree,
    tryFreshWorktreeAfterLiveConflict: src.tryFreshWorktreeAfterLiveConflict,
    shouldGenerateNewWorktreeName: src.shouldGenerateNewWorktreeName,
    cleanupConflictingWorktree: src.cleanupConflictingWorktree,
    normalizeReclaimableWorktreePath: src.normalizeReclaimableWorktreePath,
    isLiveCleanupRefusal: src.isLiveCleanupRefusal,
  };
}

export type WorktreeInvariantDepsSource = {
  rootDir: string;
  store: TaskStore;
  workspaceConfig: unknown | null | undefined;
  getActiveWorktreePaths: (taskId: string) => string[];
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  emitWorktreeReanchoredAudit: WorktreeInvariantDeps["emitWorktreeReanchoredAudit"];
};

export function buildWorktreeInvariantDeps(src: WorktreeInvariantDepsSource): WorktreeInvariantDeps {
  return {
    rootDir: src.rootDir,
    store: src.store,
    workspaceConfig: src.workspaceConfig,
    getActiveWorktreePaths: src.getActiveWorktreePaths,
    getRunContextFor: src.getRunContextFor,
    emitWorktreeReanchoredAudit: src.emitWorktreeReanchoredAudit,
  };
}

export type NonContinuableSessionDepsSource = NonContinuableSessionDeps;

export function buildNonContinuableSessionDeps(src: NonContinuableSessionDepsSource): NonContinuableSessionDeps {
  return {
    store: src.store,
    getRunContextFor: src.getRunContextFor,
    resolveResumeLanes: src.resolveResumeLanes,
    persistTokenUsage: src.persistTokenUsage,
    clearCompletedTaskWatchdog: src.clearCompletedTaskWatchdog,
    signalTaskComplete: src.signalTaskComplete,
    handoffTaskToReview: src.handoffTaskToReview,
    markGraphExecuteSelfRequeued: src.markGraphExecuteSelfRequeued,
  };
}

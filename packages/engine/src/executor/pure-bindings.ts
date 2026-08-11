/**
 * FNXC:CodeOrganization 2026-08-03-21:45:
 * Non-Impl free helpers imported by TaskExecutor facades (U4 pure-bindings barrel).
 */

export {
  isTaskWorkComplete,
  createSeenSteeringIds,
} from "./task-predicates.js";
export { extractOwnSettings } from "./agent-binding-pure.js";
export { evaluateTaskDoneRefusal } from "./task-done-refusal.js";
export {
  hasActiveWorktreeBinding,
  shouldGenerateNewWorktreeName,
  findActiveWorktreeOwner,
  isLiveCleanupRefusal,
} from "./worktree-ownership.js";
export { cleanupStaleBranch } from "./worktree-stale-branch.js";
export { planSquashImportFromDep } from "./worktree-squash-import-plan.js";
export { reconcileSelfOwnedBeforeRemove } from "./worktree-self-owned-reconcile.js";
export {
  emitStaleLockAudit,
  recoverIndexLockIfStale,
  recoverExecutorStaleRegistration,
} from "./worktree-stale-lock-recovery.js";
export { normalizeReclaimableWorktreePath } from "./worktree-reclaim-path.js";
export { removeOwnWorktreeWithReconcile } from "./worktree-remove-own.js";
export { tryFreshWorktreeAfterLiveConflict } from "./worktree-fresh-after-conflict.js";
export { formatCommentForInjection } from "./execution-prompt.js";
export { detectReviewHandoffIntent } from "./pseudo-pause.js";
export { runConfiguredCommand } from "./configured-command.js";

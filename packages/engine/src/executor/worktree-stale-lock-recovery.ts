/**
 * FNXC:CodeOrganization 2026-08-03-14:50:
 * Stale index.lock / stale registration recovery peeled from TaskExecutor (U4 Slice B).
 * Inject rootDir, store, and run-context lookup; keep thin class wrappers for spies.
 */
import { resolve as resolvePath } from "node:path";
import type { RunMutationContext, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import {
  StaleWorktreeIndexLockError,
  classifyStaleLock,
  tryRemoveStaleLock,
} from "../worktree/worktree-stale-lock.js";
import { recoverStaleRegistration } from "../worktree/worktree-stale-registration.js";
import { createRunAuditor } from "../util/run-audit.js";
import { executorLog } from "../logger.js";

export type StaleLockAuditEvent =
  | "worktree:stale-lock-detected"
  | "worktree:stale-lock-recovered"
  | "worktree:stale-lock-recovery-failed"
  | "worktree:stale-lock-refused"
  | "worktree:stale-registration-detected"
  | "worktree:stale-registration-recovered"
  | "worktree:stale-registration-recovery-failed";

export type StaleLockRecoveryDeps = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => RunMutationContext | undefined;
};

export async function emitStaleLockAudit(
  deps: StaleLockRecoveryDeps,
  taskId: string,
  event: StaleLockAuditEvent,
  targetPath: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const runContext = deps.getRunContextFor(taskId);
  if (!runContext?.runId || !runContext.agentId) return;
  const auditor = createRunAuditor(deps.store, {
    runId: runContext.runId,
    agentId: runContext.agentId,
    taskId,
    phase: "execute",
  });
  await auditor.git({ type: event, target: targetPath, metadata });
}

export async function recoverIndexLockIfStale(
  deps: StaleLockRecoveryDeps,
  taskId: string,
  path: string,
  conflictInfo: { lockPath?: string; message?: string },
): Promise<boolean> {
  const lockPath = conflictInfo.lockPath;
  if (!lockPath) return false;

  const classification = await classifyStaleLock({
    rootDir: deps.rootDir,
    lockPath,
    activeSessionRegistry,
  });
  await emitStaleLockAudit(deps, taskId, "worktree:stale-lock-detected", path, {
    lockPath,
    classification: classification.kind,
    reason: classification.reason,
    ageMs: classification.ageMs ?? null,
    owningWorktreePath: classification.owningWorktreePath ?? null,
  });

  if (classification.kind !== "stale") {
    await emitStaleLockAudit(deps, taskId, "worktree:stale-lock-refused", path, {
      lockPath,
      classification: classification.kind,
      reason: classification.reason,
      ageMs: classification.ageMs ?? null,
      owningWorktreePath: classification.owningWorktreePath ?? null,
    });
    throw new StaleWorktreeIndexLockError({
      message: `Worktree creation blocked: index.lock at ${resolvePath(deps.rootDir, lockPath)} is held by another git process (reason: ${classification.reason}, owning worktree ${classification.owningWorktreePath ?? "unknown"}). Resolve manually before retrying.`,
      lockPath: resolvePath(deps.rootDir, lockPath),
      classification: classification.kind,
      reason: classification.reason,
    });
  }

  try {
    const removed = await tryRemoveStaleLock({ lockPath: resolvePath(deps.rootDir, lockPath) });
    if (removed.removed) {
      await emitStaleLockAudit(deps, taskId, "worktree:stale-lock-recovered", path, { lockPath });
      await deps.store.logEntry(
        taskId,
        `Recovered stale worktree index.lock and retrying`,
        resolvePath(deps.rootDir, lockPath),
        deps.getRunContextFor(taskId),
      );
      return true;
    }
    await emitStaleLockAudit(deps, taskId, "worktree:stale-lock-recovery-failed", path, {
      lockPath,
      reason: removed.reason ?? "not-removed",
    });
    return false;
  } catch (error) {
    await emitStaleLockAudit(deps, taskId, "worktree:stale-lock-recovery-failed", path, {
      lockPath,
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Recover a stale git worktree registration that blocks creation at `path`.
 * Returns true when recovery succeeded and the caller should retry.
 */
export async function recoverExecutorStaleRegistration(
  deps: StaleLockRecoveryDeps,
  taskId: string,
  path: string,
  conflictInfo: { path?: string; message?: string },
): Promise<boolean> {
  const staleRegistrationPath = conflictInfo.path ?? path;
  await emitStaleLockAudit(deps, taskId, "worktree:stale-registration-detected", path, {
    staleRegistrationPath,
    worktreePath: path,
  });

  const recovery = await recoverStaleRegistration({
    rootDir: deps.rootDir,
    worktreePath: path,
    logger: executorLog,
  });

  if (recovery.recovered) {
    await emitStaleLockAudit(deps, taskId, "worktree:stale-registration-recovered", path, {
      actions: recovery.actions,
    });
    await deps.store.logEntry(
      taskId,
      "Recovered stale worktree registration and retrying",
      staleRegistrationPath,
      deps.getRunContextFor(taskId),
    );
    return true;
  }

  await emitStaleLockAudit(deps, taskId, "worktree:stale-registration-recovery-failed", path, {
    actions: recovery.actions,
    reason: recovery.reason ?? "unknown",
  });
  return false;
}

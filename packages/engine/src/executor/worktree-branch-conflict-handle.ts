/**
 * FNXC:CodeOrganization 2026-08-03-16:05:
 * reclaimExistingWorktree + handleBranchConflict peeled from TaskExecutor (U4 Slice B).
 * Branch-conflict recovery lifecycle: inspect → reclaim/retry/sticky, with FN-4811 live-owner guard.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings, Task, TaskStore } from "@fusion/core";
import {
  assertCleanBranchAtBase,
  BranchConflictError,
  inspectBranchConflict,
} from "../execution/branch-conflicts.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { preservedWorktreeTargetPathForTask } from "../worktree/worktree-pinning.js";
import { executorLog } from "../logger.js";
import type { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import type { EngineRunContext, RunAuditor } from "../util/run-audit.js";
import { resolveDiffBaseRef } from "./worktree-git-refs.js";
import { getWorktreeBranchMap } from "./worktree-registry-helpers.js";
import {
  formatBranchConflictAgentLog,
  formatBranchConflictLifecycleLog,
} from "./branch-conflict-format.js";

const execAsync = promisify(exec);

export type BranchConflictHandleDeps = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  findActiveWorktreeOwner: (worktreePath: string, requestingTaskId: string) => Promise<string | null>;
  normalizeReclaimableWorktreePath: (
    sourcePath: string,
    targetPath: string,
    taskId: string,
    settings: Partial<Settings>,
  ) => Promise<string>;
  cleanupConflictingWorktree: (worktreePath: string, branch: string, taskId: string) => Promise<boolean>;
  getAutoRecoveryDispatcher: (audit: RunAuditor) => AutoRecoveryDispatcher;
  createRunAuditor: (runContext: EngineRunContext | undefined) => RunAuditor;
  persistTokenUsage: (taskId: string) => Promise<void>;
  onError?: (task: Task, error: Error) => void;
};

export async function reclaimExistingWorktree(
  deps: BranchConflictHandleDeps,
  task: Task,
  livePath: string,
  branch: string,
  tipSha: string,
  count: number,
  settings: Partial<Settings>,
): Promise<void> {
  const targetPath = preservedWorktreeTargetPathForTask(task.id, livePath, settings, deps.rootDir);
  const normalizedPath = await deps.normalizeReclaimableWorktreePath(livePath, targetPath, task.id, settings);
  await deps.store.updateTask(task.id, { worktree: normalizedPath, branch });
  const latestTask = await deps.store.getTask(task.id);
  const baseRef = await resolveDiffBaseRef(normalizedPath, latestTask.baseCommitSha);
  if (baseRef) {
    await assertCleanBranchAtBase(deps.rootDir, branch, baseRef, task.id);
  }
  const message = `[recovery] reclaimed existing worktree for ${task.id} at ${normalizedPath} (${count} commits preserved, tip ${tipSha.slice(0, 12)})`;
  await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
  await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
}

export async function handleBranchConflict(
  deps: BranchConflictHandleDeps,
  task: Task,
  error: BranchConflictError,
): Promise<"retry" | "reclaimed" | "sticky"> {
  // FN-4811: Before invoking inspection-based recovery (which may force-remove the
  // conflicting worktree), verify the conflict isn't currently bound to a live session.
  // If it is, refuse the whole recovery dance — a force-remove here would yank an active
  // task's filesystem out from under it, producing FN-4781/FN-4804-style cascade failures.
  const activeOwner = await deps.findActiveWorktreeOwner(error.conflictingWorktreePath, task.id);
  if (activeOwner !== null) {
    const refusalMessage = `[FN-4811] Branch conflict on ${error.branchName} deferred: conflicting worktree ${error.conflictingWorktreePath} is actively owned by ${activeOwner}`;
    executorLog.warn(refusalMessage);
    await deps.store.logEntry(task.id, refusalMessage, undefined, deps.getRunContextFor(task.id));
    return "sticky";
  }
  const settings = await mergeEffectiveSettings(deps.store, task, await deps.store.getSettings());

  const integrationRef = task.mergeDetails?.mergeTargetBranch ?? task.baseBranch ?? task.executionStartBranch ?? await resolveIntegrationBranch(deps.rootDir, undefined);
  const inspection = await inspectBranchConflict({
    repoDir: deps.rootDir,
    branchName: error.branchName,
    conflictingWorktreePath: error.conflictingWorktreePath,
    requestingTaskId: task.id,
    ownerTaskId: task.id,
    startPoint: error.startPoint,
    integrationRef,
  });

  if (inspection.kind === "stale-resolved") {
    await deps.store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
    const message = `[recovery] ${task.id} stage-A: pruned stale admin entry for ${error.branchName}`;
    await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
    await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
    return "retry";
  }

  if (inspection.kind === "tip-already-merged") {
    if (inspection.livePath) {
      await deps.cleanupConflictingWorktree(inspection.livePath, error.branchName, task.id);
    }
    try {
      await execAsync("git worktree prune", {
        cwd: deps.rootDir,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // best-effort
    }
    try {
      await execAsync(`git branch -D ${JSON.stringify(error.branchName)}`, {
        cwd: deps.rootDir,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // best-effort
    }
    await deps.store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
    const message = `[recovery] ${task.id} stage-A: tip-already-merged cleanup for ${error.branchName} (${inspection.tipSha.slice(0, 12)} on ${inspection.integrationRef})`;
    await deps.store.logEntry(task.id, message, undefined, deps.getRunContextFor(task.id));
    await deps.store.appendAgentLog(task.id, "Branch conflict auto-recovery", "status", message, "executor");
    return "retry";
  }

  if (inspection.kind === "reclaimable") {
    await reclaimExistingWorktree(deps, task, inspection.livePath, error.branchName, inspection.tipSha, inspection.taskAttributedCommitCount, settings);
    return "reclaimed";
  }

  if (inspection.kind === "fully-subsumed") {
    await reclaimExistingWorktree(deps, task, inspection.livePath, error.branchName, inspection.tipSha, 0, settings);
    return "reclaimed";
  }

  if (inspection.kind === "live-foreign") {
    const cleanupSuccess = await deps.cleanupConflictingWorktree(inspection.livePath, error.branchName, task.id);
    if (cleanupSuccess) {
      try {
        await execAsync("git worktree prune", { cwd: deps.rootDir });
      } catch {
        // best-effort
      }
      try {
        const worktreeMap = await getWorktreeBranchMap(deps.rootDir);
        if (!worktreeMap.has(error.branchName)) {
          await execAsync(`git branch -D "${error.branchName}"`, { cwd: deps.rootDir });
        }
      } catch {
        // best-effort
      }
      return "retry";
    }
  }

  const conflictMessage = `Task branch conflict: ${error.branchName} is already checked out at ${error.conflictingWorktreePath}. ` +
    `Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.`;
  await deps.store.logEntry(task.id, formatBranchConflictLifecycleLog(task.id, error), undefined, deps.getRunContextFor(task.id));
  await deps.store.appendAgentLog(task.id, "Branch conflict recovery required", "tool_error", formatBranchConflictAgentLog(task.id, error), "executor");
  const autoRecoveryDispatcher = deps.getAutoRecoveryDispatcher(deps.createRunAuditor(deps.getRunContextFor(task.id)));
  const decision = await autoRecoveryDispatcher.dispatch({
    class: "branch-conflict-unrecoverable",
    taskId: task.id,
    runId: deps.getRunContextFor(task.id)?.runId,
    pausedReason: "branch-conflict-unrecoverable",
    evidence: {
      branchName: error.branchName,
      conflictingWorktreePath: error.conflictingWorktreePath,
    },
    underlyingError: error,
  }, {
    task,
    retryCount: task.recoveryRetryCount ?? 0,
    settings: (await deps.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
  });

  if (decision.action === "pause") {
    await deps.store.updateTask(task.id, {
      status: "failed",
      error: conflictMessage,
      branch: error.branchName,
      worktree: error.conflictingWorktreePath,
      paused: true,
      pausedReason: "branch-conflict-unrecoverable",
    });
    await deps.persistTokenUsage(task.id);
    executorLog.warn(`✗ ${task.id} branch conflict sticky failure: ${error.branchName} @ ${error.conflictingWorktreePath}`);
    deps.onError?.(task, error);
    return "sticky";
  }

  return "retry";
}

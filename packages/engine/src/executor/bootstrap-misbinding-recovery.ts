/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * tryBootstrapMisbindingRecovery peeled from TaskExecutor (U4).
 * Re-anchor branches that were bootstrapped onto wrong base with zero own commits.
 */
import type { Task, TaskStore } from "@fusion/core";
import {
  BranchCrossContaminationError,
  classifyBootstrapMisbinding,
  reanchorBranchToBase,
} from "../execution/branch-conflicts.js";
import { classifyTaskWorktree } from "../worktree/worktree-pool.js";
import { formatError } from "../logger.js";
import type { EngineRunContext, RunAuditor } from "../util/run-audit.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

export type BootstrapMisbindingRecoveryDeps = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  markGraphExecuteSelfRequeued: (taskId: string) => void;
};

export async function tryBootstrapMisbindingRecovery(
  deps: BootstrapMisbindingRecoveryDeps,
  task: Task,
  contamination: BranchCrossContaminationError,
  audit: RunAuditor,
): Promise<boolean> {
  const bootstrap = await classifyBootstrapMisbinding({
    repoDir: deps.rootDir,
    branchName: contamination.branchName,
    baseSha: contamination.baseSha,
    taskId: task.id,
    foreignCommits: contamination.foreignCommits,
  });

  if (!bootstrap.isBootstrapMisbinding) {
    return false;
  }

  const worktreePath = task.worktree;
  const worktreeClassification = worktreePath
    ? await classifyTaskWorktree(deps.rootDir, worktreePath)
    : { ok: false as const };
  if (!worktreePath || !worktreeClassification.ok) {
    await deps.store.logEntry(task.id, `[recovery] bootstrap misbinding detected but worktree unavailable for re-anchor: ${worktreePath ?? "none"}`, undefined, deps.getRunContextFor(task.id));
    return false;
  }

  await deps.store.logEntry(task.id, `[recovery] bootstrap-time branch misbinding detected on ${contamination.branchName}: 0 own commits, re-anchoring to ${contamination.baseSha}`, undefined, deps.getRunContextFor(task.id));

  try {
    const reanchor = await reanchorBranchToBase({
      repoDir: deps.rootDir,
      worktreePath,
      branchName: contamination.branchName,
      baseSha: contamination.baseSha,
      taskId: task.id,
    });
    await audit.git({
      type: "branch:reanchor",
      target: contamination.branchName,
      metadata: {
        taskId: task.id,
        baseSha: contamination.baseSha,
        previousTipSha: reanchor.previousTipSha,
        newTipSha: reanchor.newTipSha,
        trigger: "bootstrap-misbinding",
      },
    });
    await deps.store.updateTask(task.id, {
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      error: null,
      paused: false,
      pausedReason: null,
    });
    deps.markGraphExecuteSelfRequeued(task.id);
    await deps.store.moveTask(task.id, await resolveReboundColumnFor(deps.store, task.id), { preserveResumeState: false, preserveWorktree: true });
    return true;
  } catch (error) {
    await deps.store.logEntry(task.id, `[recovery] bootstrap re-anchor failed; falling back to contamination safety path: ${formatError(error)}`, undefined, deps.getRunContextFor(task.id));
    return false;
  }
}

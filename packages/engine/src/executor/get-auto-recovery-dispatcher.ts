/**
 * FNXC:CodeOrganization 2026-08-03-11:45:
 * getAutoRecoveryDispatcher peeled from TaskExecutor (U4).
 * Builds the default AutoRecoveryDispatcher with file-scope, branch-worktree, and contamination handlers.
 */
import type { ProjectSettings, TaskStore } from "@fusion/core";
import { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import { createFileScopeAutoRecoveryHandler } from "../auto-recovery-handlers/file-scope.js";
import { BranchWorktreeAutoRecoveryHandler } from "../auto-recovery-handlers/branch-worktree.js";
import { ContaminationAutoRecoveryHandler } from "../auto-recovery-handlers/contamination.js";
import { executorLog } from "../logger.js";
import type { RunAuditor } from "../util/run-audit.js";

export type GetAutoRecoveryDispatcherDeps = {
  store: TaskStore;
  rootDir: string;
  autoRecoveryDispatcher?: AutoRecoveryDispatcher | null;
};

export function getAutoRecoveryDispatcher(
  deps: GetAutoRecoveryDispatcherDeps,
  audit: RunAuditor,
): AutoRecoveryDispatcher {
  if (deps.autoRecoveryDispatcher) return deps.autoRecoveryDispatcher;
  const fileScopeHandler = createFileScopeAutoRecoveryHandler({
    taskStore: deps.store,
    runAudit: audit,
    logger: executorLog,
    spawnAgent: async () => ({ agentId: "unavailable" }),
    classifyPatchIds: async () => ({ unique: [], alreadyUpstream: [] }),
    settings: () => ({ autoRecovery: { mode: "deterministic-only", maxRetries: 3 } } as ProjectSettings),
  });
  const branchWorktreeHandler = new BranchWorktreeAutoRecoveryHandler({
    taskStore: deps.store,
    runAudit: audit,
    logger: executorLog,
  });
  const contaminationHandler = new ContaminationAutoRecoveryHandler({
    taskStore: deps.store,
    runAudit: audit,
    logger: executorLog,
    repoDir: deps.rootDir,
  });
  return new AutoRecoveryDispatcher({
    taskStore: deps.store,
    auditEmitter: audit,
    handlers: {
      issueRetry: async (failure, decision, ctx) => {
        if (failure.class === "branch-cross-contamination") {
          return contaminationHandler.issueRetry(failure, decision, ctx);
        }
        if (failure.class === "branch-conflict-unrecoverable") {
          return branchWorktreeHandler.issueRetry(failure, decision, ctx);
        }
        return fileScopeHandler.issueRetry(failure, decision, ctx);
      },
      spawnAiRecovery: async (failure, decision, ctx) => {
        if (failure.class === "branch-conflict-unrecoverable") {
          return branchWorktreeHandler.spawnAiRecovery(failure, decision, ctx);
        }
        return fileScopeHandler.spawnAiRecovery(failure, decision, ctx);
      },
    },
  });
}

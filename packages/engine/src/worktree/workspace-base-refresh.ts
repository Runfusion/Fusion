import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunMutationContext, Settings, Task, TaskStore } from "@fusion/core";
import { refreshReusedWorktreeBase, type WorktreeBaseRefreshResult } from "../worktree-base-refresh.js";
import { WorktreeBaseRefreshError } from "./worktree-acquisition.js";
import type { RunAuditor } from "../util/run-audit.js";
import { recordWorkspaceBaseBranchDecision, resolveWorkspaceRepoBaseBranch } from "./workspace-base-branch.js";
import { readPersistedWorktreeBackendKind } from "./worktree-backend.js";

export type RefreshWorkspaceRepoWorktreeBasesInput = {
  task: Task;
  workspaceRootDir: string;
  repoRelPaths: readonly string[];
  store: TaskStore;
  settings: Partial<Settings>;
  audit?: Pick<RunAuditor, "git">;
  logger?: { log: (message: string) => void; warn: (message: string) => void; debug?: (message: string) => void };
  runContext?: RunMutationContext;
};

export type RefreshWorkspaceRepoWorktreeBasesResult = {
  task: Task;
  results: Array<{ repoRelPath: string; result: WorktreeBaseRefreshResult }>;
};

/*
FNXC:WorkspaceFileOverlap 2026-08-30-19:14:
A workspace card released from a file-overlap hold previously reused every live repository checkout verbatim,
leaving it on the base from before the holder landed. Refresh each repository after acquisition is complete so
no task lock is re-entered, and retain the singular refresh policy: dirty, conflicting, and unresolvable bases
keep their proven local checkout and defer conflict resolution to the merge lane rather than blocking execution.
*/
export async function refreshWorkspaceRepoWorktreeBases(
  input: RefreshWorkspaceRepoWorktreeBasesInput,
): Promise<RefreshWorkspaceRepoWorktreeBasesResult> {
  const { task, workspaceRootDir, repoRelPaths, store, settings, audit, logger, runContext } = input;
  const results: Array<{ repoRelPath: string; result: WorktreeBaseRefreshResult }> = [];

  for (const repoRelPath of [...new Set(repoRelPaths)].sort()) {
    const entry = task.workspaceWorktrees?.[repoRelPath];
    if (!entry?.worktreePath || !existsSync(entry.worktreePath)) {
      logger?.debug?.(`${task.id}: workspace base refresh skipped for ${repoRelPath}; no live worktree entry`);
      continue;
    }

    if (await readPersistedWorktreeBackendKind(entry.worktreePath) === "worktrunk") {
      results.push({
        repoRelPath,
        result: {
          kind: "worktrunk-refresh-unsupported",
          executionSafe: true,
          skipped: true,
          durableBaseSha: entry.baseCommitSha ?? null,
        },
      });
      continue;
    }

    const repoRootDir = join(workspaceRootDir, repoRelPath);
    let baseResolution: Awaited<ReturnType<typeof resolveWorkspaceRepoBaseBranch>>;
    try {
      baseResolution = await resolveWorkspaceRepoBaseBranch({
        mode: "recorded",
        task: {},
        repoRootDir,
        repoRelPath,
        recordedBaseBranch: entry.baseBranch,
        settings,
        logger: logger ? { warn: logger.warn } : undefined,
      });
    } catch (error) {
      results.push({
        repoRelPath,
        result: {
          kind: "base-unresolvable",
          executionSafe: true,
          skipped: true,
          durableBaseSha: entry.baseCommitSha ?? null,
          detail: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }

    await recordWorkspaceBaseBranchDecision({
      store,
      audit,
      task,
      repoRelPath,
      repoAbsPath: repoRootDir,
      resolution: baseResolution,
      stage: "acquire",
      runContext,
    });

    const repoAudit = audit
      ? {
          git: async (event: Parameters<NonNullable<typeof audit.git>>[0]) => {
            await audit.git({
              ...event,
              metadata: { ...event.metadata, repoRelPath },
            });
          },
        }
      : undefined;
    const refreshSettings = settings.worktrunk?.enabled === true
      ? { ...settings, worktrunk: { ...settings.worktrunk, enabled: false } }
      : settings;
    const result = await refreshReusedWorktreeBase({
      task,
      rootDir: repoRootDir,
      worktreePath: entry.worktreePath,
      store,
      settings: refreshSettings,
      audit: repoAudit,
      logger,
      baseline: {
        baseRef: baseResolution.branch,
        durableBaseSha: entry.baseCommitSha,
        persist: async (baseCommitSha) => {
          await store.mergeWorkspaceWorktreeEntry(
            task.id,
            repoRelPath,
            { baseCommitSha },
            { requireExistingEntry: true },
          );
        },
      },
    });
    results.push({ repoRelPath, result });

    if (result.skipped) {
      await store.logEntry(
        task.id,
        `Workspace base refresh skipped [${repoRelPath}] (${result.kind}) — kept local base; the merge-time rebase will retry with conflict resolution`,
        result.detail,
        runContext,
      );
    }
    if (!result.executionSafe) throw new WorktreeBaseRefreshError(result);
  }

  return { task: await store.getTask(task.id), results };
}

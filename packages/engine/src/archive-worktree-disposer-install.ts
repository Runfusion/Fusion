import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {canonicalizeWorktreePath, getArchiveWorkspaceWorktreeDisposer, getArchiveWorktreeDisposer, registerArchiveWorkspaceWorktreeDisposer, registerArchiveWorktreeDisposer, type Settings, type TaskStore} from "@fusion/core";
import {removeWorktree, RemovalReason} from "./worktree-backend.js";

const execFileAsync = promisify(execFile);

/**
 * FNXC:WorkflowLifecycle 2026-07-16-10:00:
 * CLI/fn archive paths can own a store without constructing an executor. This
 * presence-guarded baseline uses the configured backend, while an executor may
 * replace it with its session-aware disposer for the same store.
 */
export function installBaselineArchiveWorktreeDisposer(store: TaskStore, input: {rootDir: string; getSettings: () => Promise<Partial<Settings>>}): () => void {
  const unregisterSingle = getArchiveWorktreeDisposer(store) ? () => {} : registerArchiveWorktreeDisposer(store, async (task) => {
    if (!task.worktree) return;
    if (await canonicalizeWorktreePath(task.worktree) === await canonicalizeWorktreePath(input.rootDir)) return;
    await removeWorktree({worktreePath: task.worktree, rootDir: input.rootDir, settings: await input.getSettings(), taskId: task.id, reason: RemovalReason.ExecutorDispose, force: true});
    task.worktree = undefined;
  });
  const unregisterWorkspace = getArchiveWorkspaceWorktreeDisposer(store) ? () => {} : registerArchiveWorkspaceWorktreeDisposer(store, async (task, plan) => {
    const removed: string[] = [];
    const failed: {repoRel: string; error: unknown}[] = [];
    for (const entry of plan) {
      try {
        if (await canonicalizeWorktreePath(entry.worktreePath) === await canonicalizeWorktreePath(entry.repoRootDir)) throw new Error("Refusing to remove workspace repository root");
        await removeWorktree({worktreePath: entry.worktreePath, rootDir: entry.repoRootDir, settings: await input.getSettings(), taskId: task.id, reason: RemovalReason.ExecutorDispose, force: true});
        /* FNXC:WorkflowLifecycle 2026-07-16-16:00: Archive metadata can contain valid Git refs with shell metacharacters. Pass the ref as an argv value so cleanup never evaluates it as shell code. */
        await execFileAsync("git", ["branch", "-D", entry.branch], {cwd: entry.repoRootDir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024});
        if (task.workspaceWorktrees) for (const repoRel of [entry.repoRel, ...entry.aliasRepoRels]) delete task.workspaceWorktrees[repoRel];
        removed.push(entry.repoRel);
      } catch (error) {
        failed.push({repoRel: entry.repoRel, error});
      }
    }
    return {removed, failed};
  });
  return () => { unregisterWorkspace(); unregisterSingle(); };
}

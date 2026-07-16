import {canonicalizeWorktreePath, getArchiveWorktreeDisposer, registerArchiveWorktreeDisposer, type Settings, type TaskStore} from "@fusion/core";
import {removeWorktree, RemovalReason} from "./worktree-backend.js";

/**
 * FNXC:WorkflowLifecycle 2026-07-16-10:00:
 * CLI/fn archive paths can own a store without constructing an executor. This
 * presence-guarded baseline uses the configured backend, while an executor may
 * replace it with its session-aware disposer for the same store.
 */
export function installBaselineArchiveWorktreeDisposer(store: TaskStore, input: {rootDir: string; getSettings: () => Promise<Partial<Settings>>}): () => void {
  if (getArchiveWorktreeDisposer(store)) return () => {};
  return registerArchiveWorktreeDisposer(store, async (task) => {
    if (!task.worktree) return;
    if (await canonicalizeWorktreePath(task.worktree) === await canonicalizeWorktreePath(input.rootDir)) return;
    await removeWorktree({worktreePath: task.worktree, rootDir: input.rootDir, settings: await input.getSettings(), taskId: task.id, reason: RemovalReason.ExecutorDispose, force: true});
    task.worktree = undefined;
  });
}

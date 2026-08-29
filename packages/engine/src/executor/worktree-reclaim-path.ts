/**
 * FNXC:CodeOrganization 2026-08-03-14:50:
 * normalizeReclaimableWorktreePath peeled from TaskExecutor (U4 Slice B).
 */
import type { Settings } from "@fusion/core";
import { relocateReclaimableWorktreeIntoRoot } from "../worktree/worktree-pool.js";
import { NonRetryableWorktreeError } from "./worktree-registry-helpers.js";

export type ReclaimPathDeps = {
  rootDir: string;
  store: {
    logEntry: (taskId: string, action: string, outcome?: string) => Promise<unknown>;
  };
  hasActiveWorktreeBinding: (taskId: string, path: string) => boolean;
  isLiveCleanupRefusal: (worktreePath: string, taskId: string) => Promise<boolean>;
};

export async function normalizeReclaimableWorktreePath(
  deps: ReclaimPathDeps,
  sourcePath: string,
  targetPath: string,
  taskId: string,
  settings: Partial<Settings>,
): Promise<string> {
  const isRelocationActive = async (path: string) =>
    deps.hasActiveWorktreeBinding(taskId, path)
    || await deps.isLiveCleanupRefusal(path, taskId);
  try {
    const placement = await relocateReclaimableWorktreeIntoRoot({
      rootDir: deps.rootDir,
      sourcePath,
      targetPath,
      taskId,
      settings,
      isPathActive: isRelocationActive,
    });
    if (placement.kind === "deferred-live") {
      await deps.store.logEntry(
        taskId,
        `[recovery] deferred relocation of active preserved worktree ${sourcePath}`,
        sourcePath,
      );
      return placement.path;
    }
    if (placement.relocated) {
      await deps.store.logEntry(
        taskId,
        `[recovery] relocated preserved worktree from ${sourcePath} to ${placement.path}`,
        placement.path,
      );
    }
    return placement.path;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await deps.store.logEntry(
      taskId,
      `[recovery] failed to relocate preserved worktree from ${sourcePath} to ${targetPath}: ${detail}`,
      sourcePath,
    );
    throw new NonRetryableWorktreeError(
      `Could not relocate preserved ${taskId} worktree into the configured worktrees directory: ${detail}`,
    );
  }
}

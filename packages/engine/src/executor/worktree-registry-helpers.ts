/**
 * FNXC:CodeOrganization 2026-08-03-14:05:
 * Worktree registry helpers peeled from TaskExecutor (U4 Slice B).
 * Take rootDir/store as injected deps instead of TaskExecutor instance state.
 */
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  getRegisteredWorktreePaths,
  isRegisteredGitWorktree,
} from "../worktree/worktree-pool.js";

const execAsync = promisify(exec);

/** Failures that should not be retried by the worktree creation loop. */
export class NonRetryableWorktreeError extends Error {}

/** Check if a path is registered as a git worktree under rootDir. */
export async function isRegisteredWorktree(rootDir: string, path: string): Promise<boolean> {
  return isRegisteredGitWorktree(rootDir, path);
}

/**
 * Throw if `path` lies inside an existing registered worktree other than the
 * repo root. The repo root itself is a worktree (main branch) and must be
 * allowed — we only reject paths strictly *inside* a non-root worktree.
 */
export async function assertWorktreePathNotNested(
  rootDir: string,
  store: { logEntry: (taskId: string, action: string, outcome?: string) => Promise<unknown> },
  path: string,
  taskId: string,
): Promise<void> {
  const target = resolvePath(path);
  const rootResolved = resolvePath(rootDir);
  const registered = await getRegisteredWorktreePaths(rootDir);

  for (const wt of registered) {
    if (wt === rootResolved) continue; // root is allowed as ancestor
    if (wt === target) continue; // exact match handled later as "already registered"
    const rel = relative(wt, target);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      await store.logEntry(
        taskId,
        `Refusing to create nested worktree`,
        `target ${target} is inside registered worktree ${wt}`,
      );
      throw new NonRetryableWorktreeError(
        `Refusing to create worktree at ${target}: path is nested inside existing worktree ${wt}. ` +
        `This usually means the executor was launched with rootDir pointing at a worktree instead of the main repo.`,
      );
    }
  }
}

/** Parse `git worktree list --porcelain` into branch → worktree path map. */
export async function getWorktreeBranchMap(rootDir: string): Promise<Map<string, string>> {
  const { stdout } = await execAsync("git worktree list --porcelain", { cwd: rootDir, encoding: "utf-8" });
  const map = new Map<string, string>();
  let currentWorktree: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentWorktree = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch refs/heads/") && currentWorktree) {
      map.set(line.slice("branch refs/heads/".length).trim(), currentWorktree);
    } else if (!line.trim()) {
      currentWorktree = null;
    }
  }
  return map;
}

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Column, TaskStore } from "@fusion/core";
import { worktreePoolLog } from "./logger.js";

/**
 * A pool of idle git worktrees that can be recycled across tasks.
 *
 * When `recycleWorktrees` is enabled, completed task worktrees are returned
 * to this pool instead of being deleted. New tasks acquire a warm worktree
 * from the pool, preserving build caches (node_modules, target/, dist/).
 *
 * The pool only tracks *idle* worktrees — those not currently assigned to
 * any active task. The scheduler's `maxWorktrees` setting still governs
 * the total number of worktrees (active + idle).
 *
 * **Lifecycle across restarts:** The pool is in-memory only, but on engine
 * startup it can be rehydrated from disk state via {@link rehydrate} and
 * {@link scanIdleWorktrees}. When `recycleWorktrees` is true, the startup
 * sequence scans the `.worktrees/` directory, identifies idle worktrees
 * (those not assigned to any active task), and bulk-loads them into the
 * pool. When `recycleWorktrees` is false, orphaned worktrees are cleaned
 * up via {@link cleanupOrphanedWorktrees}.
 */
export class WorktreePool {
  private idle = new Set<string>();

  /**
   * Acquire an idle worktree from the pool.
   *
   * Returns the absolute path of an idle worktree, or `null` if the pool
   * is empty. Before returning, verifies the directory still exists on disk
   * and prunes any stale entries.
   */
  acquire(): string | null {
    for (const path of this.idle) {
      this.idle.delete(path);
      if (existsSync(path)) {
        return path;
      }
      worktreePoolLog.log(`Pruned stale entry: ${path}`);
    }
    return null;
  }

  /**
   * Return a worktree to the idle pool after a task completes.
   *
   * The worktree directory is retained on disk with its build caches intact.
   * Call this instead of `git worktree remove` when recycling is enabled.
   *
   * @param worktreePath — Absolute path to the worktree directory
   */
  release(worktreePath: string): void {
    this.idle.add(worktreePath);
  }

  /** Number of idle worktrees currently in the pool. */
  get size(): number {
    return this.idle.size;
  }

  /** Check whether a specific path is in the idle pool. */
  has(path: string): boolean {
    return this.idle.has(path);
  }

  /**
   * Remove and return all idle worktree paths.
   *
   * Useful for shutdown/cleanup — the caller is responsible for
   * running `git worktree remove` on each returned path.
   */
  drain(): string[] {
    const paths = Array.from(this.idle);
    this.idle.clear();
    return paths;
  }

  /**
   * Bulk-load known idle worktree paths into the pool.
   *
   * Called at engine startup to restore the pool from disk state.
   * Paths that no longer exist on disk are silently skipped.
   *
   * @param idlePaths — Absolute paths to idle worktree directories
   */
  rehydrate(idlePaths: string[]): void {
    for (const path of idlePaths) {
      if (existsSync(path)) {
        this.idle.add(path);
      } else {
        worktreePoolLog.log(`Rehydrate skipped (not on disk): ${path}`);
      }
    }
  }

  /**
   * Prepare a recycled worktree for a new task.
   *
   * Resets the working tree to a clean state, then creates (or force-resets)
   * the task's branch based on the given start point (or `main` by default).
   * This ensures the new task starts from the correct base with a clean
   * working directory, while preserving untracked build caches
   * (node_modules, target/, dist/).
   *
   * Steps performed:
   * 1. `git checkout -- .` — discard tracked file modifications
   * 2. `git clean -fd` — remove untracked files (but not .gitignore'd caches)
   * 3. `git checkout --detach <startPoint>` — move HEAD to the latest base commit
   * 4. `git checkout -B <branchName> <startPoint>` — create/reset branch from start point
   *
   * Returns the actual branch name used. This may differ from `branchName`
   * when conflict recovery generates a suffixed name (e.g., `fusion/fn-042-2`).
   *
   * @param worktreePath — Absolute path to the recycled worktree
   * @param branchName — Branch name for the new task (e.g., `fusion/fn-042`)
   * @param startPoint — Git ref to branch from (e.g., `fusion/fn-041`). Defaults to `main`.
   * @returns The actual branch name checked out in the worktree
   */
  prepareForTask(worktreePath: string, branchName: string, startPoint?: string): string {
    // Clean tracked modifications
    try {
      execSync("git checkout -- .", { cwd: worktreePath, stdio: "pipe" });
    } catch {
      // May fail if worktree is already clean — that's fine
    }

    // Remove untracked files (but not .gitignore'd build caches)
    execSync("git clean -fd", { cwd: worktreePath, stdio: "pipe" });

    const base = startPoint || "main";
    execSync(`git checkout --detach ${base}`, {
      cwd: worktreePath,
      stdio: "pipe",
    });

    // Create or force-reset the branch from the start point (or main)
    const checkoutCmd = `git checkout -B "${branchName}" ${base}`;
    try {
      execSync(checkoutCmd, {
        cwd: worktreePath,
        stdio: "pipe",
      });
      return branchName;
    } catch (err: any) {
      const stderr = err?.stderr?.toString() ?? err?.message ?? "";
      const match = stderr.match(/already used by worktree at '([^']+)'/);
      if (!match) {
        throw err;
      }

      // The branch is checked out in a different worktree.
      // First check if the conflicting worktree still exists on disk.
      const conflictingPath = match[1];
      if (!existsSync(conflictingPath)) {
        // Conflicting worktree no longer exists — prune and retry with original name
        execSync("git worktree prune", { cwd: worktreePath, stdio: "pipe" });
        execSync(checkoutCmd, { cwd: worktreePath, stdio: "pipe" });
        return branchName;
      }

      // Conflicting worktree exists and is active — use a suffixed branch name
      // to avoid disrupting the other worktree
      for (let suffix = 2; suffix <= 6; suffix++) {
        const suffixedName = `${branchName}-${suffix}`;
        const suffixedCmd = `git checkout -B "${suffixedName}" ${base}`;
        try {
          execSync(suffixedCmd, { cwd: worktreePath, stdio: "pipe" });
          return suffixedName;
        } catch (suffixErr: any) {
          const suffixStderr = suffixErr?.stderr?.toString() ?? "";
          if (!suffixStderr.includes("already used by worktree")) {
            throw suffixErr;
          }
          // This suffixed name is also in use — try the next one
        }
      }

      // All suffixed names exhausted — should not happen in practice
      throw new Error(
        `Cannot create branch for task: "${branchName}" and suffixes -2 through -6 are all in use by other worktrees`,
      );
    }
  }
}

/**
 * Scan the `.worktrees/` directory to find idle worktrees that can be
 * loaded into the pool on startup.
 *
 * A worktree is considered "idle" if it exists on disk under
 * `<rootDir>/.worktrees/` but is NOT assigned (via `task.worktree`) to
 * any non-done task.
 *
 * @param rootDir — Project root directory (parent of `.worktrees/`)
 * @param store — Task store for listing tasks and their worktree assignments
 * @returns Absolute paths of idle worktree directories
 */
export async function scanIdleWorktrees(rootDir: string, store: TaskStore): Promise<string[]> {
  const worktreesDir = join(rootDir, ".worktrees");

  if (!existsSync(worktreesDir)) {
    return [];
  }

  // List all subdirectories under .worktrees/
  let dirs: string[];
  try {
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => join(worktreesDir, e.name));
  } catch {
    return [];
  }

  if (dirs.length === 0) {
    return [];
  }

  // Find worktree paths assigned to non-done tasks (active worktrees)
  const tasks = await store.listTasks();
  const activeWorktrees = new Set<string>();
  for (const task of tasks) {
    if (task.worktree && task.column !== "done") {
      activeWorktrees.add(task.worktree);
    }
  }

  // Return worktrees on disk that are NOT active
  return dirs.filter((dir) => !activeWorktrees.has(dir));
}

/**
 * Clean up orphaned worktrees left behind from previous engine runs.
 *
 * Removes worktree directories under `<rootDir>/.worktrees/` that are NOT
 * assigned to any non-done task. Used on startup when `recycleWorktrees`
 * is false to avoid disk waste.
 *
 * Failures on individual worktree removals are logged but not fatal.
 *
 * @param rootDir — Project root directory (parent of `.worktrees/`)
 * @param store — Task store for listing tasks and their worktree assignments
 * @returns Number of worktrees cleaned up
 */
export async function cleanupOrphanedWorktrees(rootDir: string, store: TaskStore): Promise<number> {
  const orphaned = await scanIdleWorktrees(rootDir, store);
  let cleaned = 0;

  for (const worktreePath of orphaned) {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: rootDir,
        stdio: "pipe",
      });
      worktreePoolLog.log(`Cleaned up orphaned worktree: ${worktreePath}`);
      cleaned++;
    } catch (err: any) {
      worktreePoolLog.log(`Failed to remove orphaned worktree ${worktreePath}: ${err.message}`);
    }
  }

  return cleaned;
}

/** Columns where the merger handles branch cleanup — skip these during orphan scanning. */
const MERGER_MANAGED_COLUMNS: ReadonlySet<Column> = new Set(["in-review", "done"]);

/**
 * Scan for orphaned `fusion/*` branches that are not associated with any
 * non-archived, non-merger-managed task.
 *
 * Lists all local branches matching the `fusion/*` pattern, then compares
 * against branches stored on tasks (via `task.branch` or derived as
 * `fusion/${taskId.toLowerCase()}`). Branches belonging to tasks in the
 * `in-review` or `done` columns are excluded because the merger is
 * responsible for cleaning those up.
 *
 * @param rootDir — Project root directory (git working tree)
 * @param store — Task store for listing tasks and their branch assignments
 * @returns Array of orphaned branch names
 */
export async function scanOrphanedBranches(rootDir: string, store: TaskStore): Promise<string[]> {
  // List all local branches matching fusion/*
  let allBranches: string[];
  try {
    const output = execSync("git branch --list 'fusion/*'", {
      cwd: rootDir,
      stdio: "pipe",
      encoding: "utf-8",
    });
    allBranches = output
      .split("\n")
      .map((line) => line.trim().replace(/^\*?\s*/, ""))
      .filter((line) => line.startsWith("fusion/"));
  } catch {
    return [];
  }

  if (allBranches.length === 0) return [];

  // Build set of branches associated with active (non-archived, non-merger-managed) tasks
  const tasks = await store.listTasks();
  const activeBranches = new Set<string>();
  for (const task of tasks) {
    // Skip tasks in columns where the merger handles branch cleanup
    if (MERGER_MANAGED_COLUMNS.has(task.column)) continue;
    // Also skip archived tasks
    if (task.column === "archived") continue;

    // Use stored branch name if available, otherwise derive from task ID
    if (task.branch) {
      activeBranches.add(task.branch);
    }
    // Always add the derived name too — the task may not have `branch` set yet
    activeBranches.add(`fusion/${task.id.toLowerCase()}`);
  }

  // Return branches not associated with any active task
  return allBranches.filter((branch) => !activeBranches.has(branch));
}

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { Column, TaskStore } from "@fusion/core";
import { worktreePoolLog } from "./logger.js";

const execAsync = promisify(exec);

export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --git-dir", {
      cwd: dir,
      encoding: "utf-8",
    });
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    worktreePoolLog.log(`isGitRepository check failed for ${dir}: ${errorMessage}`);
    return false;
  }
}

export async function getRegisteredWorktreePaths(rootDir: string): Promise<Set<string>> {
  try {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: rootDir,
      encoding: "utf-8",
    });

    const paths = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.add(resolve(line.slice("worktree ".length)));
      }
    }
    return paths;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    worktreePoolLog.warn(`Failed to list registered worktrees: ${errorMessage}`);
    return new Set();
  }
}

export async function isRegisteredGitWorktree(rootDir: string, worktreePath: string): Promise<boolean> {
  return (await getRegisteredWorktreePaths(rootDir)).has(resolve(worktreePath));
}

export function hasRequiredWorktreeFiles(worktreePath: string): boolean {
  return existsSync(join(worktreePath, ".git")) && existsSync(join(worktreePath, "package.json"));
}

export async function isUsableTaskWorktree(rootDir: string, worktreePath: string): Promise<boolean> {
  return existsSync(worktreePath) &&
    await isRegisteredGitWorktree(rootDir, worktreePath) &&
    hasRequiredWorktreeFiles(worktreePath);
}

function isInsideWorktreesDir(rootDir: string, worktreePath: string): boolean {
  const worktreesDir = resolve(rootDir, ".worktrees");
  const target = resolve(worktreePath);
  const rel = relative(worktreesDir, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

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
  async prepareForTask(worktreePath: string, branchName: string, startPoint?: string): Promise<string> {
    // Clean tracked modifications
    try {
      await execAsync("git checkout -- .", { cwd: worktreePath });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreePoolLog.log(`git checkout -- . failed (may be clean): ${errorMessage}`);
      // May fail if worktree is already clean — that's fine
    }

    // Remove untracked files (but not .gitignore'd build caches)
    await execAsync("git clean -fd", { cwd: worktreePath });

    const base = startPoint || "main";
    await execAsync(`git checkout --detach ${base}`, {
      cwd: worktreePath,
    });

    // Create or force-reset the branch from the start point (or main)
    const checkoutCmd = `git checkout -B "${branchName}" ${base}`;
    try {
      await execAsync(checkoutCmd, {
        cwd: worktreePath,
      });
      return branchName;
    } catch (err: unknown) {
      const execError = err instanceof Error ? err : new Error(String(err));
      const stderr = "stderr" in execError && typeof execError.stderr === "string"
        ? execError.stderr.toString()
        : execError.message;
      const match = stderr.match(/already used by worktree at '([^']+)'/);
      if (!match) {
        throw err;
      }

      // The branch is checked out in a different worktree.
      // First check if the conflicting worktree still exists on disk.
      const conflictingPath = match[1];
      if (!existsSync(conflictingPath)) {
        // Conflicting worktree no longer exists — prune and retry with original name
        await execAsync("git worktree prune", { cwd: worktreePath });
        await execAsync(checkoutCmd, { cwd: worktreePath });
        return branchName;
      }

      // Conflicting worktree exists and is active — use a suffixed branch name
      // to avoid disrupting the other worktree
      for (let suffix = 2; suffix <= 6; suffix++) {
        const suffixedName = `${branchName}-${suffix}`;
        const suffixedCmd = `git checkout -B "${suffixedName}" ${base}`;
        try {
          await execAsync(suffixedCmd, { cwd: worktreePath });
          return suffixedName;
        } catch (suffixErr: unknown) {
          const suffixExecError = suffixErr instanceof Error ? suffixErr : new Error(String(suffixErr));
          const suffixStderr = "stderr" in suffixExecError && typeof suffixExecError.stderr === "string"
            ? suffixExecError.stderr.toString()
            : "";
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
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    worktreePoolLog.warn(`Failed to read .worktrees/ directory: ${errorMessage}`);
    return [];
  }

  if (dirs.length === 0) {
    return [];
  }

  const registeredWorktrees = await getRegisteredWorktreePaths(rootDir);
  const registeredDirs = dirs.filter((dir) => registeredWorktrees.has(resolve(dir)));

  // Find worktree paths assigned to non-done tasks (active worktrees)
  const tasks = await store.listTasks({ slim: true, includeArchived: false });
  const activeWorktrees = new Set<string>();
  for (const task of tasks) {
    if (task.worktree && task.column !== "done" && registeredWorktrees.has(resolve(task.worktree))) {
      activeWorktrees.add(resolve(task.worktree));
    } else if (task.worktree && task.column !== "done") {
      worktreePoolLog.log(`Ignoring task ${task.id} worktree metadata because it is not a registered git worktree: ${task.worktree}`);
    }
  }

  // Return registered worktrees on disk that are NOT active. Unregistered
  // directories are intentionally excluded here so recycle mode never adds a
  // broken directory to the warm pool; cleanup handles those separately.
  return registeredDirs.filter((dir) => !activeWorktrees.has(resolve(dir)));
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
  const worktreesDir = join(rootDir, ".worktrees");
  if (!existsSync(worktreesDir)) {
    return 0;
  }

  const orphaned = await scanIdleWorktrees(rootDir, store);
  const registeredWorktrees = await getRegisteredWorktreePaths(rootDir);

  let dirs: string[] = [];
  if (existsSync(worktreesDir)) {
    try {
      dirs = readdirSync(worktreesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(worktreesDir, e.name));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreePoolLog.warn(`Failed to read .worktrees/ directory for cleanup: ${errorMessage}`);
      dirs = [];
    }
  }

  const unregistered = dirs.filter((dir) => !registeredWorktrees.has(resolve(dir)));
  const candidates = [...orphaned, ...unregistered];
  let cleaned = 0;

  for (const worktreePath of candidates) {
    try {
      if (registeredWorktrees.has(resolve(worktreePath))) {
        await execAsync(`git worktree remove "${worktreePath}" --force`, {
          cwd: rootDir,
        });
      } else {
        if (!isInsideWorktreesDir(rootDir, worktreePath)) {
          throw new Error(`Refusing to remove path outside .worktrees: ${worktreePath}`);
        }
        rmSync(worktreePath, { recursive: true, force: true });
      }
      worktreePoolLog.log(`Cleaned up orphaned worktree: ${worktreePath}`);
      cleaned++;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreePoolLog.log(`Failed to remove orphaned worktree ${worktreePath}: ${errorMessage}`);
    }
  }

  return cleaned;
}

/**
 * Remove "half-initialized" worktree directories — directories that exist under
 * `<projectRoot>/.worktrees/` on disk but were never fully registered with git
 * (i.e., `git worktree add` never completed successfully for them).
 *
 * This is the housekeeping path; it runs once at engine startup and is safe to
 * call repeatedly.  The hot path (`assertValidWorktreeSession`) is deliberately
 * left untouched.
 *
 * Safety invariants enforced before any removal:
 * - Only removes direct children of `<projectRoot>/.worktrees/` — never the
 *   project root itself, a parent, or an arbitrary path.
 * - Skips symlinks (only removes real directories).
 * - Never removes a directory that is a registered git worktree.
 * - Never removes a directory that has a valid `.git` file pointing to an
 *   existing gitdir (belt-and-suspenders: git would list it anyway, but guards
 *   against stale porcelain output on broken repos).
 *
 * @param projectRoot - Absolute path to the project root (parent of `.worktrees/`)
 * @returns Number of orphan directories removed
 */
export async function reapOrphanWorktrees(projectRoot: string): Promise<number> {
  const worktreesDir = join(projectRoot, ".worktrees");

  if (!existsSync(worktreesDir)) {
    return 0;
  }

  // List direct children of .worktrees/
  let entries: { name: string; fullPath: string }[];
  try {
    entries = readdirSync(worktreesDir, { withFileTypes: true })
      .filter((e) => {
        // Only real directories — never symlinks
        if (!e.isDirectory()) return false;
        try {
          return lstatSync(join(worktreesDir, e.name)).isDirectory() && !lstatSync(join(worktreesDir, e.name)).isSymbolicLink();
        } catch {
          return false;
        }
      })
      .map((e) => ({ name: e.name, fullPath: join(worktreesDir, e.name) }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    worktreePoolLog.warn(`reapOrphanWorktrees: failed to read .worktrees/ — ${msg}`);
    return 0;
  }

  if (entries.length === 0) return 0;

  // Get the set of paths registered with git
  const registered = await getRegisteredWorktreePaths(projectRoot);

  let removed = 0;
  for (const { name, fullPath } of entries) {
    const resolvedFull = resolve(fullPath);

    // Safety: only operate on paths directly under .worktrees/
    const rel = relative(resolve(worktreesDir), resolvedFull);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      worktreePoolLog.warn(`reapOrphanWorktrees: skipping out-of-bounds path ${fullPath}`);
      continue;
    }

    // Skip registered worktrees — those are managed by the normal lifecycle
    if (registered.has(resolvedFull)) {
      continue;
    }

    // Belt-and-suspenders: skip if a .git file exists AND points to an existing gitdir.
    // This guards against races where git registered the worktree between our list
    // call and now, or against a broken repo whose porcelain is unreliable.
    const dotGit = join(resolvedFull, ".git");
    if (existsSync(dotGit)) {
      // If there's a .git file/dir, don't touch it — assertValidWorktreeSession
      // will handle it on the next agent start.
      worktreePoolLog.log(`reapOrphanWorktrees: skipping ${name} (has .git entry but not in registered list — may be partially registered)`);
      continue;
    }

    // This directory is on disk but has no .git entry and is not a registered
    // worktree — it is a half-initialized orphan.  Remove it.
    try {
      rmSync(resolvedFull, { recursive: true, force: true });
      worktreePoolLog.log(`reapOrphanWorktrees: removed half-initialized orphan ${name}`);
      removed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      worktreePoolLog.warn(`reapOrphanWorktrees: failed to remove ${name} — ${msg}`);
    }
  }

  return removed;
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
    const { stdout } = await execAsync("git branch --list 'fusion/*'", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    allBranches = stdout
      .split("\n")
      .map((line) => line.trim().replace(/^\*?\s*/, ""))
      .filter((line) => line.startsWith("fusion/"));
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    worktreePoolLog.warn(`Failed to list fusion/* branches: ${errorMessage}`);
    return [];
  }

  if (allBranches.length === 0) return [];

  // Build set of branches associated with active (non-archived, non-merger-managed) tasks
  const tasks = await store.listTasks({ slim: true, includeArchived: false });
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

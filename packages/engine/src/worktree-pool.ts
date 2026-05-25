import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import type { Column, SecretsStore, Settings, TaskStore, WorktrunkSettings } from "@fusion/core";
import { assertCleanBranchAtBase, inspectBranchConflict } from "./branch-conflicts.js";
import { worktreePoolLog } from "./logger.js";
import { isInsideConfiguredWorktreesDir, resolveWorktreesDir } from "./worktree-paths.js";
import { canonicalFusionBranchName } from "./worktree-names.js";
import {
  resolveWorktrunkBinary,
} from "./worktrunk-installer.js";
import {
  RemovalReason,
  removeWorktree as removeWorktreeViaBackend,
  resolveWorktreeBackend as resolveWorktreeBackendViaSettings,
} from "./worktree-backend.js";
import { cleanupSecretsEnvFile } from "./secrets-env-writer.js";
import { removeDesktopBuildArtifacts } from "./worktree-desktop-artifacts.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import type { RunAuditor } from "./run-audit.js";
import { pruneWorktreeAdminEntries } from "./worktree-prune.js";

export {
  NativeWorktreeBackend,
  WorktrunkOperationError,
  WorktrunkWorktreeBackend,
  removeWorktree,
  resolveWorktreeBackend,
} from "./worktree-backend.js";
export type { WorktreeBackend, WorktreeBackendKind } from "./worktree-backend.js";
export { RemovalReason } from "./worktree-backend.js";

// Re-export worktrunk installer types for convenience.
export {
  resolveWorktrunkBinary as resolveWorktrunkBinaryOriginal,
  WorktrunkBinaryUnavailableError,
  WorktrunkInstallDeniedError,
  WorktrunkInstallFailedError,
} from "./worktrunk-installer.js";

const execAsync = promisify(exec);

// ── Worktrunk binary lazy resolver ─────────────────────────────────────────────
// Memoizes per (homedir, settings.binaryPath) so the resolution+install flow
// runs at most once per unique settings combination per process.
const _worktrunkBinaryCache = new Map<string, { binaryPath: string; resolvedAt: number }>();

export async function getWorktrunkBinary(
  settings: WorktrunkSettings,
): Promise<{
  binaryPath: string;
  source: "override" | "path" | "cached" | "installed-release" | "installed-cargo";
}> {
  const cacheKey = `${process.env.HOME ?? ""}::${settings.binaryPath ?? ""}`;
  const cached = _worktrunkBinaryCache.get(cacheKey);
  if (cached) {
    return { binaryPath: cached.binaryPath, source: "cached" };
  }
  const result = await resolveWorktrunkBinary({ settings });
  _worktrunkBinaryCache.set(cacheKey, { binaryPath: result.binaryPath, resolvedAt: Date.now() });
  return result;
}

export function clearWorktrunkBinaryCache(): void {
  _worktrunkBinaryCache.clear();
}

export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function getExecStdout(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "stdout" in result) {
    const stdout = (result as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : String(stdout ?? "");
  }
  return "";
}

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

export async function describeRegisteredWorktrees(rootDir: string): Promise<{ rawOutput: string; canonicalized: string[] }> {
  try {
    const result = await execAsync("git worktree list --porcelain", {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const stdout = getExecStdout(result);

    const canonicalized: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        canonicalized.push(canonicalizePath(line.slice("worktree ".length)));
      }
    }

    return { rawOutput: stdout, canonicalized };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    worktreePoolLog.warn(`[worktree-pool] Failed to list registered worktrees: ${errorMessage}`);
    return { rawOutput: "", canonicalized: [] };
  }
}

export async function getRegisteredWorktreePaths(rootDir: string): Promise<Set<string>> {
  const { canonicalized } = await describeRegisteredWorktrees(rootDir);
  return new Set(canonicalized);
}

export async function getRegisteredWorktreeBranchMap(rootDir: string): Promise<Map<string, string>> {
  const branchMap = new Map<string, string>();
  for (const entry of await getRegisteredWorktreeBranches(rootDir)) {
    branchMap.set(entry.branch, entry.worktreePath);
  }
  return branchMap;
}

/**
 * Same source as `getRegisteredWorktreeBranchMap` but returns ALL
 * (branch, worktreePath) pairs rather than collapsing duplicates by branch.
 * Multiple worktrees can legitimately share a branch when the user has
 * created secondary checkouts via `git worktree add --force -b <branch>`;
 * callers that need to act on every such worktree (e.g. the merger's
 * post-advance auto-sync) must use this array form to avoid silently
 * skipping all but the last-iterated checkout.
 */
export async function getRegisteredWorktreeBranches(rootDir: string): Promise<Array<{ branch: string; worktreePath: string }>> {
  const { rawOutput } = await describeRegisteredWorktrees(rootDir);
  const entries: Array<{ branch: string; worktreePath: string }> = [];
  let currentWorktree: string | null = null;

  for (const line of rawOutput.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentWorktree = canonicalizePath(line.slice("worktree ".length));
      continue;
    }

    if (line.startsWith("branch ") && currentWorktree) {
      const branchRef = line.slice("branch ".length).trim();
      const branchName = branchRef.startsWith("refs/heads/")
        ? branchRef.slice("refs/heads/".length)
        : branchRef;
      if (branchName) {
        entries.push({ branch: branchName, worktreePath: currentWorktree });
      }
    }
  }

  return entries;
}

export async function isRegisteredGitWorktree(rootDir: string, worktreePath: string): Promise<boolean> {
  return (await getRegisteredWorktreePaths(rootDir)).has(canonicalizePath(worktreePath));
}

export function hasRequiredWorktreeFiles(worktreePath: string): boolean {
  return existsSync(join(worktreePath, ".git"));
}

export async function isInsideGitWorkTree(worktreePath: string): Promise<boolean> {
  try {
    const result = await execAsync("git rev-parse --is-inside-work-tree", {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    return getExecStdout(result).trim() === "true";
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    worktreePoolLog.log(`isInsideGitWorkTree check failed for ${worktreePath}: ${errorMessage}`);
    return false;
  }
}

export type TaskWorktreeClassification = "missing" | "incomplete" | "unregistered" | "outside-work-tree";

export type TaskWorktreeClassificationResult =
  | { ok: true }
  | { ok: false; classification: TaskWorktreeClassification; reason: string };

/**
 * Language-agnostic liveness/classification gate for task worktrees.
 */
export async function classifyTaskWorktree(rootDir: string, worktreePath: string): Promise<TaskWorktreeClassificationResult> {
  if (!existsSync(worktreePath)) {
    return { ok: false, classification: "missing", reason: "worktree directory does not exist" };
  }
  if (!hasRequiredWorktreeFiles(worktreePath)) {
    return { ok: false, classification: "incomplete", reason: "missing .git metadata" };
  }
  if (!await isRegisteredGitWorktree(rootDir, worktreePath)) {
    return { ok: false, classification: "unregistered", reason: "not registered in git worktree list" };
  }
  if (!await isInsideGitWorkTree(worktreePath)) {
    return { ok: false, classification: "outside-work-tree", reason: "git rev-parse --is-inside-work-tree returned false" };
  }
  return { ok: true };
}

/**
 * Language-agnostic liveness gate for task worktrees.
 */
export async function isUsableTaskWorktree(rootDir: string, worktreePath: string): Promise<boolean> {
  const result = await classifyTaskWorktree(rootDir, worktreePath);
  return result.ok;
}

export function isInsideWorktreesDir(
  rootDir: string,
  worktreePath: string,
  settings?: Pick<Settings, "worktreesDir">,
): boolean {
  return isInsideConfiguredWorktreesDir(rootDir, settings, worktreePath);
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
function deriveTaskIdFromBranch(branchName: string): string {
  const match = branchName.match(/^fusion\/(fn-\d+)(?:-\d+)?$/i);
  return match ? match[1].toUpperCase() : branchName.toUpperCase();
}

export type PrepareForTaskResult = {
  branch: string;
  worktreePath: string;
  reclaimed: boolean;
  existingTipSha?: string;
  strandedCommitCount?: number;
};

export type PoolInvariantPhase = "acquire" | "rehydrate" | "release";

export type PoolInvariantViolation = {
  path: string;
  existingHolder: string;
  requestingTaskId: string;
  phase: PoolInvariantPhase;
};

export class PoolDoubleLeaseError extends Error {
  constructor(
    public readonly path: string,
    public readonly existingHolder: string,
    public readonly requestingTaskId: string,
    public readonly phase: PoolInvariantPhase,
  ) {
    super(`Pool double lease detected for ${path}: held by ${existingHolder}, requested by ${requestingTaskId} during ${phase}`);
    this.name = "PoolDoubleLeaseError";
  }
}

export interface WorktreePoolOptions {
  auditFactory?: (taskId: string) => Pick<RunAuditor, "filesystem">;
  secretsStore?: Pick<SecretsStore, "listEnvExportable">;
}

export class WorktreePool {
  private idle = new Set<string>();
  private leased = new Map<string, string>();
  private invariantViolationHandler?: (violation: PoolInvariantViolation) => void;

  constructor(_options: WorktreePoolOptions = {}) {}

  /**
   * Acquire an idle worktree from the pool.
   *
   * Returns the absolute path of an idle worktree, or `null` if the pool
   * is empty. Before returning, verifies the directory still exists on disk
   * and prunes any stale entries.
   */
  acquire(taskId: string): string | null {
    for (const path of this.idle) {
      this.assertNotDoubleLeased(path, taskId, "acquire");
      this.idle.delete(path);
      this.leased.set(path, taskId);
      if (existsSync(path)) {
        return path;
      }
      this.leased.delete(path);
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
  release(worktreePath: string, releasingTaskId?: string): void {
    const existingHolder = this.leased.get(worktreePath);
    if (!existingHolder) {
      worktreePoolLog.warn(`release called for non-leased worktree: ${worktreePath}`);
    } else if (releasingTaskId && existingHolder !== releasingTaskId) {
      this.notifyInvariantViolation({
        path: worktreePath,
        existingHolder,
        requestingTaskId: releasingTaskId,
        phase: "release",
      });
      worktreePoolLog.warn(
        `release task mismatch for ${worktreePath}: leased holder=${existingHolder}, releasingTaskId=${releasingTaskId}`,
      );
    }
    this.leased.delete(worktreePath);
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

  setInvariantViolationHandler(handler: (violation: PoolInvariantViolation) => void): void {
    this.invariantViolationHandler = handler;
  }

  /** @internal test-only visibility */
  getLeasedPaths(): ReadonlyMap<string, string> {
    return this.leased;
  }

  private notifyInvariantViolation(violation: PoolInvariantViolation): void {
    try {
      this.invariantViolationHandler?.(violation);
    } catch (error) {
      worktreePoolLog.warn(`Invariant violation handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private assertNotDoubleLeased(path: string, requestingTaskId: string, phase: PoolInvariantPhase): void {
    const existingHolder = this.leased.get(path);
    if (!existingHolder || existingHolder === requestingTaskId) {
      return;
    }
    const violation: PoolInvariantViolation = { path, existingHolder, requestingTaskId, phase };
    this.notifyInvariantViolation(violation);
    throw new PoolDoubleLeaseError(path, existingHolder, requestingTaskId, phase);
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
    this.leased.clear();
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
      if (!existsSync(path)) {
        worktreePoolLog.log(`Rehydrate skipped (not on disk): ${path}`);
        continue;
      }
      const existingHolder = this.leased.get(path);
      if (existingHolder) {
        this.notifyInvariantViolation({
          path,
          existingHolder,
          requestingTaskId: existingHolder,
          phase: "rehydrate",
        });
        worktreePoolLog.warn(`Rehydrate skipped leased worktree ${path} (holder=${existingHolder})`);
        continue;
      }
      this.idle.add(path);
    }
  }

  /**
   * Prepare a recycled worktree for a new task.
   *
   * Resets the working tree to a clean state, then creates (or force-resets)
   * the task's branch based on the given start point (or `main` by default).
   * This ensures the new task starts from the correct base with a clean
   * working directory, while preserving untracked build caches
   * (node_modules, target/, dist/). As an explicit carve-out, this
   * preparation removes `packages/desktop/dist` and
   * `packages/desktop/dist-electron`.
   *
   * Steps performed:
   * 1. `git checkout -- .` — discard tracked file modifications
   * 2. `git clean -fd` — remove untracked files (but not .gitignore'd caches)
   * 3. Remove `packages/desktop/dist` + `packages/desktop/dist-electron` if present
   * 4. `git checkout --detach <startPoint>` — move HEAD to the latest base commit
   * 5. `git checkout -B <branchName> <startPoint>` — create/reset branch from start point
   *
   * Returns the actual branch name used. This may differ from `branchName`
   * when legacy conflict recovery is explicitly enabled and generates a suffixed
   * name (e.g., `fusion/fn-042-2`).
   *
   * @param worktreePath — Absolute path to the recycled worktree
   * @param branchName — Branch name for the new task (e.g., `fusion/fn-042`)
   * @param startPoint — Git ref to branch from (e.g., `fusion/fn-041`). Defaults to `main`.
   * @returns The actual branch name checked out in the worktree
   */
  async prepareForTask(
    worktreePath: string,
    branchName: string,
    startPoint?: string,
    options?: { allowSiblingBranchRename?: boolean; repoDir?: string; requestingTaskId?: string },
  ): Promise<PrepareForTaskResult> {
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
    await removeDesktopBuildArtifacts(worktreePath, worktreePoolLog);

    const base = startPoint || await resolveIntegrationBranch(options?.repoDir ?? worktreePath, undefined);
    // Reject base values that would cause the new branch to inherit the
    // worktree's current HEAD instead of the intended start point. Historical
    // contamination ("branch: Created from HEAD") landed FN-5472's tip on
    // freshly-created fn-5432/fn-5255 branches because the recycled worktree
    // was still pointing at the previous occupant's commit and base silently
    // collapsed onto HEAD.
    const trimmedBase = base?.trim() ?? "";
    if (!trimmedBase || trimmedBase.toUpperCase() === "HEAD") {
      throw new Error(
        `prepareForTask: refusing to create branch ${branchName} from base ${JSON.stringify(base)} (worktree=${worktreePath}, startPoint=${String(startPoint)})`,
      );
    }

    await execAsync(`git checkout --detach ${base}`, {
      cwd: worktreePath,
    });

    // Create or force-reset the branch from the start point (or main)
    const checkoutCmd = `git checkout -B "${branchName}" ${base}`;
    const resolvedBase = (await execAsync(`git rev-parse --verify "${base}^{commit}"`, { cwd: worktreePath, encoding: "utf-8" })).stdout.trim();

    // Verify HEAD actually landed at the resolved base after --detach. If
    // detach silently leaves HEAD elsewhere (e.g. the base ref didn't exist
    // and git fell through to current HEAD), creating the branch now would
    // pin it to the wrong tip — exactly the FN-5432 / FN-5255 contamination
    // pattern ("branch: Created from HEAD" pointing at the previous occupant's
    // tip). Only enforced when we have real SHAs to compare; mock-driven
    // unit tests that return empty buffers fall through harmlessly.
    if (/^[0-9a-f]{40}$/i.test(resolvedBase)) {
      const detachedHead = (await execAsync("git rev-parse HEAD", { cwd: worktreePath, encoding: "utf-8" })).stdout.trim();
      if (detachedHead !== resolvedBase) {
        throw new Error(
          `prepareForTask: post-detach HEAD ${detachedHead} does not match resolved base ${resolvedBase} (${base}) for ${branchName} — refusing to create branch`,
        );
      }
    }
    const taskId = deriveTaskIdFromBranch(branchName);
    try {
      await execAsync(checkoutCmd, {
        cwd: worktreePath,
      });
      await assertCleanBranchAtBase(worktreePath, branchName, resolvedBase, taskId);
      return { branch: branchName, worktreePath, reclaimed: false };
    } catch (err: unknown) {
      const execError = err instanceof Error ? err : new Error(String(err));
      const stderr = "stderr" in execError
        ? String((execError as { stderr?: unknown }).stderr ?? execError.message)
        : execError.message;
      const match = stderr.match(/already used by worktree at '([^']+)'/);
      if (!match) {
        throw err;
      }

      // The branch is checked out in a different worktree. Keep stale-conflict
      // cleanup behavior for missing paths; otherwise either surface a typed
      // conflict or, when explicitly enabled, fall back to the legacy sibling
      // suffix flow.
      const conflictingPath = match[1];
      const repoDir = options?.repoDir ?? worktreePath;
      const inspection = await inspectBranchConflict({
        repoDir,
        branchName,
        conflictingWorktreePath: conflictingPath,
        requestingTaskId: options?.requestingTaskId ?? taskId,
        ownerTaskId: taskId,
        startPoint: base,
        integrationRef: await resolveIntegrationBranch(repoDir, undefined),
      });
      if (inspection.kind === "stale" || inspection.kind === "stale-resolved" || inspection.kind === "tip-already-merged") {
        const backend = resolveWorktreeBackendViaSettings({}, { logger: worktreePoolLog });
        await backend.prune({ rootDir: options?.repoDir ?? worktreePath });
        if (inspection.kind === "tip-already-merged") {
          try {
            await execAsync(`git branch -D "${branchName}"`, { cwd: worktreePath });
          } catch {
            // best-effort
          }
        }
        await execAsync(checkoutCmd, { cwd: worktreePath });
        await assertCleanBranchAtBase(worktreePath, branchName, resolvedBase, taskId);
        return { branch: branchName, worktreePath, reclaimed: false };
      }

      if (inspection.kind === "reclaimable") {
        worktreePoolLog.log(
          `reclaimed self-owned branch conflict for ${branchName}: tip=${inspection.tipSha} strandedSince${base}=${inspection.strandedCommits.length}`,
        );
        return {
          branch: branchName,
          worktreePath: inspection.livePath,
          reclaimed: true,
          existingTipSha: inspection.tipSha,
          strandedCommitCount: inspection.strandedCommits.length,
        };
      }

      if (inspection.kind === "fully-subsumed") {
        worktreePoolLog.log(
          `reclaimed fully-subsumed branch conflict for ${branchName}: tip=${inspection.tipSha} strandedSince${base}=0`,
        );
        return {
          branch: branchName,
          worktreePath: inspection.livePath,
          reclaimed: true,
          existingTipSha: inspection.tipSha,
          strandedCommitCount: 0,
        };
      }

      if (!options?.allowSiblingBranchRename) {
        if (inspection.kind === "live-foreign") {
          throw inspection.error;
        }
        throw new Error(`Branch ${branchName} is already in use at ${conflictingPath}`);
      }

      const conflictBase = branchName;
      for (let suffix = 2; suffix <= 6; suffix++) {
        const suffixedName = `${branchName}-${suffix}`;
        const suffixedCmd = `git checkout -B "${suffixedName}" ${conflictBase}`;
        try {
          await execAsync(suffixedCmd, { cwd: worktreePath });
          await assertCleanBranchAtBase(worktreePath, suffixedName, resolvedBase, taskId);
          return { branch: suffixedName, worktreePath, reclaimed: false };
        } catch (suffixErr: unknown) {
          const suffixExecError = suffixErr instanceof Error ? suffixErr : new Error(String(suffixErr));
          const suffixStderr = "stderr" in suffixExecError && typeof suffixExecError.stderr === "string"
            ? suffixExecError.stderr.toString()
            : "";
          if (!suffixStderr.includes("already used by worktree")) {
            throw suffixErr;
          }
        }
      }

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
export async function scanIdleWorktrees(
  rootDir: string,
  store: TaskStore,
  settings?: Pick<Settings, "worktreesDir">,
): Promise<string[]> {
  const worktreesDir = resolveWorktreesDir(rootDir, settings);

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
  const tasks = await store.listTasks({ slim: true, includeArchived: false, startupMemo: true });
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
export async function cleanupOrphanedWorktrees(
  rootDir: string,
  store: TaskStore,
  settings?: Pick<Settings, "worktreesDir">,
): Promise<number> {
  const worktreesDir = resolveWorktreesDir(rootDir, settings);
  if (!existsSync(worktreesDir)) {
    return 0;
  }

  const orphaned = await scanIdleWorktrees(rootDir, store, settings);
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
        const orphanTaskId = `orphan:${basename(worktreePath)}`;
        try {
          await cleanupSecretsEnvFile({
            worktreePath,
            taskId: orphanTaskId,
            expectedFingerprint: null,
            filename: ".env",
            audit: undefined,
            logger: worktreePoolLog,
          });
        } catch (error) {
          worktreePoolLog.warn(
            `secrets-env cleanup failed for registered orphan ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await removeWorktreeViaBackend({
          rootDir,
          worktreePath,
          settings: settings ?? {},
          reason: RemovalReason.PoolPrune,
        });
      } else {
        if (!isInsideWorktreesDir(rootDir, worktreePath, settings)) {
          throw new Error(`Refusing to remove path outside .worktrees: ${worktreePath}`);
        }
        rmSync(worktreePath, { recursive: true, force: true });
        await pruneWorktreeAdminEntries({
          rootDir,
          reason: "pool-cleanup-orphan",
          target: worktreePath,
          logger: worktreePoolLog,
        }).catch(() => undefined);
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
export async function reapOrphanWorktrees(
  projectRoot: string,
  settings?: Pick<Settings, "worktreesDir">,
): Promise<number> {
  const worktreesDir = resolveWorktreesDir(projectRoot, settings);

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
      try {
        await cleanupSecretsEnvFile({
          worktreePath: resolvedFull,
          taskId: `orphan:${name}`,
          expectedFingerprint: null,
          filename: ".env",
          logger: worktreePoolLog,
        });
      } catch (error) {
        worktreePoolLog.warn(`secrets-env cleanup failed for orphan ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      rmSync(resolvedFull, { recursive: true, force: true });
      await pruneWorktreeAdminEntries({
        rootDir: projectRoot,
        reason: "pool-reap-orphan",
        target: resolvedFull,
        logger: worktreePoolLog,
      }).catch(() => undefined);
      worktreePoolLog.log(`reapOrphanWorktrees: removed half-initialized orphan ${name}`);
      removed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      worktreePoolLog.warn(`reapOrphanWorktrees: failed to remove ${name} — ${msg}`);
    }
  }

  return removed;
}

/** Columns where merger/finalization owns branch lifecycle. */
const MERGER_MANAGED_COLUMNS: ReadonlySet<Column> = new Set(["in-review", "done"]);

/**
 * Return local `fusion/*` branches not associated with any active task.
 * Branches tied to merger-managed or archived tasks are excluded.
 */
export async function scanOrphanedBranches(rootDir: string, store: TaskStore): Promise<string[]> {
  let allBranches: string[];
  try {
    const result = await execAsync("git branch --list 'fusion/*'", {
      cwd: rootDir,
      encoding: "utf-8",
    });
    const stdout = getExecStdout(result);
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

  const tasks = await store.listTasks({ slim: true, includeArchived: false });
  const activeBranches = new Set<string>();
  for (const task of tasks) {
    if (MERGER_MANAGED_COLUMNS.has(task.column)) continue;
    if (task.column === "archived") continue;
    if (task.branch) activeBranches.add(task.branch);
    activeBranches.add(canonicalFusionBranchName(task.id));
  }

  return allBranches.filter((branch) => !activeBranches.has(branch));
}

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { Settings, TaskStore, WorktrunkSettings, WorkspaceWorktreeContext } from "@fusion/core";
import { worktreePoolLog } from "../logger.js";
/*
*/
import { isInsideConfiguredWorktreesDir, isReclaimableWorktreeCandidate, isWorktreeContainerDir, resolveWorktreesDirScanRoots } from "./worktree-paths.js";
import {
  resolveWorktrunkBinary,
} from "./worktrunk-installer.js";
import {
  RemovalReason,
  removeWorktree as removeWorktreeViaBackend,
} from "./worktree-backend.js";
import { pruneWorktreeAdminEntries } from "./worktree-prune.js";
import { resolveWorkflowIrForTask, columnsWithFlag } from "@fusion/core";

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
const execFileAsync = promisify(execFile);

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
  /*
  FNXC:WorktreeLiveness 2026-07-15-11:55:
  On macOS, /tmp is a symlink to /private/tmp. realpathSync of an existing worktrees
  root yields /private/tmp/... while resolve() of a not-yet-created child stays under
  /tmp/... — relative() then looks like a path escape and isInsideConfiguredWorktreesDir
  falsely reports outside_worktrees_dir (restart.integration resumeOrphaned).
  When the leaf is missing, realpath the nearest existing ancestor and rejoin the suffix.
  */
  try {
    return realpathSync(path);
  } catch {
    let dir = resolve(path);
    const suffix: string[] = [];
    while (true) {
      try {
        return resolve(realpathSync(dir), ...suffix.reverse());
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        suffix.push(basename(dir));
        dir = parent;
      }
    }
    return resolve(path);
  }
}

export function isRepoRootPath(rootDir: string, candidate: string): boolean {
  return canonicalizePath(rootDir) === canonicalizePath(candidate);
}

function getExecStdout(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "stdout" in result) {
    const stdout = (result as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : String(stdout ?? "");
  }
  return "";
}

function stringifyExecOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return typeof value === "string" ? value : String(value ?? "");
}

function getExecErrorOutput(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const record = error as { stderr?: unknown; message?: unknown };
  const stderr = stringifyExecOutput(record.stderr).trim();
  if (stderr) return stderr;
  return stringifyExecOutput(record.message).trim();
}

export type GitRepoDetection =
  | { status: "repo" }
  | { status: "not-repo"; stderr: string }
  | { status: "error"; reason: "dubious-ownership" | "git-missing" | "timeout" | "unknown"; stderr: string };

function classifyGitRepoDetectionError(error: unknown): GitRepoDetection {
  const stderr = getExecErrorOutput(error);
  const output = stderr || String(error ?? "");
  const errorRecord = (error && typeof error === "object") ? error as { code?: unknown; killed?: unknown; signal?: unknown } : {};

  if (/not a git repo(sitory)?/i.test(output)) {
    return { status: "not-repo", stderr: output };
  }

  if (/detected dubious ownership/i.test(output)) {
    return { status: "error", reason: "dubious-ownership", stderr: output };
  }

  if (errorRecord.code === "ENOENT" || /(?:spawn\s+)?ENOENT/i.test(output) || /command not found/i.test(output)) {
    return { status: "error", reason: "git-missing", stderr: output };
  }

  if (errorRecord.code === "ETIMEDOUT" || errorRecord.killed === true || /timed out|timeout/i.test(output)) {
    return { status: "error", reason: "timeout", stderr: output };
  }

  return { status: "error", reason: "unknown", stderr: output };
}

/*
FNXC:Worktree 2026-07-10-00:00:
FN-7799 requires Git repository detection to distinguish a positive non-repo verdict from environmental Git failures. Dubious ownership on OneDrive-backed Windows Documents paths, git-not-on-PATH, index locks, and timeouts must never be reported as "not a Git repository", because that false negative permanently blocks valid repos across engine restarts.
*/
export async function detectGitRepository(dir: string): Promise<GitRepoDetection> {
  try {
    await execAsync("git rev-parse --git-dir", {
      cwd: dir,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { status: "repo" };
  } catch (err: unknown) {
    const detection = classifyGitRepoDetectionError(err);
    const reasonText = detection.status === "error" ? ` reason=${detection.reason}` : "";
    const stderrText = detection.status === "repo" ? "" : detection.stderr;
    worktreePoolLog.log(
      `detectGitRepository check failed for ${dir}: status=${detection.status}${reasonText} stderr=${stderrText}`,
    );
    return detection;
  }
}

export async function isGitRepository(dir: string): Promise<boolean> {
  return (await detectGitRepository(dir)).status === "repo";
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

/*
FNXC:WorktreeLiveness 2026-07-26-08:20:
SYNC, NON-SPAWNING liveness probe for callers that must not run git — specifically failure/recovery
paths, where spawning git to decide how to recover from a git failure is both slow and fragile.
`classifyTaskWorktree` stays the canonical classifier and MUST be preferred wherever an await and a
subprocess are acceptable (see docs/solutions/logic-errors/repo-root-task-worktree-requeue-loop.md
→ Prevention: new worktree-liveness paths should call the shared classifier).

This probe covers the classifier's filesystem gate (the path exists and carries `.git`) plus its
`repo-root` gate when `rootDir` is supplied. It does NOT cover `unregistered` or
`outside-work-tree`, so a directory whose `.git` pointer is stale but present still reads as usable
here. Callers that treat "usable" as permission to reuse a checkout must tolerate that narrower
guarantee; callers needing the full verdict must await `classifyTaskWorktree`. Keeping the fast
probe HERE, beside the classifier, is what makes the difference between the two auditable instead
of a duplicate check growing in an unrelated module.

Pass `rootDir` whenever the caller has it. The project root is a registered git worktree carrying
`.git`, so without that gate the main checkout reads as a usable TASK worktree — the FN-6861
acquisition→gate→requeue loop in
docs/solutions/logic-errors/repo-root-task-worktree-requeue-loop.md.
*/
export function hasUsableWorktreeShape(
  worktreePath: string | undefined | null,
  rootDir?: string,
): boolean {
  if (!worktreePath) return false;
  // `.git` under a path that does not exist (or is a file) cannot exist either, so this single
  // filesystem probe subsumes the directory-existence check.
  if (!hasRequiredWorktreeFiles(worktreePath)) return false;
  if (rootDir && isRepoRootPath(rootDir, worktreePath)) return false;
  return true;
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
    worktreePoolLog.debug(`isInsideGitWorkTree check failed for ${worktreePath}: ${errorMessage}`);
    return false;
  }
}

export type TaskWorktreeClassification = "missing" | "incomplete" | "repo-root" | "unregistered" | "outside-work-tree";

export type TaskWorktreeClassificationResult =
  | { ok: true }
  | { ok: false; classification: TaskWorktreeClassification; reason: string };

export type NestedWorktreeRootDetectionResult =
  | { reanchored: true; root: string }
  | { reanchored: false; reason: string };

export async function detectNestedWorktreeRoot(
  rootDir: string,
  worktreePath: string,
  settings?: Pick<Settings, "worktreesDir">,
): Promise<NestedWorktreeRootDetectionResult> {
  if (!existsSync(worktreePath)) {
    return { reanchored: false, reason: "worktree_missing" };
  }

  if (!isInsideWorktreesDir(rootDir, worktreePath, settings)) {
    return { reanchored: false, reason: "worktree_outside_configured_dir" };
  }

  const canonicalRootDir = canonicalizePath(rootDir);
  const canonicalWorktreePath = canonicalizePath(worktreePath);

  let topLevelRaw = "";
  try {
    const result = await execAsync("git rev-parse --show-toplevel", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    topLevelRaw = getExecStdout(result).trim();
  } catch (error) {
    return { reanchored: false, reason: `top_level_probe_failed:${error instanceof Error ? error.message : String(error)}` };
  }

  if (!topLevelRaw) {
    return { reanchored: false, reason: "top_level_empty" };
  }

  const canonicalTopLevel = canonicalizePath(topLevelRaw);
  if (canonicalTopLevel === canonicalWorktreePath) {
    return { reanchored: false, reason: "already_at_toplevel" };
  }

  if (canonicalTopLevel === canonicalRootDir) {
    return { reanchored: false, reason: "toplevel_is_repo_root" };
  }

  if (!isInsideWorktreesDir(rootDir, canonicalTopLevel, settings)) {
    return { reanchored: false, reason: "toplevel_outside_configured_dir" };
  }

  const relFromTopLevel = relative(canonicalTopLevel, canonicalWorktreePath);
  const nestedUnderTopLevel = relFromTopLevel !== "" && !relFromTopLevel.startsWith("..") && !isAbsolute(relFromTopLevel);
  if (!nestedUnderTopLevel) {
    return { reanchored: false, reason: "not_nested_under_toplevel" };
  }

  if (!await isRegisteredGitWorktree(rootDir, canonicalTopLevel)) {
    return { reanchored: false, reason: "toplevel_not_registered_worktree" };
  }

  return { reanchored: true, root: canonicalTopLevel };
}

/**
 * Language-agnostic liveness/classification gate for task worktrees.
 */
export async function classifyTaskWorktree(rootDir: string, worktreePath: string): Promise<TaskWorktreeClassificationResult> {
  if (!existsSync(worktreePath)) {
    return { ok: false, classification: "missing", reason: "worktree directory does not exist" };
  }

  /*
   * FNXC:WorktreeLiveness 2026-06-21-11:10:
   * The project root is a legitimately registered git worktree, but it is never a usable task worktree. Tasks must execute inside the configured worktrees directory, so classification rejects root-equal paths here to stop the resume↔executor-gate requeue loop observed in FN-6861/FN-6709.
   */
  if (isRepoRootPath(rootDir, worktreePath)) {
    return { ok: false, classification: "repo-root", reason: "worktree path is the project root, not a task worktree" };
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
  workspaceContext?: WorkspaceWorktreeContext,
): boolean {
  return isInsideConfiguredWorktreesDir(rootDir, settings, worktreePath, workspaceContext);
}

export type ReclaimableWorktreePlacement =
  | { kind: "ready"; path: string; relocated: boolean }
  | { kind: "deferred-live"; path: string };

export interface RelocateReclaimableWorktreeInput {
  rootDir: string;
  sourcePath: string;
  targetPath: string;
  taskId: string;
  settings?: Pick<Settings, "worktreesDir" | "worktrunk">;
  isPathActive: (path: string) => boolean | Promise<boolean>;
}

/**
 * Put a preserved, registered native checkout under the configured worktree
 * root. Worktrunk-assigned paths remain backend-owned. The exact source path
 * must be idle before it can move; callers treat a live result as deferred
 * recovery rather than invalidating a running process cwd.
 */
export async function relocateReclaimableWorktreeIntoRoot(
  input: RelocateReclaimableWorktreeInput,
): Promise<ReclaimableWorktreePlacement> {
  const { rootDir, sourcePath, targetPath, taskId, settings, isPathActive } = input;
  if (settings?.worktrunk?.enabled === true) {
    return { kind: "ready", path: sourcePath, relocated: false };
  }
  if (isInsideWorktreesDir(rootDir, sourcePath, settings)) {
    return { kind: "ready", path: sourcePath, relocated: false };
  }
  if (await isPathActive(sourcePath)) {
    return { kind: "deferred-live", path: sourcePath };
  }
  if (!isInsideWorktreesDir(rootDir, targetPath, settings)) {
    throw new Error(
      `Refusing to relocate ${taskId} worktree to path outside configured worktrees directory: ${targetPath}`,
    );
  }

  if (existsSync(targetPath)) {
    throw new Error(`Refusing to relocate ${taskId} worktree into its occupied task-ID path: ${targetPath}`);
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await execFileAsync("git", ["worktree", "move", sourcePath, targetPath], {
    cwd: rootDir,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return { kind: "ready", path: targetPath, relocated: true };
}

function retireEmptyLegacyWorktreesRoot(
  rootDir: string,
  settings?: Pick<Settings, "worktreesDir" | "workspaceMode">,
): void {
  if (settings?.worktreesDir) return;
  const legacyRoot = resolveWorktreesDirScanRoots(rootDir, settings)[1];
  if (!legacyRoot) return;
  try {
    // Non-recursive removal leaves any unexpected residue intact.
    rmdirSync(legacyRoot);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      worktreePoolLog.debug?.(`Unable to retire empty legacy worktrees root ${legacyRoot}: ${String(error)}`);
    }
  }
}

/**
 * Scan every managed worktree root for task worktrees no longer assigned to an
 * active task. A worktree is idle when it is not assigned through
 * `task.worktree` to any non-complete task.
 *
 * @param rootDir — Project root
 * @param store — Task store for listing tasks and their worktree assignments
 * @returns Absolute paths of idle worktree directories
 */
export async function scanIdleWorktrees(
  rootDir: string,
  store: TaskStore,
  settings?: Pick<Settings, "worktreesDir" | "workspaceMode">,
): Promise<string[]> {
  /* FNXC:WorkspaceWorktree 2026-08-20-01:20: Group containers are not task worktrees; workspace cleanup uses recorded member paths rather than directory walking. */
  if (settings?.workspaceMode) {
    worktreePoolLog.debug?.("Skipping directory walk for workspace worktrees; recorded paths are reclaimed addressably.");
    return [];
  }
  const scanRoots = resolveWorktreesDirScanRoots(rootDir, settings);

  // List direct children from both the current and legacy roots. A missing root
  // is ordinary during migration and must not hide the other root.
  let dirs: string[] = [];
  for (const worktreesDir of scanRoots) {
    if (!existsSync(worktreesDir)) continue;
    try {
      const entries = readdirSync(worktreesDir, { withFileTypes: true });
      dirs.push(...entries
        .filter((e) => e.isDirectory() && !isWorktreeContainerDir(e.name))
        .map((e) => join(worktreesDir, e.name)));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreePoolLog.warn(`Failed to read worktrees directory ${worktreesDir}: ${errorMessage}`);
    }
  }

  dirs = (await Promise.all(dirs.map(async (dir) =>
    (await isReclaimableWorktreeCandidate(dir, { rootDir })) ? dir : null,
  ))).filter((dir): dir is string => dir !== null);
  if (dirs.length === 0) return [];

  const registeredWorktrees = await getRegisteredWorktreePaths(rootDir);
  const registeredDirs = dirs.filter((dir) => registeredWorktrees.has(resolve(dir)));

  // Find worktree paths assigned to non-done tasks (active worktrees)
  const tasks = await store.listTasks({ slim: true, includeArchived: false, startupMemo: true });
  const activeWorktrees = new Set<string>();
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-14:05 (batch-engine tail):
  "Still holding its worktree" excludes tasks that have FINISHED. Keyed on the id, a renamed complete
  lane kept every shipped task's worktree in the ACTIVE set, so this reclaim pass never returned it and
  the board walked into worktree exhaustion — a stall whose cause is invisible from the symptom.

  NOT the query-filter class: this listTasks call passes no `column`.

  Resolved per TASK (each may run its own workflow) and ONLY for tasks that actually record a worktree,
  with one IR cache for the pass. Unioned with the legacy id because `resolveWorkflowIrForTask` degrades
  to the BUILT-IN IR rather than throwing — without the union a degraded board would hold every worktree
  forever, which is this bug.
  */
  const reclaimIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
  const completeByTaskId = new Map<string, ReadonlySet<string>>();
  for (const task of tasks) {
    if (!task.worktree) continue;
    const columns = new Set<string>(["done"]);
    try {
      const ir = await resolveWorkflowIrForTask(store, task.id, reclaimIrCache);
      if (ir) for (const id of columnsWithFlag(ir, "complete")) columns.add(id);
    } catch { /* degraded: legacy id only */ }
    completeByTaskId.set(task.id, columns);
  }
  const isUnfinished = (task: { id: string; column: string }) =>
    completeByTaskId.get(task.id)?.has(task.column) !== true;
  for (const task of tasks) {
    if (task.worktree && isUnfinished(task) && registeredWorktrees.has(resolve(task.worktree))) {
      activeWorktrees.add(resolve(task.worktree));
    } else if (task.worktree && isUnfinished(task)) {
      worktreePoolLog.debug(`Ignoring task ${task.id} worktree metadata because it is not a registered git worktree: ${task.worktree}`);
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
 * assigned to any non-done task, preventing stale directories from blocking
 * deterministic task-ID worktree creation.
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
  settings?: Pick<Settings, "worktreesDir" | "workspaceMode">,
): Promise<number> {
  if (settings?.workspaceMode) {
    worktreePoolLog.debug?.("Skipping workspace orphan sweep; recorded paths are reclaimed addressably.");
    return 0;
  }
  const scanRoots = resolveWorktreesDirScanRoots(rootDir, settings);
  const orphaned = await scanIdleWorktrees(rootDir, store, settings);
  const registeredWorktrees = await getRegisteredWorktreePaths(rootDir);

  const dirs: string[] = [];
  for (const worktreesDir of scanRoots) {
    if (!existsSync(worktreesDir)) continue;
    try {
      dirs.push(...readdirSync(worktreesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !isWorktreeContainerDir(e.name))
        .map((e) => join(worktreesDir, e.name)));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreePoolLog.warn(`Failed to read worktrees directory ${worktreesDir} for cleanup: ${errorMessage}`);
    }
  }

  const ownedDirs = (await Promise.all(dirs.map(async (dir) =>
    (await isReclaimableWorktreeCandidate(dir, { rootDir })) ? dir : null,
  ))).filter((dir): dir is string => dir !== null);
  const unregistered = ownedDirs.filter((dir) => !registeredWorktrees.has(resolve(dir)));
  const candidates = [...new Map([...orphaned, ...unregistered].map((path) => [resolve(path), path])).values()];
  let cleaned = 0;

  for (const worktreePath of candidates) {
    try {
      if (registeredWorktrees.has(resolve(worktreePath))) {
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
        // FNXC:WorktreeCleanup: rmdir is deliberately non-recursive. Any content
        // makes it fail closed and preserves the unregistered checkout.
        rmdirSync(worktreePath);
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

  retireEmptyLegacyWorktreesRoot(rootDir, settings);
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
/**
 * Decide whether a worktree's `.git` pointer is *dangling* — present on disk but
 * referencing a `.git/worktrees/<name>` admin entry that no longer exists. A
 * dangling pointer is FN-6782 leak residue: invisible to `git worktree list` /
 * `prune`, yet it collides with freshly generated worktree names.
 *
 * Returns `true` ONLY when the pointer is confidently classifiable as dangling:
 * a `gitdir: <path>` link file (relative targets resolved against the worktree
 * dir) whose target is confirmed missing. Returns `false` for everything else —
 * a real `.git` directory, a live gitdir target, an unparseable pointer, OR any
 * read/stat failure. The conservative default matters: callers reap on `true`,
 * so a transient read error (EACCES/EBUSY) on a genuinely-live worktree's `.git`
 * must never be misread as dangling and force-removed.
 */
function dotGitPointerIsDangling(dotGitPath: string): boolean {
  try {
    if (lstatSync(dotGitPath).isDirectory()) return false;
    const raw = readFileSync(dotGitPath, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(raw);
    if (!match) return false;
    const target = match[1].trim();
    const resolved = isAbsolute(target) ? target : resolve(dirname(dotGitPath), target);
    return !existsSync(resolved);
  } catch {
    return false;
  }
}

export async function reapOrphanWorktrees(
  projectRoot: string,
  settings?: Pick<Settings, "worktreesDir" | "workspaceMode">,
): Promise<number> {
  if (settings?.workspaceMode) {
    worktreePoolLog.debug?.("Skipping workspace orphan reaping; recorded paths are reclaimed addressably.");
    return 0;
  }
  const scanRoots = resolveWorktreesDirScanRoots(projectRoot, settings);

  // Read every currently valid root; failure in one root must not hide legacy
  // checkout residue in the other.
  let entries: Array<{ name: string; fullPath: string }> = [];
  for (const worktreesDir of scanRoots) {
    if (!existsSync(worktreesDir)) continue;
    try {
      entries.push(...readdirSync(worktreesDir, { withFileTypes: true })
        .filter((e) => {
          // Only real directories — never symlinks or internal worktree containers.
          if (!e.isDirectory() || isWorktreeContainerDir(e.name) || !existsSync(join(worktreesDir, e.name, ".git"))) return false;
          try {
            return lstatSync(join(worktreesDir, e.name)).isDirectory() && !lstatSync(join(worktreesDir, e.name)).isSymbolicLink();
          } catch {
            return false;
          }
        })
        .map((e) => ({ name: e.name, fullPath: join(worktreesDir, e.name) })));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      worktreePoolLog.warn(`reapOrphanWorktrees: failed to read ${worktreesDir} — ${msg}`);
    }
  }

  if (entries.length === 0) {
    retireEmptyLegacyWorktreesRoot(projectRoot, settings);
    return 0;
  }
  entries = (await Promise.all(entries.map(async (entry) =>
    (await isReclaimableWorktreeCandidate(entry.fullPath, { rootDir: projectRoot })) ? entry : null,
  ))).filter((entry): entry is { name: string; fullPath: string } => entry !== null);
  if (entries.length === 0) return 0;

  // Get the set of paths registered with git
  const registered = await getRegisteredWorktreePaths(projectRoot);

  let removed = 0;
  for (const { name, fullPath } of entries) {
    const resolvedFull = resolve(fullPath);

    // The directory read above establishes a direct child; containment keeps
    // persisted legacy roots valid while refusing every other external path.
    if (!isInsideWorktreesDir(projectRoot, resolvedFull, settings)) {
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
    //
    // FN-6782 follow-up: a *dangling* `.git` (file present, but the admin entry it
    // points to is gone) is NOT "partially registered" — it is leak residue from a
    // worktree whose admin entry was pruned while the directory survived. Such a dir
    // is invisible to `git worktree list`/`prune` yet collides with freshly generated
    // worktree names and breaks `execute` (cleanup can't `git worktree remove` a path
    // git never registered). Only skip when the gitdir target actually exists; reap
    // dangling pointers like any other half-initialized orphan.
    const dotGit = join(resolvedFull, ".git");
    if (existsSync(dotGit)) {
      if (!dotGitPointerIsDangling(dotGit)) {
        // Valid registration, a real .git dir, or a pointer we couldn't positively classify as
        // dangling — leave it; assertValidWorktreeSession handles it on the next agent start.
        worktreePoolLog.debug(`reapOrphanWorktrees: skipping ${name} (has .git entry but not in registered list — may be partially registered)`);
        continue;
      }
      worktreePoolLog.debug(`reapOrphanWorktrees: ${name} has a dangling .git pointer (admin entry missing) — treating as orphan`);
      // fall through to the non-recursive removal below; `.git` makes it fail closed.
    }

    // This directory is on disk but has no valid .git entry and is not a registered
    // worktree — it is a half-initialized / leaked orphan.  Remove it.
    try {
      rmdirSync(resolvedFull);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      worktreePoolLog.warn(`reapOrphanWorktrees: failed to remove ${name} — ${msg}`);
      continue;
    }
    await pruneWorktreeAdminEntries({
      rootDir: projectRoot,
      reason: "pool-reap-orphan",
      target: resolvedFull,
      logger: worktreePoolLog,
    }).catch(() => undefined);
    worktreePoolLog.log(`reapOrphanWorktrees: removed half-initialized orphan ${name}`);
    removed++;
  }

  retireEmptyLegacyWorktreesRoot(projectRoot, settings);
  return removed;
}

/** Columns where merger/finalization owns branch lifecycle. */

/**
 * Return local `fusion/*` branches not associated with any active task.
 * Branches tied to merger-managed or deleted/historical tasks are excluded.
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
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-08:20 (batch-engine — census-invisible membership, #2763 class):
  A branch is active unless the merger owns the card. The old hardcoded test missed renamed review or Complete columns, so a card there was not recognised as
  merger-managed and its branch was treated as reclaimable — deleting a branch out from under an in-flight
  merge. One IR cache for the pass; the predicates below stay synchronous.
  */
  const poolIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
  const poolLanes = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (poolLanes.has(task.id)) continue;
    const managed = new Set<string>(["in-review", "done"]);
    try {
      const ir = await resolveWorkflowIrForTask(store, task.id, poolIrCache);
      if (ir) {
        for (const flag of ["mergeOrchestration", "mergeBlocker", "humanReview", "complete"] as const) {
          for (const id of columnsWithFlag(ir, flag)) managed.add(id);
        }
      }
    } catch { /* degraded: legacy ids */ }
    poolLanes.set(task.id, managed);
  }
  const activeBranches = new Set<string>();
  for (const task of tasks) {
    if (poolLanes.get(task.id)?.has(task.column) === true) continue;
    if (task.branch) activeBranches.add(task.branch);
    // Keep non-pool branch reaping aware of the canonical task branch without importing
    // worktree-names here (that module reaches worktree-paths, which reaches this helper).
    activeBranches.add(`fusion/${task.id.toLowerCase()}`);
  }

  return allBranches.filter((branch) => !activeBranches.has(branch));
}

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isLegacyWorkspaceWorktreeLayout,
  isStrictDescendantPath,
  resolveWorkspaceTaskWorktreeDir,
  type Settings,
  type Task,
} from "@fusion/core";
import {
  activeSessionRegistry,
  executingTaskLock,
  type ActiveSessionPathLease,
} from "../agents/active-session-registry.js";
import { removeEmptyWorkspaceTaskDirectory } from "../merge/post-landing-worktree-cleanup.js";
import { isInsideConfiguredWorktreesDir } from "./worktree-paths.js";
import { RemovalReason, removeWorktree, resolveWorktreeBackend } from "./worktree-backend.js";
import { canonicalizePath } from "./worktree-pool.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export type DeletedTaskWorktreeCleanupStatus =
  | "removed"
  | "already-absent"
  | "deferred-live"
  | "refused-ownership"
  | "failed";

export interface DeletedTaskWorktreeCleanupTargetResult {
  worktreePath: string;
  repoRelPath?: string;
  status: DeletedTaskWorktreeCleanupStatus;
  detail?: string;
}

export interface DeletedTaskWorktreeCleanupResult {
  taskId: string;
  targets: DeletedTaskWorktreeCleanupTargetResult[];
  taskDirectoryRemoved: boolean;
  converged: boolean;
}

export interface CleanupDeletedTaskWorktreesInput {
  task: Task;
  allTasks: readonly Task[];
  rootDir: string;
  settings: Partial<Settings>;
  isTaskActive?: (taskId: string) => boolean;
  isPlanningActive?: (taskId: string) => boolean;
  isMergePending?: (taskId: string) => boolean | Promise<boolean>;
  getActiveMergeTaskId?: () => string | null;
  remove?: typeof removeWorktree;
  prune?: (rootDir: string, settings: Partial<Settings>) => Promise<void>;
}

type Target = { worktreePath: string; repoRelPath?: string; repoRootDir: string; canonicalPath: string };

const pathReservations = new Map<string, Promise<void>>();

async function reservePaths(paths: readonly string[]): Promise<() => void> {
  const releases: Array<() => void> = [];
  for (const path of [...new Set(paths)].sort()) {
    const prior = pathReservations.get(path) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    const reservation = prior.catch(() => undefined).then(() => hold);
    pathReservations.set(path, reservation);
    await prior.catch(() => undefined);
    releases.push(() => {
      release();
      if (pathReservations.get(path) === reservation) pathReservations.delete(path);
    });
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
}

function canonicalizePersistedPath(value: string): string | null {
  if (!value.trim() || !isAbsolute(value) || value.includes("\0")) return null;
  const absolute = resolve(value);
  let cursor = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    return canonicalizePath(join(realpathSync(cursor), ...missingSegments));
  } catch {
    return null;
  }
}

async function registeredWorktreePaths(repoRootDir: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRootDir,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return new Set(stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonicalizePath(line.slice("worktree ".length).trim())));
}

function taskClaimPaths(task: Task): string[] {
  return [
    ...(task.worktree ? [task.worktree] : []),
    ...Object.values(task.workspaceWorktrees ?? {}).map((entry) => entry?.worktreePath).filter((path): path is string => Boolean(path)),
  ];
}

function taskHasLiveWork(taskId: string, input: CleanupDeletedTaskWorktreesInput): boolean | Promise<boolean> {
  if (executingTaskLock.has(taskId)
    || input.isTaskActive?.(taskId) === true
    || input.isPlanningActive?.(taskId) === true
    || input.getActiveMergeTaskId?.() === taskId
    || activeSessionRegistry.pathsForTask(taskId).length > 0) return true;
  return Promise.resolve(input.isMergePending?.(taskId) ?? false);
}

function targetIsContained(target: Target, input: CleanupDeletedTaskWorktreesInput, taskDir: string): boolean {
  if (target.repoRelPath === undefined) {
    return isInsideConfiguredWorktreesDir(input.rootDir, input.settings, target.canonicalPath)
      && target.canonicalPath !== canonicalizePath(input.rootDir);
  }
  const workspaceRoot = canonicalizePath(input.rootDir);
  const repoRoot = canonicalizePath(target.repoRootDir);
  if (!isStrictDescendantPath(workspaceRoot, repoRoot)) return false;
  if (target.canonicalPath === workspaceRoot || target.canonicalPath === repoRoot) return false;
  if (!isStrictDescendantPath(workspaceRoot, target.canonicalPath)) return false;
  if (!isLegacyWorkspaceWorktreeLayout(input.task, taskDir)) {
    return isStrictDescendantPath(taskDir, target.canonicalPath);
  }
  // Persisted pre-group workspace layouts remain eligible only without an exclusive configured root.
  return !input.settings.worktreesDir && isStrictDescendantPath(repoRoot, target.canonicalPath);
}

/*
FNXC:TaskDeletionWorktrees 2026-09-07-12:44:
A committed soft-delete authorizes discarding dirty content only from persisted Fusion worktrees whose
path, Git registration, sole task claim, and process liveness are proved again at the destructive
boundary. When singular and workspace metadata alias the same path, the qualified workspace repository
wins so registration is checked against the repository that created the child. The helper never searches
the filesystem; local delivery, outbox replay, startup, and maintenance all feed the same bounded target
list, so an interrupted delete converges idempotently.
*/
export async function cleanupDeletedTaskWorktrees(
  input: CleanupDeletedTaskWorktreesInput,
): Promise<DeletedTaskWorktreeCleanupResult> {
  const taskDir = resolveWorkspaceTaskWorktreeDir(input.rootDir, input.settings, input.task.id);
  const rawTargets: Array<Omit<Target, "canonicalPath">> = [
    ...(input.task.worktree ? [{ worktreePath: input.task.worktree, repoRootDir: input.rootDir }] : []),
    ...Object.entries(input.task.workspaceWorktrees ?? {}).flatMap(([repoRelPath, entry]) => {
      if (!entry?.worktreePath) return [];
      const repoRootDir = resolve(input.rootDir, repoRelPath);
      const rel = relative(resolve(input.rootDir), repoRootDir);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        return [{ worktreePath: entry.worktreePath, repoRelPath, repoRootDir }];
      }
      return [{ worktreePath: entry.worktreePath, repoRelPath, repoRootDir }];
    }),
  ];
  const invalid: DeletedTaskWorktreeCleanupTargetResult[] = [];
  const uniqueTargets = new Map<string, Target>();
  for (const target of rawTargets) {
    const canonicalPath = canonicalizePersistedPath(target.worktreePath);
    if (!canonicalPath) {
      invalid.push({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: "refused-ownership", detail: "unreadable-path" });
      continue;
    }
    const existing = uniqueTargets.get(canonicalPath);
    // A workspace entry identifies the Git repository that owns the child worktree; a legacy
    // singular alias carries only the project root and must not erase that stronger proof.
    if (!existing || (existing.repoRelPath === undefined && target.repoRelPath !== undefined)) {
      uniqueTargets.set(canonicalPath, { ...target, canonicalPath });
    }
  }

  const targets = [...uniqueTargets.values()];
  const releaseReservations = await reservePaths(targets.map((target) => target.canonicalPath));
  const results = [...invalid];
  try {
    if (await taskHasLiveWork(input.task.id, input)) {
      results.push(...targets.map((target) => ({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: "deferred-live" as const })));
      return { taskId: input.task.id, targets: results, taskDirectoryRemoved: false, converged: false };
    }

    const claims = new Map<string, Set<string>>();
    for (const task of input.allTasks) {
      for (const path of taskClaimPaths(task)) {
        const canonical = canonicalizePersistedPath(path);
        if (!canonical) continue;
        const owners = claims.get(canonical) ?? new Set<string>();
        owners.add(task.id);
        claims.set(canonical, owners);
      }
    }

    for (const target of targets) {
      if (!targetIsContained(target, input, taskDir)) {
        results.push({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: "refused-ownership", detail: "outside-managed-root" });
        continue;
      }
      const owners = claims.get(target.canonicalPath) ?? new Set<string>();
      if (owners.size !== 1 || !owners.has(input.task.id)) {
        results.push({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: "refused-ownership", detail: "ambiguous-task-claim" });
        continue;
      }
      if (activeSessionRegistry.isPathActive(target.worktreePath)
        || activeSessionRegistry.isPathActive(target.canonicalPath)
        || await taskHasLiveWork(input.task.id, input)) {
        results.push({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: "deferred-live" });
        continue;
      }
      const reservationOwnerKey = `deleted-task-cleanup:${input.task.id}`;
      let reservationLease: ActiveSessionPathLease;
      try {
        reservationLease = activeSessionRegistry.registerPathExclusive(target.canonicalPath, {
          taskId: input.task.id,
          kind: "task-deletion-cleanup",
          ownerKey: reservationOwnerKey,
        });
      } catch {
        results.push({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: "deferred-live" });
        continue;
      }
      try {
        const registered = await registeredWorktreePaths(target.repoRootDir);
        const exists = existsSync(target.canonicalPath);
        if (exists && !registered.has(target.canonicalPath)) {
          results.push({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: "refused-ownership", detail: "not-registered-by-expected-repository" });
          continue;
        }
        if (!exists) {
          await (input.prune
            ? input.prune(target.repoRootDir, input.settings)
            : resolveWorktreeBackend(input.settings).prune({ rootDir: target.repoRootDir }));
          results.push({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: "already-absent" });
          continue;
        }
        const removal = await (input.remove ?? removeWorktree)({
          rootDir: target.repoRootDir,
          worktreePath: target.canonicalPath,
          settings: input.settings,
          reason: RemovalReason.TaskDeletion,
          taskId: input.task.id,
          force: true,
        });
        results.push({ worktreePath: target.worktreePath, repoRelPath: target.repoRelPath, status: removal.removed ? "removed" : "already-absent" });
      } catch (error) {
        results.push({
          worktreePath: target.worktreePath,
          repoRelPath: target.repoRelPath,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        activeSessionRegistry.unregisterPath(target.canonicalPath, reservationLease);
      }
    }
  } finally {
    releaseReservations();
  }

  const converged = results.every((result) => result.status === "removed" || result.status === "already-absent");
  const taskDirectoryRemoved = converged
    && targets.some((target) => target.repoRelPath !== undefined)
    && !isLegacyWorkspaceWorktreeLayout(input.task, taskDir)
    ? removeEmptyWorkspaceTaskDirectory(taskDir, targets.map((target) => target.worktreePath))
    : false;
  return { taskId: input.task.id, targets: results, taskDirectoryRemoved, converged };
}

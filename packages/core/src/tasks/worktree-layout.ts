import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Settings } from "../types/settings/settings-scope.js";

export interface WorkspaceWorktreeContext {
  workspaceRootDir: string;
  repoRelPath: string;
}

export const WORKSPACE_GROUP_MARKER_FILENAME = ".fusion-workspace-root";
export const LEGACY_WORKTREES_DIRNAME = ".worktrees";

/**
 * FNXC:WorkspaceWorktree 2026-08-20-01:20:
 * Workspace checkout grouping uses a pure, single-valued segment so acquisition,
 * containment, reservations, and cleanup derive the same directory. Candidate
 * directories make ownership undecidable; marker files only reject conflicting
 * acquisition and are never an input to path resolution.
 */
export function sanitizePathSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

function hash8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function workspaceWorktreeGroupSegment(workspaceRootDir: string): string {
  const resolvedRoot = resolve(workspaceRootDir);
  const base = basename(resolvedRoot);
  if (/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(base) && base !== "." && base !== "..") return base;
  const hash = hash8(resolvedRoot);
  return `${sanitizePathSegment(base) || "workspace"}-${hash}`;
}

/** Reject a user-controlled repo path before it can escape a workspace root. */
export function assertWorkspaceRepoRelPath(repoRelPath: string): void {
  if (typeof repoRelPath !== "string" || repoRelPath.length === 0 || isAbsolute(repoRelPath)) {
    throw new Error(`Invalid workspace repo path (must be relative and in-root): ${String(repoRelPath)}`);
  }
  const normalized = normalize(repoRelPath.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.startsWith("../")) {
    throw new Error(`Invalid workspace repo path (escapes workspace root): ${repoRelPath}`);
  }
}

export function workspaceRepoSegment(repoRelPath: string): string {
  assertWorkspaceRepoRelPath(repoRelPath);
  const normalized = normalize(repoRelPath.replaceAll("\\", "/")).replaceAll("\\", "/");
  if (/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(normalized) && !normalized.includes("/") && normalized !== "." && normalized !== "..") {
    return normalized;
  }
  const flattened = sanitizePathSegment(normalized.split("/").join("-")) || "repo";
  return `${flattened}-${hash8(normalized)}`;
}

/**
 * FNXC:WorkspaceWorktree 2026-08-30-15:06:
 * New task worktrees default under `.fusion/worktrees` for both singular and workspace
 * projects. The historic `.worktrees` root remains a first-class containment and sweep
 * candidate while no override is configured, so persisted checkouts are never stranded.
 */
export function resolveWorktreesDirLayout(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  const configured = settings?.worktreesDir;
  if (!configured) return join(rootDir, ".fusion", "worktrees");

  const resolutionRoot = workspaceContext?.workspaceRootDir ?? rootDir;
  const expandedHome = configured.replace(/^~(?=$|[\\/])/, homedir());
  const expandedRepo = expandedHome.replaceAll("{repo}", basename(resolutionRoot));
  const configuredRoot = resolve(resolutionRoot, expandedRepo);
  if (!workspaceContext) return configuredRoot;
  return join(configuredRoot, workspaceWorktreeGroupSegment(workspaceContext.workspaceRootDir), workspaceRepoSegment(workspaceContext.repoRelPath));
}

/** Resolve the historic root without treating it as the current default. */
export function resolveLegacyWorktreesDirLayout(rootDir: string): string {
  return join(rootDir, LEGACY_WORKTREES_DIRNAME);
}

/**
 * Returns every managed root that may contain a task worktree. A configured root is
 * exclusive; otherwise newly-created paths use the primary root while legacy paths
 * remain visible to containment checks and cleanup sweeps.
 */
export function resolveWorktreesDirCandidates(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  workspaceContext?: WorkspaceWorktreeContext,
): string[] {
  const resolved = resolveWorktreesDirLayout(rootDir, settings, workspaceContext);
  if (settings?.worktreesDir) return [resolved];
  return [resolved, resolveLegacyWorktreesDirLayout(rootDir)];
}

/** True only when candidate is strictly contained by root after path resolution. */
export function isStrictDescendantPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/*
FNXC:WorkspaceWorktree 2026-08-22-21:24:
A workspace task owns one directory, not a coordinator repository. Its child paths
preserve repository-relative identity so session, boundary, review, and landing all
refer to the same `repo/path` spelling; a one-repository workspace is the degenerate case.
*/
export function resolveWorkspaceTaskWorktreeDir(
  workspaceRootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  taskDirSegment: string,
): string {
  if (!taskDirSegment) throw new Error("resolveWorkspaceTaskWorktreeDir requires a resolved task directory segment");
  if (!settings?.worktreesDir) return join(workspaceRootDir, ".fusion", "worktrees", taskDirSegment);
  return join(
    resolveWorktreesDirLayout(workspaceRootDir, settings),
    workspaceWorktreeGroupSegment(workspaceRootDir),
    taskDirSegment,
  );
}

/*
FNXC:WorkspaceWorktree 2026-08-23-19:52:
R15 pins a workspace task's directory segment on the task at first acquisition, so a later
branch rename, title edit, or `worktreeNaming` change never moves, re-derives, or invalidates
its recorded paths. Every call site that resolves a workspace task directory reads the pin
through this function rather than deriving a segment of its own — a site that re-derived would
disagree with what is on disk and mix layouts inside one task. A task with no pin (every task
that predates pinning) reproduces the historic `taskId.toLowerCase()` segment exactly.
The group segment above this one stays basename-derived and settings-independent (R17), so
archive disposal and the pi-extension candidate builder still resolve grouped roots with no Task.
*/
export function resolveWorkspaceTaskDirSegment(
  task: { id: string; workspaceWorktreeDirSegment?: string | null },
): string {
  const pinned = task.workspaceWorktreeDirSegment;
  if (typeof pinned === "string" && pinned.length > 0) return pinned;
  return task.id.toLowerCase();
}

/** Resolves a repository child without flattening nested workspace repository names. */
export function resolveWorkspaceRepoWorktreePath(taskDir: string, repoRelPath: string): string {
  assertWorkspaceRepoRelPath(repoRelPath);
  return join(taskDir, repoRelPath);
}

/**
 * Existing tasks retain their persisted per-repository paths; only a task whose
 * entries all live under its task directory uses the single-root layout.
 */
export function isLegacyWorkspaceWorktreeLayout(
  task: { workspaceWorktrees?: Record<string, { worktreePath?: string }> },
  taskDir: string,
): boolean {
  return Object.values(task.workspaceWorktrees ?? {}).some((entry) => {
    if (!entry.worktreePath) return false;
    const rel = relative(resolve(taskDir), resolve(entry.worktreePath));
    return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  });
}

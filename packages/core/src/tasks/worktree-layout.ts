import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { Settings } from "../types/settings/settings-scope.js";

export interface WorkspaceWorktreeContext {
  workspaceRootDir: string;
  repoRelPath: string;
}

export const WORKSPACE_GROUP_MARKER_FILENAME = ".fusion-workspace-root";

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
 * FNXC:WorkspaceWorktree 2026-08-20-01:20:
 * The unset setting intentionally retains the historic per-repository `.worktrees`
 * layout. Grouping applies only to an explicitly configured root, while `.ai-merge`
 * remains resolved separately from the ungrouped root.
 */
export function resolveWorktreesDirLayout(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  const configured = settings?.worktreesDir;
  if (!configured) return join(rootDir, ".worktrees");

  const resolutionRoot = workspaceContext?.workspaceRootDir ?? rootDir;
  const expandedHome = configured.replace(/^~(?=$|[\\/])/, homedir());
  const expandedRepo = expandedHome.replaceAll("{repo}", basename(resolutionRoot));
  const configuredRoot = resolve(resolutionRoot, expandedRepo);
  if (!workspaceContext) return configuredRoot;
  return join(configuredRoot, workspaceWorktreeGroupSegment(workspaceContext.workspaceRootDir), workspaceRepoSegment(workspaceContext.repoRelPath));
}

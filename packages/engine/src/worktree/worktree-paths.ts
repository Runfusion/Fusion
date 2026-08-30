import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveWorktreesDirLayout, WORKSPACE_GROUP_MARKER_FILENAME, type Settings, type WorkspaceWorktreeContext } from "@fusion/core";
import type { WorktreeBackendKind } from "./worktree-backend.js";
import { canonicalizePath } from "./worktree-pool.js";

export const AI_MERGE_DIRNAME = ".ai-merge";
export const WORKTREE_RECOVERY_DIRNAME = ".fusion-recovery";

const execFileAsync = promisify(execFile);

export function isAiMergeContainerDir(name: string): boolean {
  return name === AI_MERGE_DIRNAME;
}

/**
 * FNXC:TaskPinnedWorktrees 2026-08-10-01:12:
 * Cross-filesystem orphan recovery stores preserved task directories under a container inside the configured worktree root. Discovery, cleanup, and capacity scans must treat both internal containers as boundaries rather than task worktrees.
 */
export function isWorktreeContainerDir(name: string): boolean {
  return isAiMergeContainerDir(name) || name === WORKTREE_RECOVERY_DIRNAME;
}

/**
 * FNXC:WorkspaceWorktree 2026-08-20-01:46:
 * Shared configured roots may contain other projects' worktrees and workspace group
 * containers. Reaping is permitted only after Git proves the candidate shares this
 * project's common directory; a workspace marker is solely an additional delete veto.
 */
export async function isReclaimableWorktreeCandidate(
  entryAbsPath: string,
  options: { rootDir: string },
): Promise<boolean> {
  if (isWorktreeContainerDir(entryAbsPath.split(/[\\/]/).pop() ?? "")) return false;
  if (existsSync(join(entryAbsPath, WORKSPACE_GROUP_MARKER_FILENAME))) return false;
  const dotGit = join(entryAbsPath, ".git");
  if (!existsSync(dotGit)) return false;

  // The normal linked-worktree form is a gitdir file below the main checkout's
  // admin directory. Prove that relationship without trusting a directory name.
  try {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (match) {
      const gitdir = resolve(entryAbsPath, match[1]!.trim());
      const rootGitDir = resolve(options.rootDir, ".git");
      const rel = relative(rootGitDir, gitdir);
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return true;
      // FNXC:WorkspaceWorktree 2026-08-20-01:46: A linked project root has a `.git` file, so Git must prove its external common directory.
    }
  } catch {
    // Fall through to Git's common-dir probe for uncommon worktree layouts.
  }

  try {
    const [candidate, root] = await Promise.all([
      execFileAsync("git", ["-C", entryAbsPath, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 10_000 }),
      execFileAsync("git", ["-C", options.rootDir, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 10_000 }),
    ]);
    const canonical = (cwd: string, value: string) => {
      const path = resolve(cwd, value.trim());
      try { return realpathSync(path); } catch { return path; }
    };
    return canonical(entryAbsPath, candidate.stdout) === canonical(options.rootDir, root.stdout);
  } catch {
    // Destructive sweeps fail closed when Git metadata cannot prove ownership.
    return false;
  }
}

export function resolveAiMergeRootPath(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
): string {
  return join(resolveWorktreesDir(rootDir, settings), AI_MERGE_DIRNAME);
}

export function resolveLegacyAiMergeRootPath(rootDir: string): string {
  return join(rootDir, ".fusion", "ai-merge");
}

export function resolveWorktreesDir(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  return resolveWorktreesDirLayout(rootDir, settings, workspaceContext);
}

export function resolveTaskWorktreePath(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  worktreeName: string,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  return join(resolveWorktreesDir(rootDir, settings, workspaceContext), worktreeName);
}

/**
 * Resolve a worktree's private Git administration directory without invoking Git. Linked
 * worktrees use a `.git` file containing a relative `gitdir:` pointer; ordinary checkouts retain
 * a real `.git` directory. Dependency readiness belongs here so it never becomes user-visible
 * repository state or a File Scope commit candidate.
 */
export function resolveWorktreePrivateGitDir(worktreePath: string): string | null {
  const dotGitPath = join(worktreePath, ".git");
  try {
    if (statSync(dotGitPath).isDirectory()) return dotGitPath;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGitPath, "utf8"));
    if (!match?.[1]?.trim()) return null;
    const privateGitDir = resolve(dirname(dotGitPath), match[1].trim());
    return existsSync(privateGitDir) ? privateGitDir : null;
  } catch {
    return null;
  }
}

// Structural backend input avoids importing the full WorktreeBackend interface here.
export async function resolveTaskWorktreePathForBackend(
  rootDir: string,
  worktreeName: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  backend: {
    kind: WorktreeBackendKind;
    resolveWorktreePath?: (input: { rootDir: string; worktreeName: string; branch: string }) => Promise<string>;
  },
  branch: string,
  workspaceContext?: WorkspaceWorktreeContext,
): Promise<string> {
  if (backend.kind === "worktrunk" && backend.resolveWorktreePath) {
    return backend.resolveWorktreePath({ rootDir, worktreeName, branch });
  }
  return resolveTaskWorktreePath(rootDir, settings, worktreeName, workspaceContext);
}

export function isInsideConfiguredWorktreesDir(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  candidate: string,
  workspaceContext?: WorkspaceWorktreeContext,
): boolean {
  const worktreesDir = canonicalizePath(resolveWorktreesDir(rootDir, settings, workspaceContext));
  const target = canonicalizePath(candidate);
  const rel = relative(worktreesDir, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

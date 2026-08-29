import { isAbsolute, relative, resolve } from "node:path";
import type { TaskStore } from "@fusion/core";
import { badRequest } from "./api-error.js";
import { runGitCommand } from "./routes/resolve-diff-base.js";

export function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function listRegisteredWorktreePaths(rootDir: string): Promise<string[]> {
  const output = await runGitCommand(["worktree", "list", "--porcelain"], rootDir, 10_000);
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktreePath = line.slice("worktree ".length).trim();
    if (!worktreePath) continue;
    paths.push(resolve(worktreePath));
  }
  return paths;
}

export async function assertWorktreePathSafe(
  scopedStore: Pick<TaskStore, "getRootDir">,
  worktreePath: string,
  cache: Map<string, string[]>,
): Promise<string> {
  if (typeof worktreePath !== "string" || worktreePath.trim().length === 0) {
    throw badRequest("worktreePath is required");
  }

  if (!isAbsolute(worktreePath)) {
    throw badRequest("worktreePath must be an absolute path");
  }
  const rootDir = resolve(scopedStore.getRootDir());
  const resolved = resolve(worktreePath);
  if (resolved !== worktreePath) {
    throw badRequest("worktreePath must be normalized");
  }
  if (isPathWithin(rootDir, resolved)) {
    return resolved;
  }

  let allowlisted = cache.get(rootDir);
  const hadCachedAllowlist = Boolean(allowlisted);
  if (!allowlisted) {
    allowlisted = await listRegisteredWorktreePaths(rootDir);
    cache.set(rootDir, allowlisted);
  }

  const cachedMatch = allowlisted.some((allowed) => isPathWithin(allowed, resolved));
  if (cachedMatch && !hadCachedAllowlist) {
    return resolved;
  }

  /*
  FNXC:TerminalWorktrees 2026-06-29-23:37:
  Registered worktrees can be created or removed while a long-lived dashboard server is already running. Refresh the Git worktree allowlist on cached hits or misses before authorizing an outside-root path so stale cached registrations do not keep arbitrary recreated directories authorized.
  */
  allowlisted = await listRegisteredWorktreePaths(rootDir);
  cache.set(rootDir, allowlisted);
  if (allowlisted.some((allowed) => isPathWithin(allowed, resolved))) {
    return resolved;
  }

  throw badRequest("worktreePath outside project");
}

export async function isAuthorizedProjectOrRegisteredWorktreePath(
  rootDir: string,
  candidatePath: string,
  cache: Map<string, string[]> = new Map(),
): Promise<boolean> {
  /*
  FNXC:TerminalWorktrees 2026-06-29-00:00:
  Terminal cwd may target the project root or Git-registered worktrees for that project, including task worktrees outside the root. Normalize absolute paths and authorize them against the shared git-worktree policy before PTY spawn so arbitrary filesystem paths remain blocked.
  */
  const root = resolve(rootDir);
  const candidate = resolve(candidatePath);

  if (isPathWithin(root, candidate)) {
    return true;
  }

  let allowlisted = cache.get(root);
  const hadCachedAllowlist = Boolean(allowlisted);
  if (!allowlisted) {
    try {
      allowlisted = await listRegisteredWorktreePaths(root);
    } catch {
      return false;
    }
    cache.set(root, allowlisted);
  }

  const cachedMatch = allowlisted.some((allowed) => isPathWithin(allowed, candidate));
  if (cachedMatch && !hadCachedAllowlist) {
    return true;
  }

  /*
  FNXC:TerminalWorktrees 2026-06-29-23:37:
  Revalidate outside-root terminal cwd authorization against current `git worktree list` output on cached hits or misses. Without this fresh check, removing a worktree and later recreating a directory at the same path would leave the PTY cwd authorization stale for the server lifetime.
  */
  try {
    allowlisted = await listRegisteredWorktreePaths(root);
  } catch {
    return false;
  }
  cache.set(root, allowlisted);

  return allowlisted.some((allowed) => isPathWithin(allowed, candidate));
}

import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Settings } from "@fusion/core";
import type { WorktreeBackendKind } from "./worktree-backend.js";
import { canonicalizePath } from "./worktree-pool.js";

export function resolveWorktreesDir(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
): string {
  const configured = settings?.worktreesDir;
  if (!configured) {
    return join(rootDir, ".worktrees");
  }

  const expandedHome = configured.replace(/^~(?=$|[\\/])/, homedir());
  const expandedRepo = expandedHome.replaceAll("{repo}", basename(rootDir));
  return resolve(rootDir, expandedRepo);
}

export function resolveTaskWorktreePath(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  worktreeName: string,
): string {
  return join(resolveWorktreesDir(rootDir, settings), worktreeName);
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
): Promise<string> {
  if (backend.kind === "worktrunk" && backend.resolveWorktreePath) {
    return backend.resolveWorktreePath({ rootDir, worktreeName, branch });
  }
  return resolveTaskWorktreePath(rootDir, settings, worktreeName);
}

export function isInsideConfiguredWorktreesDir(
  rootDir: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  candidate: string,
): boolean {
  const worktreesDir = canonicalizePath(resolveWorktreesDir(rootDir, settings));
  const target = canonicalizePath(candidate);
  const rel = relative(worktreesDir, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

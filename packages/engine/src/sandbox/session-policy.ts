import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Settings } from "@fusion/core";
import type { SessionBoundaryDescriptor } from "../agents/agent-runtime.js";
import type { SandboxPolicy } from "./types.js";

/**
 * Derive the task-session policy from the declared single boundary root.
 * Repository worktree administration lives outside a linked worktree, so it
 * must be writable alongside that one task root for Git commits to work.
 */
export function resolveSessionSandboxPolicy(
  descriptor: SessionBoundaryDescriptor,
  settings: Pick<Settings, "sandbox"> | undefined,
): SandboxPolicy & { failureMode?: "fail-hard" | "fallback-native" } {
  const writableRoots = descriptor.writableRoot ? [descriptor.writableRoot] : [];
  for (const repo of descriptor.repoRoots ?? []) {
    const adminDir = resolveGitAdminDir(repo.repoRootDir);
    if (adminDir) writableRoots.push(adminDir);
  }

  return {
    allowNetwork: settings?.sandbox?.policy?.allowNetwork ?? true,
    failureMode: settings?.sandbox?.failureMode ?? "fail-hard",
    allowedReadPaths: [descriptor.projectRoot, ...(descriptor.repoRoots ?? []).map((repo) => repo.repoRootDir)],
    allowedWritePaths: writableRoots,
  };
}

function resolveGitAdminDir(repoRoot: string): string | null {
  const gitPath = resolve(repoRoot, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const contents = readFileSync(gitPath, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/m.exec(contents);
    return match ? resolve(dirname(gitPath), match[1]) : gitPath;
  } catch {
    return gitPath;
  }
}

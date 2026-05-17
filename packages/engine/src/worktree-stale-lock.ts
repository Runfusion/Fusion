import { exec } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 1024 * 1024;
const DEFAULT_MIN_AGE_MS = 30_000;

export class StaleWorktreeIndexLockError extends Error {
  readonly lockPath: string;
  readonly classification: Exclude<StaleLockClassification["kind"], "stale">;
  readonly reason: string;

  constructor(input: {
    message: string;
    lockPath: string;
    classification: Exclude<StaleLockClassification["kind"], "stale">;
    reason: string;
  }) {
    super(input.message);
    this.name = "StaleWorktreeIndexLockError";
    this.lockPath = input.lockPath;
    this.classification = input.classification;
    this.reason = input.reason;
  }
}

export function parseIndexLockPath(stderr: string): string | null {
  const match = /unable to create ['"]([^'"]*index\.lock)['"]:\s*File exists/i.exec(stderr);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function parseWorktreeNameFromLockPath(lockPath: string): string | null {
  const normalized = lockPath.replace(/\\/g, "/");
  const match = /\/worktrees\/([^/]+)\/index\.lock$/i.exec(normalized);
  if (!match) return null;
  return match[1] ?? null;
}

function parseWorktreeListPorcelain(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

async function resolveOwningWorktreePath(input: {
  rootDir: string;
  lockPath: string;
}): Promise<string | undefined> {
  if (input.lockPath.endsWith("/.git/index.lock") || input.lockPath.endsWith("\\.git\\index.lock")) {
    return input.rootDir;
  }

  const worktreeName = parseWorktreeNameFromLockPath(input.lockPath);
  if (!worktreeName) return undefined;

  const gitdirFile = resolve(dirname(input.lockPath), "gitdir");
  try {
    const gitdirRef = (await readFile(gitdirFile, "utf-8")).trim();
    if (gitdirRef) {
      const resolvedGitdirRef = resolve(dirname(gitdirFile), gitdirRef);
      if (resolvedGitdirRef.endsWith("/.git") || resolvedGitdirRef.endsWith("\\.git")) {
        return dirname(resolvedGitdirRef);
      }
      return dirname(resolvedGitdirRef);
    }
  } catch {
    // Fallback to porcelain mapping.
  }

  const { stdout } = await execAsync("git worktree list --porcelain", {
    cwd: input.rootDir,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    encoding: "utf-8",
  });

  const candidates = parseWorktreeListPorcelain(stdout);
  for (const path of candidates) {
    if (path.replace(/\\/g, "/").endsWith(`/${worktreeName}`)) {
      return path;
    }
  }

  return undefined;
}

export type StaleLockClassification = {
  kind: "stale" | "active-session" | "fresh" | "missing";
  reason: string;
  owningWorktreePath?: string;
  ageMs?: number;
};

export async function classifyStaleLock(input: {
  rootDir: string;
  lockPath: string;
  minAgeMs?: number;
  now?: () => number;
  activeSessionRegistry?: { lookupByPath(p: string): { taskId: string } | null };
}): Promise<StaleLockClassification> {
  const now = input.now ?? Date.now;
  const minAgeMs = input.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const normalizedLockPath = input.lockPath ? resolve(input.rootDir, input.lockPath) : null;
  if (!normalizedLockPath) {
    return { kind: "fresh", reason: "lock-path-unparseable" };
  }

  let lockStat;
  try {
    lockStat = await stat(normalizedLockPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return { kind: "missing", reason: "lock-file-missing" };
    }
    throw error;
  }

  const ageMs = Math.max(0, now() - lockStat.mtimeMs);
  if (ageMs < minAgeMs) {
    return { kind: "fresh", reason: "lock-younger-than-threshold", ageMs };
  }

  const owningWorktreePath = await resolveOwningWorktreePath({
    rootDir: input.rootDir,
    lockPath: normalizedLockPath,
  });

  if (owningWorktreePath && input.activeSessionRegistry?.lookupByPath(owningWorktreePath)) {
    return {
      kind: "active-session",
      reason: "active-session-owns-worktree",
      owningWorktreePath,
      ageMs,
    };
  }

  return {
    kind: "stale",
    reason: "lock-older-than-threshold-no-active-session",
    owningWorktreePath,
    ageMs,
  };
}

export async function tryRemoveStaleLock(input: { lockPath: string }): Promise<{ removed: boolean; reason?: string }> {
  try {
    await unlink(input.lockPath);
    return { removed: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return { removed: false, reason: "already-missing" };
    }
    throw error;
  }
}

/*
FNXC:MergerAiSplit 2026-06-25-00:00:
FN-7029 extracts AI-merge worktree lifecycle helpers from merger-ai.ts so the sole FN-5633 clean-room merge path stays under the 2000-line guardrail without changing cleanup semantics or public merger-ai.js exports.

FNXC:MergerAiSplit 2026-06-25-00:00:
Keep importing MIN_TEMP_WORKTREE_REAP_AGE_MS from self-healing.js here. Do not reverse the dependency: self-healing owns the stale-temp age policy and merger-ai-worktree only consumes it for pre-merge pruning, preserving the established self-healing import-cycle constraint.
*/
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { Settings } from "@fusion/core";

import { activeSessionRegistry } from "../agents/active-session-registry.js";
import type { RunAuditor } from "../util/run-audit.js";
import { MIN_TEMP_WORKTREE_REAP_AGE_MS } from "../self-healing.js";
import { resolveAiMergeRootPath, resolveLegacyAiMergeRootPath } from "../worktree/worktree-paths.js";
import { isBenignAbsentRemovalError, removeDirectoryWithRetry } from "../worktree/worktree-removal-retry.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string, opts: { timeout?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getErrorStringProperty(err: unknown, key: "stderr" | "code"): string | undefined {
  if (!err || typeof err !== "object" || !(key in err)) return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function describeCleanupError(err: unknown): string {
  const stderr = getErrorStringProperty(err, "stderr");
  const message = getErrorMessage(err);
  return stderr ? `${message}: ${stderr.trim()}` : message;
}

export function isBenignAbsentWorktreeError(err: unknown): boolean {
  return isBenignAbsentRemovalError(err);
}

function ensureAiMergeRootIgnored(projectRootDir: string, settings?: Settings): void {
  const excludePath = join(projectRootDir, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;
  try {
    const current = readFileSync(excludePath, "utf-8");
    const legacyAiMergeRoot = resolveLegacyAiMergeRootPath(projectRootDir);
    const legacyRelativeAiMergeRoot = relative(projectRootDir, legacyAiMergeRoot);
    const entries = [`${legacyRelativeAiMergeRoot.replaceAll("\\", "/")}/`];
    const aiMergeRoot = resolveAiMergeRootPath(projectRootDir, settings);
    const relativeAiMergeRoot = relative(projectRootDir, aiMergeRoot);
    if (relativeAiMergeRoot && !relativeAiMergeRoot.startsWith("..") && !isAbsolute(relativeAiMergeRoot)) {
      entries.push(`${relativeAiMergeRoot.replaceAll("\\", "/")}/`);
    }

    const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
    if (missing.length > 0) {
      appendFileSync(excludePath, `${current.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
    }
  } catch {
    // Best effort only: cleanup still removes the root contents, and existing
    // projects generally ignore .fusion already.
  }
}

export function resolveAiMergeRoot(projectRootDir: string, settings?: Settings): string {
  const root = resolveAiMergeRootPath(projectRootDir, settings);
  mkdirSync(root, { recursive: true });
  ensureAiMergeRootIgnored(projectRootDir, settings);
  return root;
}

function getAiMergeTempSearchRoots(projectRootDir: string, settings?: Settings): string[] {
  const roots = [resolveAiMergeRoot(projectRootDir, settings), resolveLegacyAiMergeRootPath(projectRootDir), tmpdir()];
  const testWorkerRoot = process.env.FUSION_TEST_WORKER_ROOT;
  if (testWorkerRoot) {
    try {
      for (const entry of readdirSync(testWorkerRoot)) {
        if (entry.startsWith("redir-")) roots.push(join(testWorkerRoot, entry));
      }
    } catch {
      // Best effort for the test harness' bounded temp-dir redirection root.
    }
  }
  return Array.from(new Set(roots));
}

export async function pruneExistingAiMergeWorktrees(
  taskId: string,
  projectRootDir: string,
  audit: RunAuditor,
  log: (message: string) => Promise<void>,
  settings?: Settings,
): Promise<number> {
  const prefix = `fusion-ai-merge-${taskId.toLowerCase()}-`;
  const tempRoots = getAiMergeTempSearchRoots(projectRootDir, settings);

  let pruned = 0;
  let cleanupAttempted = false;
  for (const tempRoot of tempRoots) {
    let entries: string[];
    try {
      entries = readdirSync(tempRoot).filter((entry) => entry.startsWith(prefix));
    } catch (err: unknown) {
      /*
      FNXC:AiMerge 2026-06-24-23:10:
      An absent ai-merge search root is the NORMAL case, not an error: the clean-room directory
      (e.g. `<repo>/.fusion/ai-merge`) is created lazily only when an AI-merge worktree is made, so a
      workspace sub-repo that has never been AI-merged has no such dir. ENOENT therefore means
      "nothing to prune" — skip it silently rather than emitting an alarming warning on every merge.
      Only non-ENOENT failures are surfaced, and only a non-ENOENT failure on the system tmpdir
      (which always exists) remains fatal.
      */
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      await log(`AI merge pre-merge prune: failed to read ${tempRoot}: ${getErrorMessage(err)}`);
      if (tempRoot === tmpdir()) throw err;
      continue;
    }

    for (const entry of entries) {
      const candidatePath = join(tempRoot, entry);
      let canonicalPath = candidatePath;
      try {
        canonicalPath = realpathSync(candidatePath);
      } catch {
        canonicalPath = candidatePath;
      }

      if (activeSessionRegistry.isPathActive(canonicalPath) || activeSessionRegistry.isPathActive(candidatePath)) {
        await log(`AI merge pre-merge prune: skipping active worktree ${canonicalPath}`);
        continue;
      }

      try {
        const stat = statSync(canonicalPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < MIN_TEMP_WORKTREE_REAP_AGE_MS) {
          await log(`AI merge pre-merge prune: skipping too-new worktree ${canonicalPath} (age ${Math.max(0, Math.round(ageMs))}ms)`);
          continue;
        }
      } catch (err: unknown) {
        await log(`AI merge pre-merge prune: failed to stat ${canonicalPath}: ${getErrorMessage(err)} — skipping candidate`);
        continue;
      }

      let alreadyAbsent = false;
      try {
        cleanupAttempted = true;
        await execFileAsync("git", ["worktree", "remove", "--force", canonicalPath], {
          cwd: projectRootDir,
          timeout: 30_000,
        });
      } catch (err: unknown) {
        if (isBenignAbsentWorktreeError(err)) {
          alreadyAbsent = true;
          await log(`AI merge pre-merge prune: worktree ${canonicalPath} was already absent/de-registered; treating cleanup as idempotent`);
        } else {
          await log(`AI merge pre-merge prune: git worktree remove failed for ${canonicalPath}: ${describeCleanupError(err)} — falling back to filesystem removal`);
        }
      }

      /*
      FNXC:AiMerge 2026-08-20-02:04:
      This cleanup has already passed active-session and age guards. Retry only the filesystem operation: a residual directory stays registered because plain git prune can reclaim an admin entry only after its path is gone.
      */
      cleanupAttempted = true;
      const removal = await removeDirectoryWithRetry({
        path: canonicalPath,
        rm: (path, options) => rmSync(path, options),
        log: (message) => void log(`AI merge pre-merge prune: ${message}`),
      });
      if (removal.removed) {
        const idempotent = alreadyAbsent || removal.benignAbsent;
        if (removal.benignAbsent) await log(`AI merge pre-merge prune: worktree ${canonicalPath} was already absent during filesystem cleanup; treating cleanup as idempotent`);
        await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalPath, metadata: { taskId, mergeRoot: canonicalPath, phase: "pre-merge-prune", success: true, ...(idempotent ? { alreadyAbsent: true, idempotent: true } : {}) } });
        pruned++;
      } else {
        await log(`AI merge pre-merge prune: filesystem rm failed for ${canonicalPath}${removal.lastCode ? ` (${removal.lastCode})` : ""}: ${removal.lastError ?? "unknown error"}`);
        await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalPath, metadata: { taskId, mergeRoot: canonicalPath, phase: "pre-merge-prune", success: false, error: removal.lastError ?? "unknown error", attempts: removal.attempts, residual: true, registrationRetained: true, ...(removal.lastCode ? { code: removal.lastCode } : {}) } });
      }
    }
  }

  if (cleanupAttempted) {
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd: projectRootDir, timeout: 30_000 });
    } catch (err: unknown) {
      await log(`AI merge pre-merge prune: git worktree prune failed: ${describeCleanupError(err)}`);
    }
  }

  return pruned;
}

export async function cleanupAiMergeWorktree(input: {
  taskId: string;
  mergeRoot: string;
  projectRootDir: string;
  worktreeAdded: boolean;
  audit: RunAuditor;
  log: (message: string) => Promise<void>;
  gitRunner?: typeof git;
  rmRunner?: typeof rm;
}): Promise<void> {
  const { taskId, mergeRoot, projectRootDir, worktreeAdded, audit, log, gitRunner = git, rmRunner = rm } = input;
  let canonicalRoot = mergeRoot;
  try {
    canonicalRoot = realpathSync(mergeRoot);
  } catch {
    canonicalRoot = mergeRoot;
  }
  const removalTargets = canonicalRoot === mergeRoot ? [mergeRoot] : [canonicalRoot, mergeRoot];
  const cleanupMetadata = { taskId, mergeRoot: canonicalRoot, requestedMergeRoot: mergeRoot };
  let alreadyAbsent = false;

  if (worktreeAdded) {
    /*
    FNXC:AiMerge 2026-08-20-03:08:
    A missing clean room can still have a Git registration, so invoke Git even when the path is absent. Its authoritative "is not a working tree" response must reach the shared benign classifier before the one-attempt ENOENT filesystem confirmation and unconditional prune reclaim the stale registration.
    */
    try {
      await gitRunner(["worktree", "remove", "--force", canonicalRoot], projectRootDir);
      await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-remove", success: true } });
    } catch (err: unknown) {
      const error = describeCleanupError(err);
      const code = getErrorStringProperty(err, "code");
      if (isBenignAbsentWorktreeError(err)) {
        alreadyAbsent = true;
        await log(`AI merge cleanup: worktree ${canonicalRoot} was already absent/de-registered during git removal; treating cleanup as idempotent`);
        await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-remove", success: true, alreadyAbsent: true, idempotent: true, error, ...(code ? { code } : {}) } });
      } else {
        await log(`AI merge cleanup: git worktree remove failed for ${canonicalRoot}${code ? ` (${code})` : ""}: ${error}`);
        await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-remove", success: false, error, ...(code ? { code } : {}) } });
      }
    }
  }

  let removedFromFilesystem = false;
  for (const target of removalTargets) {
    /*
    FNXC:AiMerge 2026-08-20-02:04:
    The inline owner may retry a just-used clean room, but it must preserve its target-order and audit phases. A stale Git registration is benign only for this idempotent cleanup path, never a reason to bypass filesystem liveness policy elsewhere.
    */
    const removal = await removeDirectoryWithRetry({
      path: target,
      rm: rmRunner,
      log: (message) => void log(`AI merge cleanup: ${message}`),
    });
    if (removal.removed) {
      const idempotent = alreadyAbsent || removal.benignAbsent;
      if (removal.benignAbsent) await log(`AI merge cleanup: worktree ${target} was already absent during filesystem cleanup; treating cleanup as idempotent`);
      await audit.git({ type: "merge:ai-worktree-cleanup", target, metadata: { ...cleanupMetadata, phase: "fs-rm", path: target, success: true, ...(idempotent ? { alreadyAbsent: true, idempotent: true } : {}) } });
      removedFromFilesystem = true;
      break;
    }
    await log(`AI merge cleanup: filesystem rm failed for ${target}${removal.lastCode ? ` (${removal.lastCode})` : ""}: ${removal.lastError ?? "unknown error"}`);
    await audit.git({ type: "merge:ai-worktree-cleanup", target, metadata: { ...cleanupMetadata, phase: "fs-rm", path: target, success: false, error: removal.lastError ?? "unknown error", attempts: removal.attempts, residual: true, registrationRetained: true, ...(removal.lastCode ? { code: removal.lastCode } : {}) } });
  }

  if (!removedFromFilesystem) {
    await log(`AI merge cleanup: filesystem cleanup did not remove ${canonicalRoot}; continuing to prune worktree metadata`);
  }

  try {
    await gitRunner(["worktree", "prune"], projectRootDir, { timeout: 30_000 });
    await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-prune", success: true } });
  } catch (err: unknown) {
    const error = describeCleanupError(err);
    const code = getErrorStringProperty(err, "code");
    await log(`AI merge cleanup: git worktree prune failed after removing ${canonicalRoot}${code ? ` (${code})` : ""}: ${error}`);
    await audit.git({ type: "merge:ai-worktree-cleanup", target: canonicalRoot, metadata: { ...cleanupMetadata, phase: "git-prune", success: false, error, ...(code ? { code } : {}) } });
  }

}

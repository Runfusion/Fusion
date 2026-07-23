import { constants as fsConstants } from "node:fs";
import { access, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { RunAuditor } from "../util/run-audit.js";

export type WorktreeCopyFileSkipReason =
  | "blank"
  | "duplicate"
  | "absolute-path"
  | "path-traversal"
  | "missing"
  | "non-regular"
  | "unreadable"
  | "copy-failed";

export interface WorktreeCopyFileResult {
  path: string;
  sourcePath?: string;
  destinationPath?: string;
  outcome: "copied" | "skipped";
  reason?: WorktreeCopyFileSkipReason;
  error?: string;
}

export interface CopyConfiguredWorktreeFilesOptions {
  rootDir: string;
  worktreePath: string;
  paths?: readonly string[];
  taskId?: string;
  logger?: { log?: (message: string) => void; warn?: (message: string) => void };
  audit?: Pick<RunAuditor, "filesystem">;
}

function isInsideRoot(rootDir: string, candidate: string): boolean {
  const rel = relative(rootDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function auditCopyResult(
  audit: Pick<RunAuditor, "filesystem"> | undefined,
  taskId: string | undefined,
  result: WorktreeCopyFileResult,
): Promise<void> {
  try {
    await audit?.filesystem({
      type: result.outcome === "copied" ? "worktree:copy-file" : "worktree:copy-file-skipped",
      target: taskId ?? result.path,
      metadata: {
        path: result.path,
        outcome: result.outcome,
        reason: result.reason,
        error: result.error,
      },
    });
  } catch {
    // Best-effort observability only; copy decisions must not fail acquisition.
  }
}

/**
 * FNXC:WorktreeCopyFiles 2026-06-24-00:00:
 * Configured copy files may contain secrets, so the engine copies only root-relative regular files, never shells out, never logs contents, and treats missing/non-file/unreadable entries as non-fatal setup diagnostics for newly prepared worktrees.
 */
export async function copyConfiguredWorktreeFiles(options: CopyConfiguredWorktreeFilesOptions): Promise<WorktreeCopyFileResult[]> {
  const { rootDir, worktreePath, paths = [], taskId, logger, audit } = options;
  const root = resolve(rootDir);
  const worktreeRoot = resolve(worktreePath);
  const seen = new Set<string>();
  const results: WorktreeCopyFileResult[] = [];

  for (const rawPath of paths) {
    const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!trimmed) {
      const result: WorktreeCopyFileResult = { path: trimmed, outcome: "skipped", reason: "blank" };
      results.push(result);
      await auditCopyResult(audit, taskId, result);
      continue;
    }

    const normalizedKey = trimmed.replace(/\\/g, "/");
    if (seen.has(normalizedKey)) {
      const result: WorktreeCopyFileResult = { path: trimmed, outcome: "skipped", reason: "duplicate" };
      results.push(result);
      await auditCopyResult(audit, taskId, result);
      continue;
    }
    seen.add(normalizedKey);

    if (isAbsolute(trimmed)) {
      const result: WorktreeCopyFileResult = { path: trimmed, outcome: "skipped", reason: "absolute-path" };
      logger?.warn?.(`${taskId ?? "worktree"}: skipped configured worktree copy file ${trimmed}: absolute paths are not allowed`);
      results.push(result);
      await auditCopyResult(audit, taskId, result);
      continue;
    }

    const sourcePath = resolve(root, trimmed);
    const destinationPath = resolve(worktreeRoot, trimmed);
    if (!isInsideRoot(root, sourcePath) || !isInsideRoot(worktreeRoot, destinationPath)) {
      const result: WorktreeCopyFileResult = { path: trimmed, sourcePath, destinationPath, outcome: "skipped", reason: "path-traversal" };
      logger?.warn?.(`${taskId ?? "worktree"}: skipped configured worktree copy file ${trimmed}: path escapes repository root`);
      results.push(result);
      await auditCopyResult(audit, taskId, result);
      continue;
    }

    try {
      const sourceStat = await lstat(sourcePath);
      if (!sourceStat.isFile()) {
        const result: WorktreeCopyFileResult = { path: trimmed, sourcePath, destinationPath, outcome: "skipped", reason: "non-regular" };
        logger?.warn?.(`${taskId ?? "worktree"}: skipped configured worktree copy file ${trimmed}: source is not a regular file`);
        results.push(result);
        await auditCopyResult(audit, taskId, result);
        continue;
      }
      await access(sourcePath, fsConstants.R_OK);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
      const reason: WorktreeCopyFileSkipReason = code === "ENOENT" ? "missing" : "unreadable";
      const result: WorktreeCopyFileResult = { path: trimmed, sourcePath, destinationPath, outcome: "skipped", reason, error: safeError(error) };
      logger?.warn?.(`${taskId ?? "worktree"}: skipped configured worktree copy file ${trimmed}: ${reason}`);
      results.push(result);
      await auditCopyResult(audit, taskId, result);
      continue;
    }

    try {
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      const result: WorktreeCopyFileResult = { path: trimmed, sourcePath, destinationPath, outcome: "copied" };
      logger?.log?.(`${taskId ?? "worktree"}: copied configured worktree file ${trimmed}`);
      results.push(result);
      await auditCopyResult(audit, taskId, result);
    } catch (error) {
      const result: WorktreeCopyFileResult = { path: trimmed, sourcePath, destinationPath, outcome: "skipped", reason: "copy-failed", error: safeError(error) };
      logger?.warn?.(`${taskId ?? "worktree"}: skipped configured worktree copy file ${trimmed}: copy failed`);
      results.push(result);
      await auditCopyResult(audit, taskId, result);
    }
  }

  return results;
}

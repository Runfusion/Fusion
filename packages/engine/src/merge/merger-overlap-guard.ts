import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { mergerLog } from "../logger.js";
import {
  listRecentMainCommits,
  MERGER_MAIN_OVERLAP_LOOKBACK_COMMITS,
  normalizeMergeOverlapLookback,
} from "./merger-squash-audit.js";

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;

export interface DetectMergeOverlapResult {
  overlappingFiles: string[];
  recentMainCommitsByFile: Map<string, string[]>;
}

export async function getBranchTouchedFiles({
  rootDir,
  branch,
  baseRef,
}: {
  rootDir: string;
  branch: string;
  baseRef?: string;
}): Promise<string[]> {
  if (!branch.trim()) {
    return [];
  }

  const diffRange = baseRef?.trim() ? `${baseRef.trim()}...${branch}` : `${branch}~1...${branch}`;
  const files = await gitLines(rootDir, ["diff", "--name-only", diffRange], "branch touched-files");
  return Array.from(new Set(files));
}

export async function getRecentMainTouchedFiles({
  rootDir,
  mergeTargetBranch,
  lookback = MERGER_MAIN_OVERLAP_LOOKBACK_COMMITS,
}: {
  rootDir: string;
  mergeTargetBranch: string;
  lookback?: number;
}): Promise<Map<string, string[]>> {
  const recentMainCommitsByFile = new Map<string, string[]>();
  const normalizedLookback = normalizeMergeOverlapLookback(lookback);
  const recentMainCommits = await listRecentMainCommits(rootDir, mergeTargetBranch, normalizedLookback)
    .catch((error) => {
      mergerLog.warn(`overlap guard: failed to read recent main commits: ${formatErrorMessage(error)}`);
      return [];
    });

  for (const { sha: commitSha } of recentMainCommits) {
    const touchedFiles = await gitLines(
      rootDir,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha],
      `main touched-files for ${commitSha.slice(0, 8)}`,
    );

    for (const file of touchedFiles) {
      const existing = recentMainCommitsByFile.get(file) ?? [];
      existing.push(commitSha);
      recentMainCommitsByFile.set(file, existing);
    }
  }

  return recentMainCommitsByFile;
}

export async function detectMergeOverlap({
  rootDir,
  branch,
  baseRef,
  mergeTargetBranch,
  lookback = MERGER_MAIN_OVERLAP_LOOKBACK_COMMITS,
}: {
  rootDir: string;
  branch: string;
  baseRef?: string;
  mergeTargetBranch: string;
  lookback?: number;
}): Promise<DetectMergeOverlapResult> {
  const [branchTouchedFiles, recentMainCommitsByFile] = await Promise.all([
    getBranchTouchedFiles({ rootDir, branch, baseRef }),
    getRecentMainTouchedFiles({ rootDir, mergeTargetBranch, lookback }),
  ]);

  const overlappingFiles = branchTouchedFiles
    .filter((file) => recentMainCommitsByFile.has(file))
    .sort((a, b) => a.localeCompare(b));

  const overlapCommits = new Map<string, string[]>();
  for (const file of overlappingFiles) {
    overlapCommits.set(file, [...(recentMainCommitsByFile.get(file) ?? [])]);
  }

  return {
    overlappingFiles,
    recentMainCommitsByFile: overlapCommits,
  };
}

export async function restoreBranchWinsFiles({
  rootDir,
  branch,
  files,
}: {
  rootDir: string;
  branch: string;
  files: Iterable<string>;
}): Promise<void> {
  for (const file of files) {
    const branchHasFile = await gitExitCode(rootDir, ["cat-file", "-e", `${branch}:${file}`]) === 0;
    if (branchHasFile) {
      await gitRun(rootDir, ["checkout", branch, "--", file], `restore branch version for ${file}`);
      await gitRun(rootDir, ["add", "--", file], `stage branch version for ${file}`);
    } else {
      await gitRun(rootDir, ["rm", "--force", "--ignore-unmatch", "--", file], `stage branch deletion for ${file}`);
    }
  }
}

async function gitLines(rootDir: string, args: string[], context: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    });
    return normalizeLines(stdout);
  } catch (error) {
    mergerLog.warn(`overlap guard: failed to read ${context}: ${formatErrorMessage(error)}`);
    return [];
  }
}

function normalizeLines(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function gitRun(rootDir: string, args: string[], context: string): Promise<void> {
  try {
    await execFileAsync("git", args, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    });
  } catch (error) {
    mergerLog.warn(`overlap guard: failed to ${context}: ${formatErrorMessage(error)}`);
    throw error;
  }
}

async function gitExitCode(rootDir: string, args: string[]): Promise<number> {
  try {
    await execFileAsync("git", args, {
      cwd: rootDir,
      encoding: "utf-8",
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    });
    return 0;
  } catch {
    return 1;
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface BranchConflictCommit {
  sha: string;
  subject: string;
}

export interface BranchRecoveryCandidate {
  branchName: string;
  tipSha: string;
  worktreePath: string | null;
  strandedCommits: BranchConflictCommit[];
  isCanonical: boolean;
}

export interface BranchConflictDetails {
  branchName: string;
  conflictingWorktreePath: string;
  existingTipSha: string;
  strandedCommits: BranchConflictCommit[];
  startPoint: string;
  recommendedAction: string;
}

export class BranchConflictError extends Error implements BranchConflictDetails {
  readonly name = "BranchConflictError";
  readonly branchName: string;
  readonly conflictingWorktreePath: string;
  readonly existingTipSha: string;
  readonly strandedCommits: BranchConflictCommit[];
  readonly startPoint: string;
  readonly recommendedAction: string;

  constructor(details: BranchConflictDetails) {
    const commitSummary = details.strandedCommits.length > 0
      ? `${details.strandedCommits.length} stranded commit${details.strandedCommits.length === 1 ? "" : "s"}`
      : "no stranded commits";
    super(
      `Branch ${details.branchName} is already checked out at ${details.conflictingWorktreePath} ` +
      `(tip ${details.existingTipSha.slice(0, 12)}, ${commitSummary} since ${details.startPoint}). ` +
      details.recommendedAction,
    );
    this.branchName = details.branchName;
    this.conflictingWorktreePath = details.conflictingWorktreePath;
    this.existingTipSha = details.existingTipSha;
    this.strandedCommits = details.strandedCommits;
    this.startPoint = details.startPoint;
    this.recommendedAction = details.recommendedAction;
  }
}

export function isBranchConflictError(error: unknown): error is BranchConflictError {
  return error instanceof BranchConflictError;
}

export interface InspectBranchConflictInput {
  repoDir: string;
  branchName: string;
  conflictingWorktreePath: string;
  startPoint?: string;
}

export type BranchConflictInspectionResult =
  | { kind: "stale" }
  | { kind: "live"; error: BranchConflictError };

export interface ListBranchRecoveryCandidatesInput {
  repoDir: string;
  branchName: string;
  startPoint?: string;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runGit(repoDir: string, command: string): Promise<string> {
  const { stdout } = await execAsync(command, {
    cwd: repoDir,
    encoding: "utf-8",
  });
  return stdout.trim();
}

async function revParse(repoDir: string, ref: string): Promise<string> {
  return runGit(repoDir, `git rev-parse --verify ${quoteShellArg(`${ref}^{commit}`)}`);
}

async function listStrandedCommits(repoDir: string, startPoint: string, branchName: string): Promise<BranchConflictCommit[]> {
  try {
    const output = await runGit(
      repoDir,
      `git log --reverse --format=%H%x09%s ${quoteShellArg(`${startPoint}..${branchName}`)}`,
    );
    if (!output) return [];
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subjectParts] = line.split("\t");
        return { sha, subject: subjectParts.join("\t") };
      });
  } catch {
    return [];
  }
}

async function getWorktreeBranchMap(repoDir: string): Promise<Map<string, string>> {
  const output = await runGit(repoDir, "git worktree list --porcelain");
  const map = new Map<string, string>();
  let currentWorktree: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentWorktree = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch refs/heads/") && currentWorktree) {
      map.set(line.slice("branch refs/heads/".length).trim(), currentWorktree);
    }
    if (!line.trim()) {
      currentWorktree = null;
    }
  }

  return map;
}

function parseBranchNames(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function listBranchRecoveryCandidates(
  input: ListBranchRecoveryCandidatesInput,
): Promise<BranchRecoveryCandidate[]> {
  const { repoDir, branchName } = input;
  const startPoint = input.startPoint ?? "HEAD";
  const [branchListOutput, worktreeBranches] = await Promise.all([
    runGit(
      repoDir,
      `git for-each-ref --format='%(refname:short)' refs/heads/${branchName} refs/heads/${branchName}-*`,
    ),
    getWorktreeBranchMap(repoDir),
  ]);

  const candidates: BranchRecoveryCandidate[] = [];
  for (const candidateName of parseBranchNames(branchListOutput)) {
    const tipSha = await revParse(repoDir, candidateName);
    const strandedCommits = await listStrandedCommits(repoDir, startPoint, candidateName);
    candidates.push({
      branchName: candidateName,
      tipSha,
      worktreePath: worktreeBranches.get(candidateName) ?? null,
      strandedCommits,
      isCanonical: candidateName === branchName,
    });
  }

  candidates.sort((left, right) => {
    if (left.branchName === branchName) return -1;
    if (right.branchName === branchName) return 1;
    return left.branchName.localeCompare(right.branchName);
  });

  return candidates;
}

export async function inspectBranchConflict(
  input: InspectBranchConflictInput,
): Promise<BranchConflictInspectionResult> {
  const startPoint = input.startPoint ?? "HEAD";
  if (!existsSync(input.conflictingWorktreePath)) {
    return { kind: "stale" };
  }

  const existingTipSha = await revParse(input.repoDir, input.branchName);
  const strandedCommits = await listStrandedCommits(input.repoDir, startPoint, input.branchName);

  return {
    kind: "live",
    error: new BranchConflictError({
      branchName: input.branchName,
      conflictingWorktreePath: input.conflictingWorktreePath,
      existingTipSha,
      strandedCommits,
      startPoint,
      recommendedAction: "Reclaim the existing task branch/worktree or explicitly discard prior work before retrying.",
    }),
  };
}

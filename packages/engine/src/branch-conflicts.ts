import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const FUSION_TASK_ID_TRAILER_KEY = "Fusion-Task-Id";

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
  requestingTaskId: string;
  startPoint?: string;
}

export type BranchConflictInspectionResult =
  | { kind: "stale" }
  | { kind: "stale-resolved" }
  | { kind: "reclaimable"; livePath: string; tipSha: string; taskAttributedCommitCount: number; strandedCommits: BranchConflictCommit[] }
  | { kind: "live-foreign"; livePath: string }
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

async function countTaskAttributedCommits(repoDir: string, range: string, taskId: string): Promise<number> {
  const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const subjectPattern = new RegExp(`^(feat|fix|test|chore|docs|refactor|perf|build)\\(${escapedTaskId}\\):`);
  const trailerPattern = new RegExp(`(?:^|\\n)${FUSION_TASK_ID_TRAILER_KEY}: ${escapedTaskId}(?:\\n|$)`);
  let output = "";
  try {
    output = await runGit(repoDir, `git log --format=%H%x00%s%x00%b ${quoteShellArg(range)}`);
  } catch {
    return 0;
  }
  if (!output) return 0;

  const tokens = output.split("\u0000");
  let count = 0;
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const subject = tokens[i + 1] ?? "";
    const body = tokens[i + 2] ?? "";
    if (subjectPattern.test(subject) || trailerPattern.test(body)) {
      count += 1;
    }
  }
  return count;
}

export async function inspectBranchConflict(
  input: InspectBranchConflictInput,
): Promise<BranchConflictInspectionResult> {
  const startPoint = input.startPoint ?? "HEAD";
  if (!existsSync(input.conflictingWorktreePath)) {
    return { kind: "stale" };
  }

  try {
    await runGit(input.repoDir, "git worktree prune");
  } catch {
    // best-effort
  }

  const worktreeMap = await getWorktreeBranchMap(input.repoDir);
  const livePath = worktreeMap.get(input.branchName);

  try {
    await revParse(input.repoDir, `refs/heads/${input.branchName}`);
  } catch {
    return { kind: "stale-resolved" };
  }

  if (!livePath) {
    return { kind: "stale-resolved" };
  }

  if (livePath !== input.conflictingWorktreePath) {
    const tipSha = await revParse(input.repoDir, input.branchName);
    const strandedCommits = await listStrandedCommits(input.repoDir, startPoint, input.branchName);
    const taskAttributedCommitCount = await countTaskAttributedCommits(
      input.repoDir,
      `${startPoint}..${input.branchName}`,
      input.requestingTaskId,
    );
    if (taskAttributedCommitCount > 0) {
      return {
        kind: "reclaimable",
        livePath,
        tipSha,
        taskAttributedCommitCount,
        strandedCommits,
      };
    }
    return { kind: "live-foreign", livePath };
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

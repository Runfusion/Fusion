/**
 * FNXC:CodeOrganization 2026-08-03-13:35:
 * Pure branch-conflict log formatters peeled from TaskExecutor (U4).
 */
import type { BranchConflictError } from "../execution/branch-conflicts.js";

export function formatBranchConflictLifecycleLog(_taskId: string, error: BranchConflictError): string {
  const strandedSummary = error.strandedCommits.length > 0
    ? error.strandedCommits.map((commit) => `${commit.sha.slice(0, 12)} ${commit.subject}`).join("; ")
    : "none";
  const recommendation = "Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.";
  return [
    `Branch conflict: ${error.branchName} is already checked out at ${error.conflictingWorktreePath}`,
    `Existing tip: ${error.existingTipSha}`,
    `Stranded commits since ${error.startPoint}: ${strandedSummary}`,
    recommendation,
  ].join("\n");
}

export function formatBranchConflictAgentLog(_taskId: string, error: BranchConflictError): string {
  const lines = [
    `branch=${error.branchName}`,
    `worktree=${error.conflictingWorktreePath}`,
    `existingTipSha=${error.existingTipSha}`,
    `startPoint=${error.startPoint}`,
  ];
  if (error.strandedCommits.length > 0) {
    lines.push(
      ...error.strandedCommits.map((commit) => `stranded=${commit.sha.slice(0, 12)} ${commit.subject}`),
    );
  } else {
    lines.push("stranded=none");
  }
  lines.push(
    `recommendation=Resolve the local branch/worktree conflict with git tooling (inspect/reclaim or discard) before retrying.`,
  );
  return lines.join("\n");
}

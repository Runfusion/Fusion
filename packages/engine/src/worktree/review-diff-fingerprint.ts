/*
FNXC:ReviewConvergence 2026-08-22-05:35:
FN-149 compares review rounds by the binary patch the reviewer received. Both singular and workspace
reviews use this helper so an unchanged code loop has one durable, content-addressed definition.
*/
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReviewDiffFingerprintProbe =
  | { state: "fingerprint"; fingerprint: string }
  | { state: "empty" }
  | { state: "unavailable"; reason: string };

export type ReviewChangesSinceCommitProbe =
  | { state: "frozen"; commitCount: 0 }
  | {
    state: "changed";
    commitCount: number;
    changedFiles: string[];
    totalChangedFileCount: number;
    shortstat?: string;
  }
  | { state: "unavailable"; reason: string };

export const MAX_REVIEW_CHANGED_FILES = 100;

export const EMPTY_REVIEW_DIFF_FINGERPRINT = "empty-review-input:v1";

/*
FNXC:MergeContentDescriptor 2026-08-23-07:12:
FN-180's positive merge gate must distinguish an empty patch from an unreadable
one. The legacy helper keeps its lossy signature for existing callers; merge
admission uses this probe and fails closed on unavailable Git evidence.
*/
/*
FNXC:WorkspaceReviewFingerprint 2026-08-23-08:32:
FN-180 must compare a workspace repository's approved base-to-task-branch patch even when its
checkout remains on the integration branch. The optional target ref preserves singular HEAD callers
while preventing a clean checkout from being mistaken for an empty reviewed branch.
*/
export async function probeReviewDiffFingerprint(worktreePath: string | undefined, baseRef: string | undefined, targetRef = "HEAD"): Promise<ReviewDiffFingerprintProbe> {
  if (!worktreePath || !baseRef) return { state: "unavailable", reason: "missing-worktree-or-base" };
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--binary", `${baseRef}..${targetRef}`], { cwd: worktreePath, encoding: "utf8" });
    return stdout
      ? { state: "fingerprint", fingerprint: createHash("sha256").update(stdout).digest("hex") }
      : { state: "empty" };
  } catch {
    return { state: "unavailable", reason: "git-diff-failed" };
  }
}

/*
FNXC:ReviewConvergence 2026-08-28-10:57:
A same-gate review needs Git-derived evidence of what landed after the commit its previous round
inspected. Keep the file list bounded for prompt safety, and report unreadable evidence as unavailable
rather than inventing progress or a frozen tree.
*/
export async function probeReviewChangesSinceCommit(
  worktreePath: string | undefined,
  reviewedCommitSha: string | undefined,
): Promise<ReviewChangesSinceCommitProbe> {
  if (!worktreePath || !reviewedCommitSha) {
    return { state: "unavailable", reason: "missing-worktree-or-reviewed-commit" };
  }

  try {
    await execFileAsync("git", ["cat-file", "-e", `${reviewedCommitSha}^{commit}`], {
      cwd: worktreePath,
      encoding: "utf8",
    });
    const [{ stdout: countOutput }, { stdout: filesOutput }, { stdout: shortstatOutput }] = await Promise.all([
      execFileAsync("git", ["rev-list", "--count", `${reviewedCommitSha}..HEAD`], { cwd: worktreePath, encoding: "utf8" }),
      execFileAsync("git", ["diff", "--name-only", "-z", `${reviewedCommitSha}..HEAD`], { cwd: worktreePath, encoding: "utf8" }),
      execFileAsync("git", ["diff", "--shortstat", `${reviewedCommitSha}..HEAD`], { cwd: worktreePath, encoding: "utf8" }),
    ]);
    const commitCount = Number.parseInt(countOutput.trim(), 10);
    if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
      return { state: "unavailable", reason: "invalid-commit-count" };
    }
    if (commitCount === 0) return { state: "frozen", commitCount: 0 };

    const allChangedFiles = filesOutput.split("\0").filter(Boolean);
    const shortstat = shortstatOutput.trim() || undefined;
    return {
      state: "changed",
      commitCount,
      changedFiles: allChangedFiles.slice(0, MAX_REVIEW_CHANGED_FILES),
      totalChangedFileCount: allChangedFiles.length,
      ...(shortstat ? { shortstat } : {}),
    };
  } catch {
    return { state: "unavailable", reason: "git-changes-since-review-failed" };
  }
}

/** Returns no signal for an absent/empty/unreadable diff; a failed probe must never invent progress. */
export async function computeReviewDiffFingerprint(worktreePath: string | undefined, baseRef: string | undefined, targetRef = "HEAD"): Promise<string | undefined> {
  const result = await probeReviewDiffFingerprint(worktreePath, baseRef, targetRef);
  return result.state === "fingerprint" ? result.fingerprint : undefined;
}

/*
FNXC:ReviewEmptyContent 2026-08-28-13:14:
A provably empty Code Review diff is a definite input, not missing evidence. Collapsing it into
undefined made unchanged-review convergence permanently blind for tasks with no changes, while an
unreadable Git diff must remain unavailable and fail closed.
*/
export async function computeCodeReviewInputFingerprint(
  worktreePath: string | undefined,
  baseRef: string | undefined,
  targetRef = "HEAD",
): Promise<string | undefined> {
  const result = await probeReviewDiffFingerprint(worktreePath, baseRef, targetRef);
  if (result.state === "empty") return EMPTY_REVIEW_DIFF_FINGERPRINT;
  return result.state === "fingerprint" ? result.fingerprint : undefined;
}

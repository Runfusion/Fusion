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

/** Returns no signal for an absent/empty/unreadable diff; a failed probe must never invent progress. */
export async function computeReviewDiffFingerprint(worktreePath: string | undefined, baseRef: string | undefined, targetRef = "HEAD"): Promise<string | undefined> {
  const result = await probeReviewDiffFingerprint(worktreePath, baseRef, targetRef);
  return result.state === "fingerprint" ? result.fingerprint : undefined;
}

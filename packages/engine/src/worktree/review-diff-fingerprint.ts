/*
FNXC:ReviewConvergence 2026-08-22-05:35:
FN-149 compares review rounds by the binary patch the reviewer received. Both singular and workspace
reviews use this helper so an unchanged code loop has one durable, content-addressed definition.
*/
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Returns no signal for an absent/empty/unreadable diff; a failed probe must never invent progress.
 *
 * FNXC:ReviewConvergence 2026-08-23-21:55:
 * `headRef` defaults to ambient `HEAD` for the singular-review caller, whose worktree IS the task
 * branch. Workspace evidence must pass the RESOLVED task branch instead: a workspace entry may point
 * at a repository checkout sitting on the integration branch, where `base..HEAD` measures main's
 * divergence (or nothing at all) rather than the branch payload the reviewer saw. That mismatch made
 * the fingerprint disagree with the `files` list captured beside it — an approved repository either
 * hard-failed as `content-changed` against main's own commits, or (when the checkout equalled the
 * base) produced an undefined fingerprint that silently disabled the merge-boundary approval fence.
 */
export async function computeReviewDiffFingerprint(
  worktreePath: string | undefined,
  baseRef: string | undefined,
  headRef = "HEAD",
): Promise<string | undefined> {
  if (!worktreePath || !baseRef) return undefined;
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--binary", `${baseRef}..${headRef}`], { cwd: worktreePath, encoding: "utf8" });
    return stdout ? createHash("sha256").update(stdout).digest("hex") : undefined;
  } catch {
    return undefined;
  }
}

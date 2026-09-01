/*
FNXC:PreMergeApproval 2026-09-01-06:53:
FN-9234 permits a review to re-bind only its own row, and only after a proven fast-forward from
exactly the commit it was dispatched against: the reviewer contract requires it to re-review an
inline edit. Rewritten or unreadable history is not demonstrably reviewed content. A
resolved-in-review finding is not a precondition because reviewers can commit without declaring it;
its count is carried only in telemetry. This module never reads or writes another lane's approval.
*/
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReviewInlineFixRecaptureReason =
  | "recaptured"
  | "head-unchanged"
  | "not-approval-verdict"
  | "plan-domain"
  | "missing-anchor"
  | "history-rewritten"
  | "base-not-ancestor"
  | "probe-unavailable";

export interface ReviewInlineFixRecaptureInput {
  verdict: string | undefined;
  reviewKind: string | undefined;
  reviewedCommitSha: string | undefined;
  currentHeadSha: string | undefined;
  baseRef: string | undefined;
  fastForwardAdvance: boolean | undefined;
  baseIsAncestor: boolean | undefined;
  fingerprintProbeAvailable: boolean;
}

export function classifyReviewInlineFixRecapture(
  input: ReviewInlineFixRecaptureInput,
): { recapture: boolean; reason: ReviewInlineFixRecaptureReason } {
  if (input.reviewKind === "plan") return { recapture: false, reason: "plan-domain" };
  if (input.verdict !== "APPROVE" && input.verdict !== "APPROVE_WITH_NOTES") {
    return { recapture: false, reason: "not-approval-verdict" };
  }
  if (!input.reviewedCommitSha || !input.currentHeadSha || !input.baseRef) {
    return { recapture: false, reason: "missing-anchor" };
  }
  if (input.reviewedCommitSha === input.currentHeadSha) return { recapture: false, reason: "head-unchanged" };
  if (input.fastForwardAdvance === undefined || input.baseIsAncestor === undefined) {
    return { recapture: false, reason: "probe-unavailable" };
  }
  if (!input.fastForwardAdvance) return { recapture: false, reason: "history-rewritten" };
  if (!input.baseIsAncestor) return { recapture: false, reason: "base-not-ancestor" };
  if (!input.fingerprintProbeAvailable) return { recapture: false, reason: "probe-unavailable" };
  return { recapture: true, reason: "recaptured" };
}

/** Read HEAD fail-closed: an unreadable checkout is not proof a review verified new content. */
export async function readHeadSha(worktreePath: string | undefined): Promise<string | undefined> {
  if (!worktreePath) return undefined;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Prove a review's original commit remains an ancestor of its final checkout. */
export async function isFastForwardAdvance(
  worktreePath: string | undefined,
  fromSha: string | undefined,
  toSha: string | undefined,
): Promise<boolean | undefined> {
  if (!worktreePath || !fromSha || !toSha) return undefined;
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", fromSha, toSha], { cwd: worktreePath, encoding: "utf8" });
    return true;
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | undefined)?.code;
    return code === 1 ? false : undefined;
  }
}

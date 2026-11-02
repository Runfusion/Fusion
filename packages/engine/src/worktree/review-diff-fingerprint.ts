/*
FNXC:ReviewConvergence 2026-08-22-05:35:
FN-149 compares review rounds by the binary patch the reviewer received. Both singular and workspace
reviews use this helper so an unchanged code loop has one durable, content-addressed definition.
*/
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveDiffBaseRef } from "../executor/worktree-git-refs.js";

const execFileAsync = promisify(execFile);

/*
FNXC:ReviewInputProof 2026-09-01-11:18:
A content-binding review proof must not silently disappear when a binary diff exceeds Node's default
one-megabyte child-process buffer. Bound Git capture explicitly so a large change either produces its
fingerprint or reports a named, fail-closed reason instead of creating a permanent merge wedge.

FNXC:ReviewInputProof 2026-11-02-15:52:
RUFU-445 keeps that BOUND and reworks how it is measured: the budget is now a streamed-byte ceiling,
not the size of a buffer that must hold the whole patch. `git diff --binary` output is hashed from
stdout chunk-by-chunk, so memory stays chunk-bounded while the refused size is exactly the same
10 MiB it was before (no raise without measurement). The bound still refuses rather than truncates:
a patch past it resolves to `git-diff-too-large`, never to a partial digest.
*/
export const REVIEW_DIFF_GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const REVIEW_DIFF_GIT_TIMEOUT_MS = 120_000;

/** Bounded options for the SMALL metadata probes below (`rev-list --count`, `--name-only`,
 *  `--shortstat`, `cat-file -e`), whose output is kilobytes. The binary patch itself never uses
 *  these — it streams (see `streamGitDiffFingerprint`). */
function gitCaptureOptions(cwd: string) {
  return {
    cwd,
    encoding: "utf8" as const,
    maxBuffer: REVIEW_DIFF_GIT_MAX_BUFFER_BYTES,
    timeout: REVIEW_DIFF_GIT_TIMEOUT_MS,
  };
}

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

export type ContentReviewInputProof =
  | { kind: "fingerprint"; fingerprint: string }
  | { kind: "unprovable"; reason: string };

/** Resolve and normalize the singular source input that a content-binding review must approve. */
export async function resolveContentReviewInputProof(
  worktreePath: string,
  diffBaseCommitSha: string | undefined,
): Promise<ContentReviewInputProof> {
  let baseRef: string | undefined;
  try {
    baseRef = await resolveDiffBaseRef(worktreePath, diffBaseCommitSha);
  } catch {
    return { kind: "unprovable", reason: "no-diff-base" };
  }
  if (!baseRef) return { kind: "unprovable", reason: "no-diff-base" };
  const probe = await probeReviewDiffFingerprint(worktreePath, baseRef);
  if (probe.state === "empty") {
    return { kind: "fingerprint", fingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT };
  }
  return probe.state === "fingerprint"
    ? { kind: "fingerprint", fingerprint: probe.fingerprint }
    : { kind: "unprovable", reason: probe.reason };
}

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
/*
FNXC:ReviewInputProof 2026-11-02-15:52:
RUFU-445 — hashing a streamed patch instead of buffering it. Measured on RUFU-281:
`git diff --binary e0b25b4ccd..HEAD` produced 38 867 308 bytes and Node killed the child at
10 470 778 bytes with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, which classified as `git-diff-too-large`
and refused the mandatory Code Review gate forever — even though the card's REAL diff (against the
correct integration base) was 112 781 bytes. Two requirements are preserved verbatim:

 - FN-180's empty-vs-unreadable split: zero bytes streamed with a clean exit is a definite EMPTY
   input (`{ state: "empty" }` → `EMPTY_REVIEW_DIFF_FINGERPRINT`); a spawn failure, a timeout kill,
   or a non-zero git exit stays `unavailable` / `git-diff-failed` and fails closed. The argv
   (`git diff --binary <base>..<target>`) is unchanged, so the reviewed content is identical.
 - The refusal reason enum (`no-diff-base` / `git-diff-too-large` / `git-diff-failed`) stays honest:
   the byte ceiling is checked as chunks arrive and the child is killed the moment it is exceeded,
   so `git-diff-too-large` means "more than 10 MiB of patch", never "we lost part of it".

Fingerprint definition: the legacy digest hashed the utf8-DECODED stdout string; this one hashes the
raw bytes. For any patch that round-trips through utf8 (which includes git's own base85 `GIT binary
patch` blocks) the two digests are identical — asserted by `review-diff-fingerprint-buffer.test.ts`.
For a byte-lossy patch (a text file holding invalid utf8) the digest MAY differ, because utf8
decoding is lossy where streaming is not. The only consequence is one extra "review input changed"
convergence round after this ships: it can never approve a review that has not run, and it cannot
wedge a merge, because an input fingerprint is compared only against another input fingerprint.
*/
function streamGitDiffFingerprint(worktreePath: string, range: string): Promise<ReviewDiffFingerprintProbe> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    let streamedBytes = 0;
    let settled = false;
    let timedOut = false;
    // Holder object rather than a bare `let`: `finish` is defined before the timer exists and must
    // still be able to clear it.
    const timerRef: { id?: ReturnType<typeof setTimeout> } = {};
    let child: ReturnType<typeof spawn>;
    const finish = (probe: ReviewDiffFingerprintProbe) => {
      if (settled) return;
      settled = true;
      if (timerRef.id) clearTimeout(timerRef.id);
      resolve(probe);
    };
    const killChild = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already dead or unkillable — the settled probe is what the caller acts on.
      }
    };

    try {
      // stderr is discarded, not collected: a full stderr pipe would stall the child, and a git
      // warning is never review evidence.
      child = spawn("git", ["diff", "--binary", range], {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve({ state: "unavailable", reason: "git-diff-failed" });
      return;
    }

    timerRef.id = setTimeout(() => {
      timedOut = true;
      killChild();
      finish({ state: "unavailable", reason: "git-diff-failed" });
    }, REVIEW_DIFF_GIT_TIMEOUT_MS);
    timerRef.id.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      streamedBytes += chunk.length;
      if (streamedBytes > REVIEW_DIFF_GIT_MAX_BUFFER_BYTES) {
        killChild();
        finish({ state: "unavailable", reason: "git-diff-too-large" });
        return;
      }
      hash.update(chunk);
    });
    child.on("error", () => {
      killChild();
      finish({ state: "unavailable", reason: "git-diff-failed" });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (timedOut || code !== 0) {
        finish({ state: "unavailable", reason: "git-diff-failed" });
        return;
      }
      finish(streamedBytes === 0
        ? { state: "empty" }
        : { state: "fingerprint", fingerprint: hash.digest("hex") });
    });
  });
}

export async function probeReviewDiffFingerprint(worktreePath: string | undefined, baseRef: string | undefined, targetRef = "HEAD"): Promise<ReviewDiffFingerprintProbe> {
  if (!worktreePath || !baseRef) return { state: "unavailable", reason: "missing-worktree-or-base" };
  return await streamGitDiffFingerprint(worktreePath, `${baseRef}..${targetRef}`);
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
    await execFileAsync("git", ["cat-file", "-e", `${reviewedCommitSha}^{commit}`], gitCaptureOptions(worktreePath));
    const [{ stdout: countOutput }, { stdout: filesOutput }, { stdout: shortstatOutput }] = await Promise.all([
      execFileAsync("git", ["rev-list", "--count", `${reviewedCommitSha}..HEAD`], gitCaptureOptions(worktreePath)),
      execFileAsync("git", ["diff", "--name-only", "-z", `${reviewedCommitSha}..HEAD`], gitCaptureOptions(worktreePath)),
      execFileAsync("git", ["diff", "--shortstat", `${reviewedCommitSha}..HEAD`], gitCaptureOptions(worktreePath)),
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

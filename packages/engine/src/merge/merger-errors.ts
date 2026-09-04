/**
 * FNXC:CodeOrganization 2026-07-15-14:30:
 * Merger error classes and abort helper peeled from merger.ts.
 */
import type { VerificationResult } from "../execution/verification-utils.js";

export class VerificationError extends Error {
  constructor(
    message: string,
    public readonly verificationResult: VerificationResult,
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

/** Raised when a merge is explicitly cancelled (for example engine shutdown). */
export class MergeAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeAbortedError";
  }
}

/**
 * FNXC:MergeInFlightRevoke 2026-08-23-08:15:
 * FN-180 fences every integration-ref advance with a fresh positive gate check.
 * A revoked review approval is a deferral back to review, never a retryable
 * merge failure or a failed task park.
 */
export class MergeGateRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeGateRevokedError";
  }
}

/**
 * Raised when fix agent made no changes and the failing test files are all
 * outside the branch's diff. This signals that the failure is pre-existing on
 * the base branch (e.g. a flaky engine test) and retrying cannot help.
 *
 * The merger catches this and marks the task `failed` with a clear error
 * message, bypassing limbo recovery so the user sees an actionable status.
 */
export class OutOfScopeVerificationError extends Error {
  constructor(
    message: string,
    public readonly failingFiles: string[],
    public readonly branchFiles: string[],
  ) {
    super(message);
    this.name = "OutOfScopeVerificationError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined, taskId: string): void {
  if (!signal?.aborted) return;
  throw new MergeAbortedError(`Merge aborted for ${taskId}: engine shutdown requested`);
}

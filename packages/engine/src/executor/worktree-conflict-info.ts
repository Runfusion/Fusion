/**
 * FNXC:CodeOrganization 2026-08-03-13:00:
 * Pure worktree git-error classifier peeled from TaskExecutor (U4 worktree cluster prep).
 * No TaskExecutor state — string pattern match only; re-exported from executor.ts for tests.
 */
import { parseIndexLockPath } from "../worktree/worktree-stale-lock.js";
import { parseStaleRegistrationPath } from "../worktree/worktree-stale-registration.js";

export type WorktreeConflictInfo = {
  type:
    | "already-used"
    | "invalid-reference"
    | "leading-directories"
    | "already-exists"
    | "not-git-repo"
    | "index-lock-contention"
    | "stale-registration"
    | "unknown";
  path?: string;
  lockPath?: string;
  message?: string;
};

/**
 * Extract worktree conflict info from a git error.
 * Handles common patterns:
 * - "already used by worktree at '...'"
 * - "invalid reference" / "unable to resolve reference" / "stale file handle"
 * - "could not create leading directories"
 * - "working tree already exists"
 */
export function extractWorktreeConflictInfo(error: unknown): WorktreeConflictInfo {
  const execError = error instanceof Error ? error : new Error(String(error));
  const output = [
    execError.message,
    "stderr" in execError && typeof execError.stderr === "string" ? execError.stderr.toString() : undefined,
    "stdout" in execError && typeof execError.stdout === "string" ? execError.stdout.toString() : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  // Pattern: already used by worktree at '/path/to/worktree'
  const alreadyUsedMatch = output.match(/already used by worktree at '([^']+)'/);
  if (alreadyUsedMatch) {
    return { type: "already-used", path: alreadyUsedMatch[1], message: output };
  }

  // Pattern: already checked out at '/path/to/worktree'
  const alreadyCheckedOutMatch = output.match(/is already checked out at '([^']+)'/);
  if (alreadyCheckedOutMatch) {
    return { type: "already-used", path: alreadyCheckedOutMatch[1], message: output };
  }

  const lockPath = parseIndexLockPath(output);
  if (lockPath) {
    return { type: "index-lock-contention", lockPath, message: output };
  }

  const staleRegistrationPath = parseStaleRegistrationPath(output);
  if (staleRegistrationPath) {
    return { type: "stale-registration", path: staleRegistrationPath, message: output };
  }

  // Pattern: invalid reference: 'branch-name'
  // Also covers: unable to resolve reference, stale file handle, not a valid ref
  if (
    output.match(/invalid reference/i) ||
    output.match(/unable to resolve reference/i) ||
    output.match(/stale file handle/i) ||
    output.match(/not a valid ref/i) ||
    output.match(/unable to delete.*ref/i)
  ) {
    return { type: "invalid-reference", message: output };
  }

  // Pattern: could not create leading directories
  if (output.match(/could not create leading directories/i)) {
    return { type: "leading-directories", message: output };
  }

  // Pattern: working tree already exists
  if (output.match(/working tree already exists/i)) {
    return { type: "already-exists", message: output };
  }

  // Pattern: not a git repository / not a git repo
  if (output.match(/not a git repo(sitory)?/i)) {
    return { type: "not-git-repo", message: output };
  }

  return { type: "unknown", message: output };
}

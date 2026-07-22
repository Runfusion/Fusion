import { BranchConflictError } from "../execution/branch-conflicts.js";

export type ErrorClass =
  | "branch-conflict-stale"
  | "branch-conflict-live-other"
  | "branch-conflict-reclaimable"
  | "branch-conflict-unrecoverable"
  | "worktree-missing"
  | "worktree-locked"
  | "merge-conflict"
  | "audit-failure"
  | "unknown";

export interface TaskErrorClassification {
  class: ErrorClass;
  recoverable: "auto" | "sticky";
  retryAfterMs?: number;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "");
}

export function classifyTaskError(err: unknown): TaskErrorClassification {
  if (err instanceof BranchConflictError) {
    const kind = (err as { kind?: string }).kind;
    if (kind === "stale" || kind === "stale-resolved") {
      return { class: "branch-conflict-stale", recoverable: "auto" };
    }
    if (kind === "reclaimable") {
      return { class: "branch-conflict-reclaimable", recoverable: "auto" };
    }
    if (kind === "live-foreign") {
      return { class: "branch-conflict-live-other", recoverable: "auto" };
    }
    return { class: "branch-conflict-unrecoverable", recoverable: "sticky" };
  }

  const message = getErrorMessage(err);

  if (/is not a working tree|No such file or directory/i.test(message)) {
    return { class: "worktree-missing", recoverable: "auto" };
  }

  if (/worktree is locked/i.test(message)) {
    return { class: "worktree-locked", recoverable: "auto", retryAfterMs: 2000 };
  }

  if (err instanceof Error && err.name === "SquashAuditError") {
    return { class: "audit-failure", recoverable: "sticky" };
  }

  if (/merge conflict|CONFLICT \(/i.test(message)) {
    return { class: "merge-conflict", recoverable: "auto" };
  }

  return { class: "unknown", recoverable: "sticky" };
}

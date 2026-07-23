// Core-owned predicates for the unified PR entity (PR-lifecycle-as-workflow-nodes, U1).
//
// These live in @fusion/core so the dashboard route, the workflow node handlers,
// and the reconcile all consult one definition and cannot drift — the same
// discipline that put isBranchGroupMemberLanded in branch-group-completion.ts.

import type { PrEntity, PrThreadState } from "../types.js";

/** Non-terminal lifecycle states — the entity is "live". */
export function isPrEntityActive(entity: Pick<PrEntity, "state">): boolean {
  return entity.state !== "merged" && entity.state !== "closed" && entity.state !== "failed";
}

/**
 * Whether a piece of work is "PR-backed" for the purpose of keeping it out of
 * the legacy merge pipeline.
 *
 * Merge-target scoping is load-bearing: a shared-group MEMBER landing onto its
 * group branch (mergeTargetSource === "branch-group-integration") is NOT
 * PR-backed even when its group has an open PR entity — only the group's
 * promotion/default-branch merge is. Treating member-integration as PR-backed
 * would deadlock the group (members could never land, so it could never complete
 * and the PR could never advance). Mirrors how isBranchGroupMemberLanded keys on
 * the merge target rather than mere group membership.
 *
 * An unverified entity (imported legacy state GitHub has not corroborated) still
 * counts as PR-backed (R19 hard gate): a possibly-fictional PR must not let the
 * task fall back into the legacy merger and risk a double-merge. The reconcile
 * clears the fiction and releases the task on its first pass.
 */
export function isPrBacked(
  entity: Pick<PrEntity, "state"> | null | undefined,
  opts?: { mergeTargetSource?: string },
): boolean {
  if (!entity || !isPrEntityActive(entity)) return false;
  // Member → group-branch integration is never PR-backed.
  if (opts?.mergeTargetSource === "branch-group-integration") return false;
  return true;
}

/**
 * Whether the entity may participate in auto-merge evaluation or response-run
 * dispatch. Unverified entities are frozen until the reconcile corroborates them
 * (R19) — they are neither auto-merged nor responded to.
 */
export function isPrEntityActionable(entity: Pick<PrEntity, "state" | "unverified">): boolean {
  return isPrEntityActive(entity) && !entity.unverified;
}

/**
 * Auto-merge green condition (R10): opted in, approved, all checks concluded
 * successful (pending is NOT green), mergeable known-clean (UNKNOWN blocks), and
 * verified. Re-evaluated by the auto-merge gate after every push.
 */
export function isPrEntityAutoMergeReady(
  entity: Pick<PrEntity, "state" | "unverified" | "autoMerge" | "reviewDecision" | "checksRollup" | "mergeable">,
): boolean {
  if (!isPrEntityActionable(entity)) return false;
  if (!entity.autoMerge) return false;
  if (entity.reviewDecision !== "APPROVED") return false;
  if (entity.checksRollup !== "success") return false;
  // mergeable must be the known-clean state; "unknown"/conflict/undefined all block.
  if (entity.mergeable !== "clean") return false;
  return true;
}

/**
 * Aggregate Review-response-loop activity for a single PR entity (U18, R15).
 *
 * A lightweight, dependency-free read seam so the Command Center / Mission
 * Control can surface what the Review-response loop actually did — threads acted
 * on, and the fixed-vs-disagreed split — without each surface re-deriving the
 * counts from raw `PrThreadState[]` (and silently disagreeing with one another).
 *
 * `acted` = fixed + disagreed (threads the loop reached a terminal verdict on).
 * `pending` rows are in-flight (recorded before GitHub confirmed) and are NOT
 * counted as acted-on. The same discipline that put `isPrEntityAutoMergeReady`
 * in @fusion/core keeps this single-sourced.
 */
export interface PrThreadActivity {
  /** Total threads with a recorded outcome (fixed + disagreed + pending). */
  total: number;
  /** Threads the loop reached a terminal verdict on (fixed + disagreed). */
  acted: number;
  /** Threads fixed (a change was pushed and the thread replied/resolved). */
  fixed: number;
  /** Threads the loop disagreed on (reasoning posted, thread left open). */
  disagreed: number;
  /** Threads recorded but not yet GitHub-confirmed (in-flight). */
  pending: number;
}

export function summarizePrThreadActivity(threads: PrThreadState[]): PrThreadActivity {
  let fixed = 0;
  let disagreed = 0;
  let pending = 0;
  for (const t of threads) {
    if (t.outcome === "fixed") fixed += 1;
    else if (t.outcome === "disagreed") disagreed += 1;
    else if (t.outcome === "pending") pending += 1;
  }
  return {
    total: threads.length,
    acted: fixed + disagreed,
    fixed,
    disagreed,
    pending,
  };
}

/**
 * The live auto-merge gate reason shown next to the toggle (R11). Mirrors the
 * auto-merge-ready predicate ordering so every surface (the dashboard route and
 * the `fn pr` CLI) reports the same status and never disagrees with what the gate
 * will actually do. Shared in @fusion/core (R13) so the two surfaces cannot drift.
 */
export function autoMergeGateReason(
  entity: Pick<PrEntity, "state" | "unverified" | "autoMerge" | "reviewDecision" | "checksRollup" | "mergeable">,
): string {
  if (!entity.autoMerge) return "Auto-merge off";
  if (entity.mergeable === "conflicting") return "Blocked: conflict";
  if (entity.reviewDecision !== "APPROVED") return "Waiting for approval";
  if (entity.checksRollup !== "success") return "Waiting for checks";
  if (entity.mergeable !== "clean") return "Waiting for checks";
  if (isPrEntityAutoMergeReady(entity)) return "Ready to merge";
  return "Waiting for checks";
}

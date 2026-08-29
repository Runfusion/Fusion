/**
 * Classify honest-blocked exits so the engine does not auto-replan (or thrash
 * re-execute) work that is blocked behind other Fusion board tasks.
 *
 * FNXC:HonestBlockedExit 2026-08-02-23:59 (operator decision — FN-8728 vs PR #2398):
 * FN-8700 previously treated "file claim / open PR" language as a durable external
 * block: agents were instructed to check open GitHub PRs for files they were about to
 * touch and park blocked on collisions, and self-healing cleared the park when the PR
 * merged/closed. That made board tasks wait on unrelated PRs. File-scope conflicts are
 * arbitrated ONLY by Fusion's own board (file-scope leases, task dependencies) — an
 * open PR is never a claim on a task's file scope. All PR/file-claim classification,
 * pr:N blockedBy refs, and the gh-backed PR-clear sweep are removed. Blocked exits now
 * classify on task dependencies alone: task deps → durable external park (requeues
 * when the deps complete); no deps → plan defect → auto-replan (FN-8634).
 */

export type BlockedExitClass = "plan-defect" | "external";

export type BlockedExitClassification = {
  /** Only plan defects may use the empty-blockedBy → needs-replan path. */
  allowAutoReplan: boolean;
  class: BlockedExitClass;
  /** Compact signature for thrash detection (ids/outcomes only — no free prose). */
  thrashSignature: string;
};

const TASK_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
/**
 * FNXC:HonestBlockedExit 2026-08-02-23:59:
 * Legacy PR refs (pr:2398, pr#2398, pr-2398, #2398, PR-2398) are recognized only to be
 * DISCARDED — without this filter "PR-12" would match TASK_ID_RE and become a dependency
 * edge on a nonexistent "PR-12" task row, wedging the card forever.
 */
const LEGACY_PR_REF_RE = /^(?:pr[:#-]|#|PR-)(\d+)$/i;

/**
 * Extract Fusion task IDs from blockedBy entries. Non-task tokens — including legacy
 * pr:N / #N PR refs — are ignored: open PRs are not valid blockers.
 */
export function partitionBlockedByRefs(blockedBy: readonly string[]): {
  taskIds: string[];
} {
  const taskIds: string[] = [];
  for (const raw of blockedBy) {
    const id = raw.trim();
    if (!id) continue;
    if (LEGACY_PR_REF_RE.test(id)) continue;
    if (TASK_ID_RE.test(id)) {
      const m = id.toUpperCase().match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
      taskIds.push(m ? `${m[1]}-${m[2]}` : id.toUpperCase());
    }
    // Ignore other unknown tokens for dependency edges
  }
  return { taskIds: [...new Set(taskIds)] };
}

/**
 * Classify a blocked exit for parking policy. Reason prose never affects the
 * classification — only real task dependencies make a block durable.
 */
export function classifyBlockedExit(
  _reason: string,
  blockedBy: readonly string[] = [],
): BlockedExitClassification {
  const { taskIds } = partitionBlockedByRefs(blockedBy);
  if (taskIds.length > 0) {
    return {
      allowAutoReplan: false,
      class: "external",
      thrashSignature: `tasks:${taskIds.slice().sort().join(",")}`,
    };
  }

  // Empty blockedBy → plan defect, auto-replan is OK
  return {
    allowAutoReplan: true,
    class: "plan-defect",
    thrashSignature: "plan-defect",
  };
}

/** Max identical durable-block hits before thrash exhaustion (inclusive). */
export const BLOCKED_THRASH_LIMIT = 3;

/** Lookback window for thrash counting. */
export const BLOCKED_THRASH_WINDOW_MS = 60 * 60 * 1000;

export type TaskLogLike = { action?: string; timestamp?: string };

/**
 * Count recent log rows that match a durable block signature.
 */
export function countBlockedThrashHits(
  log: readonly TaskLogLike[] | undefined,
  signature: string,
  nowMs: number = Date.now(),
  windowMs: number = BLOCKED_THRASH_WINDOW_MS,
): number {
  if (!log?.length) return 0;
  if (signature === "plan-defect") return 0;
  const cutoff = nowMs - windowMs;
  let count = 0;
  for (const entry of log) {
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const action = entry.action ?? "";
    if (!action.startsWith("BLOCKED:") && !action.includes("DUPLICATE_REPLAN_EXHAUSTED") && !action.includes("BLOCKED_THRASH")) {
      // Also count durable park confirmations
      if (!action.includes("parked failed (honest blocked exit") && !action.includes("durable external block")) {
        continue;
      }
    }
    for (const part of signature.split("|")) {
      if (part.startsWith("tasks:") && part.slice(6).split(",").some((id) => id && action.includes(id))) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

export function isDurableBlockedTask(task: {
  status?: string | null;
  error?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
}): boolean {
  /*
  FNXC:HonestBlockedExit 2026-08-02-23:59:
  Only metadata-classed "external" (task-dependency) parks are durable. Legacy
  "file-claim" parks and externalBlockers metadata from the removed FN-8700 PR-claim
  path are deliberately NOT honored, so previously PR-blocked rows become recoverable
  by normal graph-resume/scheduler paths instead of waiting on a merged/closed PR sweep.
  */
  const meta = task.sourceMetadata;
  if (!meta || typeof meta !== "object") return false;
  if (meta.blockedClass !== "external") return false;
  return task.status === "failed" || task.status === "needs-replan";
}

/**
 * Build sourceMetadata patch for a durable external block park.
 * `externalBlockers` is always cleared — the PR-claim blocker list is removed.
 */
export function buildExternalBlockMetadataPatch(
  classification: BlockedExitClassification,
  thrashCount: number,
): Record<string, unknown> {
  return {
    blockedClass: classification.class,
    blockedThrashSignature: classification.thrashSignature,
    blockedThrashCount: thrashCount,
    externalBlockers: [],
  };
}

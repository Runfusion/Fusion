/**
 * Classify honest-blocked exits so the engine does not auto-replan (or thrash
 * re-execute) work that is blocked by an external claim or open PR.
 *
 * FNXC:HonestBlockedExit 2026-08-02-01:30:
 * FN-8700 looped forever: agent correctly parked on `check-file-claimed` / PR #2398
 * with empty blockedBy (no FN-#### dependency). Empty blockedBy was treated as a plan
 * defect → needs-replan → re-execute → same claim → BLOCKED. File-claim and open-PR
 * blocks are durable external waits, not plan defects. Classify them so:
 *   (A) empty blockedBy does NOT auto-replan for claim/PR classes
 *   (B) PR numbers from reason/blockedBy refs are stored as externalBlockers metadata
 *   (C) graph-resume and thrash detectors can leave durable parks alone
 */

export type ExternalBlocker =
  | { kind: "github-pr"; number: number }
  | { kind: "file-claim"; prNumber?: number };

export type BlockedExitClass =
  | "plan-defect"
  | "file-claim"
  | "external"
  | "unknown-external";

export type BlockedExitClassification = {
  /** Only plan defects may use the empty-blockedBy → needs-replan path. */
  allowAutoReplan: boolean;
  class: BlockedExitClass;
  externalBlockers: ExternalBlocker[];
  /** Compact signature for thrash detection (ids/outcomes only — no free prose). */
  thrashSignature: string;
  /** PR numbers extracted from reason and blockedBy refs. */
  prNumbers: number[];
};

const TASK_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
/**
 * FNXC:ExecutionBlockClassification 2026-08-01-18:45:
 * Bare PR blockers accept pr:2398, pr#2398, pr-2398, #2398, and PR-2398 while excluding FN-#### task IDs. Keep the hyphen last in the character class so ESLint does not require an unnecessary escape.
 */
const PR_REF_RE = /^(?:pr[:#-]|#|PR-)(\d+)$/i;
const PR_IN_TEXT_RE = /\bPR\s*#?\s*(\d+)\b/gi;
const CLAIM_REASON_RE =
  /check-file-claimed|actively claimed|file[- ]claim|claimed by (?:open )?pr|open pr\s*#?\s*\d+|collision policy|claimed paths?|file claims?/i;

/**
 * Split blockedBy entries into real task IDs vs external refs (pr:2398, #2398, PR-2398).
 */
export function partitionBlockedByRefs(blockedBy: readonly string[]): {
  taskIds: string[];
  prNumbers: number[];
} {
  const taskIds: string[] = [];
  const prNumbers: number[] = [];
  for (const raw of blockedBy) {
    const id = raw.trim();
    if (!id) continue;
    const prMatch = id.match(PR_REF_RE);
    // Prefer PR refs before task-id matching (PR-12 would otherwise match TASK_ID_RE).
    if (prMatch) {
      prNumbers.push(Number(prMatch[1]));
      continue;
    }
    if (TASK_ID_RE.test(id)) {
      const m = id.toUpperCase().match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
      taskIds.push(m ? `${m[1]}-${m[2]}` : id.toUpperCase());
      continue;
    }
    // Ignore unknown tokens for dependency edges
  }
  return {
    taskIds: [...new Set(taskIds)],
    prNumbers: [...new Set(prNumbers.filter((n) => Number.isFinite(n) && n > 0))],
  };
}

export function extractPrNumbersFromText(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(PR_IN_TEXT_RE)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) found.push(n);
  }
  return [...new Set(found)];
}

export function isFileClaimBlockedReason(reason: string): boolean {
  return CLAIM_REASON_RE.test(reason);
}

/**
 * Classify a blocked exit for parking policy.
 */
export function classifyBlockedExit(
  reason: string,
  blockedBy: readonly string[] = [],
): BlockedExitClassification {
  const trimmed = reason.trim();
  const partitioned = partitionBlockedByRefs(blockedBy);
  const prFromText = extractPrNumbersFromText(trimmed);
  const prNumbers = [...new Set([...partitioned.prNumbers, ...prFromText])];
  const isClaim = isFileClaimBlockedReason(trimmed) || prNumbers.length > 0 && /claim/i.test(trimmed);

  if (isClaim || prNumbers.length > 0 && isFileClaimBlockedReason(trimmed)) {
    const externalBlockers: ExternalBlocker[] = [
      ...prNumbers.map((number) => ({ kind: "github-pr" as const, number })),
    ];
    if (externalBlockers.length === 0 && isClaim) {
      externalBlockers.push({
        kind: "file-claim",
        prNumber: prNumbers[0],
      });
    } else if (isClaim) {
      // Also record a file-claim tag when claim language is present
      for (const n of prNumbers) {
        if (!externalBlockers.some((b) => b.kind === "github-pr" && b.number === n)) {
          externalBlockers.push({ kind: "github-pr", number: n });
        }
      }
      if (prNumbers.length === 0) {
        externalBlockers.push({ kind: "file-claim" });
      }
    }
    const thrashSignature = [
      "file-claim",
      ...prNumbers.map((n) => `pr:${n}`).sort(),
      ...partitioned.taskIds.slice().sort(),
    ].join("|");
    return {
      allowAutoReplan: false,
      class: "file-claim",
      externalBlockers,
      thrashSignature: thrashSignature || "file-claim",
      prNumbers,
    };
  }

  if (partitioned.taskIds.length > 0) {
    return {
      allowAutoReplan: false,
      class: "external",
      externalBlockers: [],
      thrashSignature: `tasks:${partitioned.taskIds.slice().sort().join(",")}`,
      prNumbers,
    };
  }

  if (prNumbers.length > 0) {
    return {
      allowAutoReplan: false,
      class: "external",
      externalBlockers: prNumbers.map((number) => ({ kind: "github-pr" as const, number })),
      thrashSignature: prNumbers.map((n) => `pr:${n}`).sort().join("|"),
      prNumbers,
    };
  }

  // Empty blockedBy + no claim language → plan defect, auto-replan is OK
  return {
    allowAutoReplan: true,
    class: "plan-defect",
    externalBlockers: [],
    thrashSignature: "plan-defect",
    prNumbers: [],
  };
}

/** Max identical durable-block hits before thrash exhaustion (inclusive). */
export const BLOCKED_THRASH_LIMIT = 3;

/** Lookback window for thrash counting. */
export const BLOCKED_THRASH_WINDOW_MS = 60 * 60 * 1000;

export type TaskLogLike = { action?: string; timestamp?: string };

/**
 * Count recent log rows that match a durable block signature or BLOCKED: claim text.
 */
export function countBlockedThrashHits(
  log: readonly TaskLogLike[] | undefined,
  signature: string,
  nowMs: number = Date.now(),
  windowMs: number = BLOCKED_THRASH_WINDOW_MS,
): number {
  if (!log?.length) return 0;
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
    // Signature match via pr:N tokens or claim class
    if (signature === "plan-defect") continue;
    if (signature.includes("file-claim") || signature.startsWith("pr:") || signature.includes("|pr:")) {
      if (isFileClaimBlockedReason(action) || /PR\s*#?\s*\d+/i.test(action) || action.includes("durable external block")) {
        count += 1;
        continue;
      }
    }
    for (const part of signature.split("|")) {
      if (part.startsWith("pr:") && action.includes(`PR #${part.slice(3)}`)) {
        count += 1;
        break;
      }
      if (part.startsWith("tasks:") && part.slice(6).split(",").some((id) => id && action.includes(id))) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

export function isDurableBlockedError(error: string | null | undefined): boolean {
  if (!error?.startsWith("BLOCKED:")) return false;
  const reason = error.slice("BLOCKED:".length).trim();
  const classification = classifyBlockedExit(reason, []);
  return !classification.allowAutoReplan;
}

export function isDurableBlockedTask(task: {
  status?: string | null;
  error?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
}): boolean {
  if (task.status === "failed" && isDurableBlockedError(task.error)) return true;
  const meta = task.sourceMetadata;
  if (!meta || typeof meta !== "object") return false;
  if (meta.blockedClass === "file-claim" || meta.blockedClass === "external") {
    if (task.status === "failed" || task.status === "needs-replan") return true;
  }
  const blockers = meta.externalBlockers;
  return Array.isArray(blockers) && blockers.length > 0 && task.status === "failed";
}

/**
 * Build sourceMetadata patch for a durable external block park.
 */
export function buildExternalBlockMetadataPatch(
  classification: BlockedExitClassification,
  thrashCount: number,
): Record<string, unknown> {
  return {
    blockedClass: classification.class,
    blockedThrashSignature: classification.thrashSignature,
    blockedThrashCount: thrashCount,
    externalBlockers: classification.externalBlockers,
  };
}

/*
FNXC:BranchConflictRecovery 2026-09-13-01:15:
RUFU-231 terminates the zero-own-commit / foreign-tainted branch-conflict recovery loop.

The RUFU-217 wedge proved the failure mode: a review-lane card whose branch owns zero
commits and whose tip belongs to a foreign lineage is re-admitted by every maintenance
pass, because every refusal path parked or held the card WITHOUT persisting any counter —
so the dispatcher budget (`retryCount: task.recoveryRetryCount ?? 0` in the immutable
class-decision engine) could never reach exhaustion and the card was re-tried forever,
head-of-line blocking peers behind its retained checkout.

This module is the single accounting authority every branch-conflict refusal site shares:

- `planBranchConflictRecoveryPass` derives the bounded budget from the PERSISTED
  `Task.recoveryRetryCount` (the dispatcher decision-engine input) — attempt N+1, terminal
  when `attempt > autoRecovery.maxRetries`. An explicit `mode: "off"` disables accounting
  entirely (operator opt-out; refusals stay pure log/hold without counter writes).
- `buildBranchConflictRecoveryParkPatch` is the terminal park: `failed` + `paused` with the
  EXISTING `branch-conflict-recovery-exhausted` reason (no new pause-reason enum member)
  and an error that names the concrete remedy (resolve against the integration branch,
  retry, or reset to todo). The patch NEVER touches `worktree`/`branch` — the terminal park
  is separated from lease release so the operator can still inspect the retained checkout
  (and the dormant file-scope lease semantics order, not hard-serialize, peers meanwhile).
- `emitBranchConflictRecoveryParkAudit` records the park through the bounded audit seam so
  telemetry can never become a lifecycle dependency.

/*
FNXC:BranchConflictRecovery 2026-11-02-22:20:
RUFU-432 corrects two claims this contract comment used to make, because both were false in the
code and each false claim was load-bearing for an operator-visible defect.

1. It claimed the sweep's candidate filter admits `branch-conflict-unrecoverable` only, so an
   exhausted park is never re-admitted. FALSE: only the REVIEW bucket filters on a `pausedReason`
   at all (`self-healing.ts` `reclaimSelfOwnedBranchConflicts` — `readBucket(reclaimHoldColumns)`
   and `readBucket(reclaimWipColumns)` are unfiltered). A parked card IS re-admitted, on purpose:
   every release door (`stale`, `stale-resolved`, the `tip-already-merged` never-delivered rescue
   and the ghost-pointer reclaim) is a verdict of `inspectBranchConflict`, so skipping a parked
   card before that call strands it with no way out. Suppression therefore lives at the MUTATING
   WRITE ARMS (`branchConflictRecoveryParkAlreadyApplied` gates park writes and refusal History),
   never in the candidate filter and never in front of the git inspection.
2. It implied the park patch's own counter write was what bounded the loop. Also false: writing
   `recoveryRetryCount` inside the terminal park made the park re-advance its own budget on every
   re-admitted pass (measured 26 and 19 against a declared budget of 3), so the number the
   operator read grew without bound and every pass re-stamped `updated_at`, which is precisely
   what a heartbeat reads as recovery liveness. A terminal park is now NOT a counted pass: it
   persists no counter, re-encountering it issues no store write, no audit row and no History
   append, and the REPORTED attempt is clamped to `maxRetries + 1` — so the sentence can never
   read "exhausted after 26 bounded passes (budget 3)" even for a row an older build inflated.

What stays: refusals do not get looser, only quieter. A counted NON-terminal pass still advances
the persisted counter by exactly 1, the (maxRetries + 1)-th pass still terminalizes, and the
refusal note is now one windowed deduped History line per (card, reason, tip) rather than one per
pass. `recoveryRetryCount` semantics: persisted = counted non-terminal passes; reported attempt =
min(persisted + 1, maxRetries + 1). A manual Retry zeroes the counter
(`MANUAL_RETRY_RESET_COUNTER_KEYS`) and now lifts this pause too (`buildAutoPauseClearPatch`), so
the predicate below is invalidated by the door the remedy sentence names.
*/
import type { AutoRecoverySettings, Task, TaskStore } from "@fusion/core";
/*
FNXC:BranchConflictRecovery 2026-11-02-22:15 (RUFU-432):
The pause reason has ONE spelling, owned by core next to the sibling reasons its Retry allowlist
consumes. Re-exported here so every engine park site and the applied-park predicate read the same
constant a `fn task retry` clears — a rename on either side is a compile error, not a park that
silently stops lifting.
*/
import { BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON } from "@fusion/core";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { reportBranchAttribution } from "../execution/branch-conflicts.js";
import { createLogger } from "../logger.js";

const log = createLogger("recovery");

export { BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON };

/*
FNXC:BranchConflictRecovery 2026-09-13-02:05:
RUFU-231 Mission defect 2 (evidence half): `AutoRecoveryDispatcher.isDestructiveAmbiguity` reads
`evidence.ownCommits` / `evidence.foreignAttributedCommits`, and every branch-conflict dispatch
site omitted them — so a genuinely mixed own+foreign branch was classified by mode (→ retry,
toward a destructive path) instead of taking the intended destructive-ambiguity pause. These
helpers produce the counts from the SAME attribution parser the executor post-session audit uses
(`reportBranchAttribution`), on one `base..branch` git call. This is a safety read, NOT a routing
mechanism: the dispatcher routing table is unchanged.
*/

/** Best recorded identity for attributing branch commits; falls back to the caller-provided integration ref. */
export function conflictAttributionBase(
  task: Pick<Task, "baseCommitSha" | "baseBranch" | "executionStartBranch">,
  integrationBranch: string | null | undefined,
): string | null {
  return task.baseCommitSha ?? task.baseBranch ?? task.executionStartBranch ?? integrationBranch ?? null;
}

export interface BranchConflictDispatchEvidence {
  ownCommits: number;
  foreignAttributedCommits: number;
}

/**
 * Compute the dispatcher's destructive-ambiguity evidence counts for one refusal site.
 * Best-effort by design: an unreadable branch/base, or a set with NO trailer-attributed commit
 * at all, yields NO evidence keys — the refusal keeps today's byte-identical evidence shape and
 * the dispatcher decision is unchanged (ambiguity needs own AND foreign attributed commits).
 * Only observed attribution is attached; a failed git call never throws on a refusal path.
 */
export async function branchConflictDispatchEvidenceCounts(input: {
  repoDir: string;
  taskId: string;
  branchRef: string | null | undefined;
  baseRef: string | null | undefined;
}): Promise<BranchConflictDispatchEvidence | null> {
  if (!input.branchRef || !input.baseRef) return null;
  const report = await reportBranchAttribution(input.repoDir, input.branchRef, input.baseRef, input.taskId).catch(() => null);
  if (!report) return null;
  const ownCommits = report.ownTrailed + report.ownUntrailed.length;
  const foreignAttributedCommits = report.foreign.length;
  if (ownCommits === 0 && foreignAttributedCommits === 0) return null;
  return { ownCommits, foreignAttributedCommits };
}

/** Fixed provenance enum for park audit rows — never free text. */
export type BranchConflictRecoverySource =
  | "self-owned-reclaim"
  | "pr-reclaim"
  | "executor-conflict"
  | "dirty-checkout-hold"
  | "foreign-tip-reject";

export interface BranchConflictRecoveryPass {
  /** Counter value persisted on the task BEFORE this pass. */
  persisted: number;
  /**
   * The pass number this site REPORTS (remedy sentence, audit `attempt`, History line):
   * `min(persisted + 1, maxRetries + 1)`. Clamped, because a row an older build inflated to 26
   * must not keep announcing "after 26 bounded passes (budget 3)" (RUFU-432).
   */
  attempt: number;
  maxRetries: number;
  /** True when `attempt > maxRetries`: this pass must park terminal instead of re-offering the transient pause. */
  terminal: boolean;
  /** False when auto-recovery `mode: "off"` — no counter writes, no terminal park. */
  counted: boolean;
}

/**
 * Derive this pass's bounded recovery budget. `maxRetries` mirrors the dispatcher call
 * sites' fallback (`autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 }`).
 *
 * FNXC:BranchConflictRecovery 2026-11-02-22:20 (RUFU-432): the reported attempt is clamped, so a
 * saturated counter always decides `terminal` and can never raise the number the operator reads
 * above `maxRetries + 1`. `terminal` keeps its old meaning (`attempt > maxRetries`), which for a
 * non-inflated counter is the same boundary as before: `persisted >= maxRetries`.
 */
export function planBranchConflictRecoveryPass(
  task: Pick<Task, "recoveryRetryCount">,
  autoRecovery: AutoRecoverySettings | undefined,
): BranchConflictRecoveryPass {
  const maxRetries = autoRecovery?.maxRetries ?? 3;
  const counted = autoRecovery?.mode !== "off";
  const persisted = task.recoveryRetryCount ?? 0;
  const attempt = counted ? Math.min(persisted + 1, maxRetries + 1) : persisted;
  return { persisted, attempt, maxRetries, terminal: counted && attempt > maxRetries, counted };
}

/**
 * The ONE write guard for the recovery counter. Exported so "no counter change" cannot be
 * expressed as a store call: routing an empty patch through `updateTask` is exactly what
 * re-stamps `updated_at`, and a re-stamped `updated_at` is what makes a dead card look alive.
 *
 * A terminal park is not a counted recovery pass, and `mode: "off"` is the operator's opt-out
 * from accounting; neither may touch the counter.
 */
export function branchConflictRecoveryCounterShouldWrite(pass: BranchConflictRecoveryPass): boolean {
  return pass.counted && !pass.terminal;
}

/** Patch merged into a non-terminal transient pause/persist so the budget advances in the same write. */
export function branchConflictRecoveryCounterPatch(pass: BranchConflictRecoveryPass): Pick<Task, "recoveryRetryCount"> | Record<string, never> {
  return branchConflictRecoveryCounterShouldWrite(pass) ? { recoveryRetryCount: pass.attempt } : {};
}

/*
FNXC:BranchConflictRecovery 2026-11-02-22:20 (RUFU-432, requirement and reason from revision 4):
How long two History refusals for the SAME (card, reason, tip) may sit apart. Mirrors
`ReviewDispatchSweep.REFUSAL_HISTORY_WINDOW_MS` — the same pathology (a sweep on a seconds-to-minutes
cadence announcing one unchanged refusal per pass) and the same bound, chosen so an operator who
looks at a card hours later still sees that the refusal is current, while a 15 s sweep cadence costs
~12 lines a day instead of ~600. That file owns its own constant and is deliberately untouched.
*/
export const BRANCH_CONFLICT_REFUSAL_HISTORY_WINDOW_MS = 6 * 60 * 60_000;

/** Stable dedupe identity: the same card, the same refusal reason, the same tip re-announces once per window. */
export function branchConflictRefusalHistoryDedupeKey(input: {
  taskId: string;
  reason: string;
  candidateSha?: string | null;
}): string {
  return `branch-conflict-refusal:${input.taskId}:${input.reason}:${input.candidateSha?.slice(0, 12) ?? "no-tip"}`;
}

/**
 * Append the refusal note to the card's History, at most once per window per refusal identity.
 *
 *FNXC:BranchConflictRecovery 2026-11-02-22:25 (RUFU-432):
 * Why a window rather than a suppression that deletes the refusal: the refusal itself must stay
 * visible (an operator reading a stuck card must see WHY it is stuck), but before this the line
 * was authored unconditionally ahead of the budget block, so a card parked behind one persistent
 * refusal accumulated an identical History entry every pass — unbounded side-table growth is the
 * exact pathology RUFU-312 exists to prevent. Why the `parkApplied` arm appends nothing at all: a
 * pass that authors no state must author no History either, and after the park is applied every
 * later pass authors nothing (the applied-park predicate suppresses the write arms), so its
 * refusal is already on the card from the pass that parked it.
 *
 * Mechanism is the DUCK-TYPED durable seam the repo already ships (`store.logEntryOnce`, precedent
 * in `self-healing.ts`'s `[unrun-gate-park-withheld]` line and `scheduling/review-dispatch-sweep.ts`),
 * because its window survives an engine restart, which an in-process `Set` does not. A store without
 * the seam falls back to the plain append seam; a throwing seam is swallowed into a debug line,
 * because announcing is never the point — the refusal stands in the audit row and the park. No
 * second dedupe mechanism and no write to core's log seams.
 */
export async function recordBranchConflictRefusalHistory(
  store: TaskStore,
  input: { taskId: string; message: string; dedupeKey: string; parkApplied: boolean },
): Promise<"windowed" | "suppressed" | "fallback" | "suppressed-park" | "failed"> {
  if (input.parkApplied) return "suppressed-park";
  if (typeof store.logEntryOnce === "function") {
    try {
      const appended = await store.logEntryOnce(input.taskId, {
        action: input.message,
        outcome: "refused",
        dedupeKey: input.dedupeKey,
        windowMs: BRANCH_CONFLICT_REFUSAL_HISTORY_WINDOW_MS,
      });
      return appended ? "windowed" : "suppressed";
    } catch (err: unknown) {
      log.debug(`Could not record the branch-conflict refusal for ${input.taskId}: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
  }
  try {
    await store.logEntry(input.taskId, input.message);
    return "fallback";
  } catch (err: unknown) {
    log.debug(`Could not record the branch-conflict refusal for ${input.taskId}: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/**
 * True while the card stands in a terminal park this recovery has ALREADY authored, with its
 * budget still spent. Gate every park-writing arm on it.
 *
 * FNXC:BranchConflictRecovery 2026-11-02-22:30 (RUFU-432):
 * Keys on exactly two states plus the spent budget, and on nothing else: `status`, `error`,
 * `branch` and `worktree` are each touched by a legitimate release door or a reset, so a
 * predicate that read them would either suppress a real rescue or miss a re-park. The spent-budget
 * term is what makes the park *revocable* rather than permanent: every operator Retry surface
 * already zeroes `recoveryRetryCount` through `MANUAL_RETRY_RESET_COUNTER_KEYS`, so the counter
 * write alone invalidates this predicate and the next pass may write again. Without that term a
 * parked card would stay unsuppressed-forever-proof even after the operator pressed Retry, and it
 * would keep `branch`/`worktree` retained — a dormant file-scope lease on every peer.
 */
export function branchConflictRecoveryParkAlreadyApplied(
  task: Pick<Task, "paused" | "pausedReason" | "recoveryRetryCount">,
  autoRecovery: AutoRecoverySettings | undefined,
): boolean {
  if (task.paused !== true || task.pausedReason !== BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON) return false;
  // Budget still spent == the next counted pass would itself decide terminal. A zeroed counter
  // (operator Retry) reports not-spent, which is exactly the intended invalidation.
  return planBranchConflictRecoveryPass(task, autoRecovery).terminal;
}

/**
 * Operator-facing remedy. Contract (pinned by the RUFU-231 regression suite): names the
 * integration branch and at least one recovery door (retry / reset to todo) so the park is
 * actionable, not just terminal.
 */
export function branchConflictRecoveryRemedy(pass: BranchConflictRecoveryPass, integrationBranch: string | undefined, detail: string): string {
  const ref = integrationBranch?.trim() || "main";
  return (
    `Branch-conflict recovery exhausted after ${pass.attempt} bounded passes (budget ${pass.maxRetries}): ${detail} ` +
    `Inspect this card's branch against the integration branch (${ref}), then retry the task or reset it to todo. ` +
    `The card stays checked out and is re-inspected on every automatic pass, so a release verdict can still free it; ` +
    `while this park stands, re-authoring it stays quiet until a retry resets the recovery budget.`
  );
}

/**
 * Terminal park patch. Deliberately omits `worktree`/`branch`/`baseCommitSha`: terminating
 * the loop never mutates the checkout the operator must still inspect.
 *
 * FNXC:BranchConflictRecovery 2026-11-02-22:32 (RUFU-432): it deliberately omits
 * `recoveryRetryCount` TOO, and that omission is the durability fix. This patch used to carry
 * `recoveryRetryCount: pass.attempt`, so every re-admitted pass read its own previous park value,
 * incremented it and re-wrote it: the reported budget outran its own declaration (26 against 3)
 * and each write re-stamped `updated_at`. A terminal pass persists nothing here; the stored value
 * freezes at its last counted value (or at a legacy-inflated value, which this pass may never
 * raise), and the reported `attempt` is what the operator reads.
 */
export function buildBranchConflictRecoveryParkPatch(
  pass: BranchConflictRecoveryPass,
  integrationBranch: string | undefined,
  detail: string,
): Partial<Task> {
  return {
    status: "failed",
    paused: true,
    pausedReason: BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON,
    error: branchConflictRecoveryRemedy(pass, integrationBranch, detail),
  };
}

export async function emitBranchConflictRecoveryParkAudit(input: {
  store: TaskStore;
  agentId: string;
  runId: string;
  task: Pick<Task, "id" | "lineageId">;
  pass: BranchConflictRecoveryPass;
  source: BranchConflictRecoverySource;
}): Promise<void> {
  await emitBoundedRunAudit(input.store, {
    agentId: input.agentId,
    runId: input.runId,
    taskId: input.task.id,
    domain: "database",
    mutationType: "task:branch-conflict-recovery-parked",
    target: input.task.id,
    metadata: {
      taskId: input.task.id,
      attempt: input.pass.attempt,
      maxRetries: input.pass.maxRetries,
      source: input.source,
      terminal: true,
    },
  });
}

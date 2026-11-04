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

/*
FNXC:BranchConflictRecovery 2026-11-04-13:08 (RUFU-395) — the authority split, and why this module
no longer reads the shared counter to decide exhaustion:
RUFU-432 bounded how a saturated `recoveryRetryCount` is REPORTED but left it as the DECIDER of
`terminal` and as the number printed in the park sentence. That field is the dispatcher's shared disk
budget: `executor/run-implementation.ts`, `executor/non-continuable-session.ts` and `triage.ts` all
write it, and every operator Retry zeroes it through `MANUAL_RETRY_RESET_COUNTER_KEYS`. Two failures
follow, both measured live (RUFU-378 at 32, RUFU-391 at 25, against `maxRetries: 3`):

1. A card whose shared counter another layer had inflated reached the terminal park on THIS family's
   first refusal — it was called exhausted for refusals it never made.
2. The sentence "after N bounded passes (budget 3)" printed an N that was partly another layer's, and
   RUFU-432's clamp put it at `maxRetries + 1` — still above the declared budget.

The fix is a register this family owns: `sourceMetadata.branchConflictRecoveryEpisode.refusalCount`,
written ONLY by `branchConflictRecoveryCounterPatch` in the same statement as the refusal it describes
(register == marker count by construction), and it is the sole authority for `terminal` and for the
printed number. It is clamped structurally, not by arithmetic: the pass that would exceed the budget
takes the park branch and the park never advances the register, so the count can never read above
`maxRetries` from any of the six park sources or the counter-only handler.

Why not `Task.branchConflictRecoveryCount`: `recordRetry` (`errors/retry-burned-logger.ts`, category
`branchConflict`) owns that field, writes `current + 1`, and bounds it by a DIFFERENT ceiling
(`maxBranchConflictRecoveries`); sharing it would reintroduce borrowed numbers under a new name. Why a
`sourceMetadata` episode rather than a column: the RUFU-246/273/393 precedent — key-level writes, no
migration, and the column is in the slim row projection the sweeps read candidates with.

`recoveryRetryCount` itself keeps its value and its dispatcher meaning untouched (the RUFU-231
assertions on it stay green on purpose); it simply stops being a ceiling claim anywhere in this
module's prose or audit rows. `attempt` remains on the pass object for that reason, deprecated as a
claim. Manual Retry remains the only exit, and now clears the register too
(`buildManualRetryResetPatch`).
*/
import type { AutoRecoverySettings, Task, TaskStore, TaskBranchConflictRecoveryEpisode } from "@fusion/core";
/*
FNXC:BranchConflictRecovery 2026-11-02-22:15 (RUFU-432):
The pause reason has ONE spelling, owned by core next to the sibling reasons its Retry allowlist
consumes. Re-exported here so every engine park site and the applied-park predicate read the same
constant a `fn task retry` clears — a rename on either side is a compile error, not a park that
silently stops lifting.

FNXC:BranchConflictRecovery 2026-11-04-13:09 (RUFU-395):
The family's own register key joins it for the same cross-package reason: the writer is this module's
counter patch and the lifter is core's `buildManualRetryResetPatch`. One renamed literal on either
side would be a park whose register never clears.
*/
import { BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON, BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY } from "@fusion/core";
import { emitBoundedRunAudit } from "../util/emit-bounded-run-audit.js";
import { reportBranchAttribution } from "../execution/branch-conflicts.js";
import { createLogger } from "../logger.js";

const log = createLogger("recovery");

export { BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON, BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY };

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
  | "foreign-tip-reject"
  /*
  FNXC:BranchConflictRecovery 2026-11-04-13:12 (RUFU-395):
  The auto-recovery dispatcher's irreducible pause advanced the register but never reached a park, so
  no suppression predicate could ever name its cards. When RUFU-395 gave that writer a terminal
  disposition it needed its OWN source: reusing `executor-conflict` or `self-owned-reclaim` would
  attribute a dispatcher-authored park to whichever lane happened to dispatch it, and the dispatcher
  is shared by both. Additive on the existing park event type — no new mutation type.
  */
  | "dispatcher-irreducible-pause";

export interface BranchConflictRecoveryPass {
  /** Counter value persisted on the task BEFORE this pass. Dispatcher input ONLY: never a ceiling claim. */
  persisted: number;
  /**
   * The pass number this site REPORTS (remedy sentence, audit `attempt`, History line):
   * `min(persisted + 1, maxRetries + 1)`. Clamped, because a row an older build inflated to 26
   * must not keep announcing "after 26 bounded passes (budget 3)" (RUFU-432).
   *
   * DEPRECATED AS A CEILING CLAIM (RUFU-395): this number derives from the SHARED dispatcher
   * counter, so it can be borrowed from another layer. Every operator-facing sentence and every
   * repeated-park log line interpolates `boundedPassCount` instead. `attempt` survives only as the
   * audit `attempt` key and as the value the shared counter is written with, because the dispatcher
   * budget must keep its RUFU-231 meaning.
   */
  attempt: number;
  maxRetries: number;
  /**
   * RUFU-395: this family's OWN persisted refusals, read from
   * `sourceMetadata.branchConflictRecoveryEpisode.refusalCount`. Zero when no episode exists, which
   * is the state after a card is created or an operator Retry cleared the register.
   */
  ownPersisted: number;
  /**
   * RUFU-395: the number this family reports for itself — `min(ownPersisted + 1, maxRetries)`.
   * Clamped at `maxRetries` (not `maxRetries + 1`) because the pass that would exceed the budget
   * parks instead of counting: the register never advances past the budget, so the number in the
   * sentence always EQUALS the register and is always within what the settings declare.
   */
  boundedPassCount: number;
  /**
   * RUFU-395: what the SHARED dispatcher field becomes after this counted pass —
   * `min(persisted + 1, maxRetries + 1)`. The patch builder writes it only when it is strictly
   * greater than `persisted`, so a borrowed-high or legacy-inflated value is neither lowered nor
   * raised and an unchanged value costs no write.
   */
  sharedNext: number;
  /**
   * RUFU-395: when this family's episode first refused, or null when no episode exists yet. The
   * counter patch preserves it, so an episode that restarted its clock every pass could never tell
   * the operator how long the exhaustion has been running (RUFU-350's moving-base lesson).
   */
  ownFirstAt: string | null;
  /** True when this pass is counted AND this family's own attempt exceeds `maxRetries`. */
  terminal: boolean;
  /** False when auto-recovery `mode: "off"` — no counter writes, no terminal park. */
  counted: boolean;
}

/**
 * Read this family's own refusal register off the row. Defensive by construction: a missing,
 * non-object, or malformed episode reads as zero refusals, because the register gates a terminal
 * decision and a corrupt value must never park a card that this layer never refused.
 */
export function readBranchConflictRecoveryEpisode(
  task: Pick<Task, "sourceMetadata">,
): TaskBranchConflictRecoveryEpisode | null {
  const raw = task.sourceMetadata?.[BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<TaskBranchConflictRecoveryEpisode>;
  if (typeof candidate.refusalCount !== "number" || !Number.isFinite(candidate.refusalCount)) return null;
  return {
    refusalCount: Math.max(0, Math.floor(candidate.refusalCount)),
    firstAt: typeof candidate.firstAt === "string" ? candidate.firstAt : "",
    lastAt: typeof candidate.lastAt === "string" ? candidate.lastAt : "",
    lastSource: typeof candidate.lastSource === "string"
      ? candidate.lastSource as TaskBranchConflictRecoveryEpisode["lastSource"]
      : "executor-conflict",
  };
}

/**
 * Derive this pass's bounded recovery budget. `maxRetries` mirrors the dispatcher call
 * sites' fallback (`autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 }`).
 *
 * FNXC:BranchConflictRecovery 2026-11-02-22:20 (RUFU-432): the reported attempt is clamped, so a
 * saturated counter always decides `terminal` and can never raise the number the operator reads
 * above `maxRetries + 1`.
 *
 * FNXC:BranchConflictRecovery 2026-11-04-12:50 (RUFU-395): `terminal` no longer reads that shared
 * counter at all. It reads this family's OWN register. RUFU-432 bounded how a saturated counter is
 * REPORTED but left it as the DECIDER, and the shared field is written by planning
 * (`triage.ts`), by `executor/run-implementation.ts`, and by `non-continuable-session.ts`. Measured
 * live: `recoveryRetryCount` 10 written by a planning layer with ZERO own refusals parked the card
 * on this family's first refusal, and the sentence still read "after 4 bounded passes (budget 3)".
 * One field cannot be both another layer's budget and this layer's ceiling claim.
 */
export function planBranchConflictRecoveryPass(
  task: Pick<Task, "recoveryRetryCount" | "sourceMetadata">,
  autoRecovery: AutoRecoverySettings | undefined,
): BranchConflictRecoveryPass {
  const maxRetries = autoRecovery?.maxRetries ?? 3;
  const counted = autoRecovery?.mode !== "off";
  const persisted = task.recoveryRetryCount ?? 0;
  const episode = readBranchConflictRecoveryEpisode(task);
  const ownPersisted = episode?.refusalCount ?? 0;
  const ownAttempt = ownPersisted + 1;
  const sharedCeiling = counted ? Math.min(persisted + 1, maxRetries + 1) : persisted;
  return {
    persisted,
    attempt: sharedCeiling,
    maxRetries,
    ownPersisted,
    ownFirstAt: episode?.firstAt || null,
    sharedNext: sharedCeiling,
    boundedPassCount: counted ? Math.min(ownAttempt, maxRetries) : ownPersisted,
    terminal: counted && ownAttempt > maxRetries,
    counted,
  };
}

/**
 * The ONE write guard for the recovery registers. Exported so "no counter change" cannot be
 * expressed as a store call: routing an empty patch through `updateTask` is exactly what
 * re-stamps `updated_at`, and a re-stamped `updated_at` is what makes a dead card look alive.
 *
 * A terminal park is not a counted recovery pass, and `mode: "off"` is the operator's opt-out
 * from accounting; neither may touch either register.
 *
 * FNXC:BranchConflictRecovery 2026-11-04-12:55 (RUFU-395): the verdict is now about the FAMILY's
 * register, not the shared field. RUFU-432 returned false here once the SHARED counter saturated,
 * which was correct while the shared field also decided `terminal`; now that another layer can hold
 * the shared counter at 10, that rule would silently stop this family from recording its own
 * refusals. The shared field keeps its own clamp inside the patch builder instead.
 */
export function branchConflictRecoveryCounterShouldWrite(pass: BranchConflictRecoveryPass): boolean {
  return pass.counted && !pass.terminal;
}

/**
 * What the SHARED `recoveryRetryCount` may be written to by a counted pass, or `null` when it must
 * not be written at all. RUFU-395 clamp, stated separately so the rule is testable on its own:
 * advance by exactly one, never past `maxRetries + 1`, and NEVER downward — a row whose shared
 * counter another layer inflated to 10 keeps its 10, because this layer has no authority to hand the
 * dispatcher back a budget another layer decided it had spent. Omitting the field when the value
 * would not change is what keeps a no-op pass from re-stamping the row clock.
 */
export function branchConflictSharedCounterWrite(pass: BranchConflictRecoveryPass): number | null {
  if (!pass.counted || pass.terminal) return null;
  const next = Math.min(pass.persisted + 1, pass.maxRetries + 1);
  return next > pass.persisted ? next : null;
}

/** Patch merged into a non-terminal transient pause/persist so the budget advances in the same write. */
export function branchConflictRecoveryCounterPatch(
  pass: BranchConflictRecoveryPass,
  source: BranchConflictRecoverySource,
): Partial<Pick<Task, "recoveryRetryCount">> & { sourceMetadataPatch?: Record<string, unknown> } {
  if (!branchConflictRecoveryCounterShouldWrite(pass)) return {};
  /*
  FNXC:BranchConflictRecovery 2026-11-04-12:52 (RUFU-395):
  One counted non-terminal pass writes BOTH registers in the SAME statement, so the family's own
  count and the History marker announcing it cannot disagree — the addendum's demand was "the count
  of this family's own refusals read from its own markers", and writing them together is what makes
  that equality structural instead of something a later refactor can break. The episode goes through
  the key-level `sourceMetadataPatch` channel so `duplicateOfTaskIds`/`handoffFrom`/the two planning
  episodes survive.

  The SHARED field is written with its own clamp and is NEVER lowered. A borrowed-high row (planning
  left `recoveryRetryCount` at 10) must keep its 10 — this layer has no authority to hand the
  dispatcher back a bigger budget than another layer decided — and must not be re-raised either
  (RUFU-432's legacy-inflation rule). When the clamped value equals what is already stored, the
  field is omitted entirely rather than written back unchanged, because the write itself re-stamps
  the row clock.

  `firstAt` is preserved from the existing episode: an episode that restarted its clock every pass
  could never tell the operator how long the exhaustion has been running (RUFU-350's lesson about a
  base that moves under you).
  */
  const now = new Date().toISOString();
  const patch: Partial<Pick<Task, "recoveryRetryCount">> & { sourceMetadataPatch?: Record<string, unknown> } = {
    sourceMetadataPatch: {
      [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: {
        refusalCount: pass.boundedPassCount,
        firstAt: pass.ownFirstAt ?? now,
        lastAt: now,
        lastSource: source,
      } satisfies TaskBranchConflictRecoveryEpisode,
    },
  };
  const sharedWrite = branchConflictSharedCounterWrite(pass);
  if (sharedWrite !== null) patch.recoveryRetryCount = sharedWrite;
  return patch;
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
/*
FNXC:BranchConflictRecovery 2026-11-04-13:02 (RUFU-395):
`branchConflictRecoveryParkAlreadyApplied` used to ask the SHARED dispatcher counter whether the
budget was still spent, which made this family's suppression revocable by a write this family did not
make — and, after RUFU-395 moved the terminal decision onto the family register, would have made the
predicate and the decision disagree: a card parked by four OWN refusals whose shared counter some other
lane later zeroed would have been re-admitted and re-parked by a layer that had refused it nothing.

The park hold is now the whole predicate, and it is revocable by exactly one door: `paused` is written
false by `buildAutoPauseClearPatch`, which every operator Retry surface already calls for this reason
(RUFU-432). `error` is deliberately NOT part of it — a retry clears `error`, so a prefix test would
re-admit a retried card while its park reason was still being lifted elsewhere. `userPaused` is
deliberately NOT part of it either: an operator pause is a different disposition with a different exit,
and conflating them would suppress a card this recovery never parked.
*/
export function hasBranchConflictRecoveryParkHold(
  task: Pick<Task, "paused" | "pausedReason">,
): boolean {
  return task.paused === true && task.pausedReason === BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON;
}

export function branchConflictRecoveryParkAlreadyApplied(
  task: Pick<Task, "paused" | "pausedReason" | "recoveryRetryCount" | "sourceMetadata">,
  autoRecovery: AutoRecoverySettings | undefined,
): boolean {
  void autoRecovery;
  return hasBranchConflictRecoveryParkHold(task);
}

/**
 * The Step 2 suppression verdict: this pass must neither mutate the card, announce itself, nor
 * advance the counter, because the card already carries this family's terminal park and git still
 * says the conflict stands.
 *
 * `released` is the caller's re-inspection verdict — true when `inspectBranchConflict` answered
 * anything other than a live conflict. The release check ALWAYS wins, before the hold is even
 * consulted (RUFU-432's preserved contract: a park must never strand a card whose conflict has since
 * resolved on its own, which is why the guard cannot be an admission-level skip of the inspection).
 *
 * FNXC:BranchConflictRecovery 2026-11-04-13:18 (RUFU-395):
 * Before this, the same verdict was spelled three separate times at three arms of ONE sweep, and only
 * that sweep owned it — the executor lane and the auto-recovery dispatcher had no equivalent, so a
 * card parked by the executor re-announced itself on every session start. One predicate, four writers.
 */
export function branchConflictRecoverySuppressed(input: {
  task: Pick<Task, "paused" | "pausedReason" | "recoveryRetryCount" | "sourceMetadata">;
  autoRecovery: AutoRecoverySettings | undefined;
  released: boolean;
}): boolean {
  if (input.released) return false;
  return hasBranchConflictRecoveryParkHold(input.task);
}

/**
 * Operator-facing remedy. Contract (pinned by the RUFU-231 regression suite): names the
 * integration branch and at least one recovery door (retry / reset to todo) so the park is
 * actionable, not just terminal.
 *
 * FNXC:BranchConflictRecovery 2026-11-04-13:04 (RUFU-395): the template bytes and both contract
 * clauses are unchanged; only the NUMBER's source moved, onto `boundedPassCount` — this family's own
 * register. `attempt` was the shared dispatcher counter clamped at `maxRetries + 1`, which is still
 * a number above the declared budget ("after 4 bounded passes (budget 3)") and is still partly
 * another layer's. The park pass never advances the register, so what it prints equals the register
 * and is always within the budget the settings declare.
 */
export function branchConflictRecoveryRemedy(pass: BranchConflictRecoveryPass, integrationBranch: string | undefined, detail: string): string {
  const ref = integrationBranch?.trim() || "main";
  return (
    `Branch-conflict recovery exhausted after ${pass.boundedPassCount} bounded passes (budget ${pass.maxRetries}): ${detail} ` +
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
      /*
      FNXC:BranchConflictRecovery 2026-11-04-13:06 (RUFU-395):
      `boundedPasses` is this family's own count and is the only number on this row that describes
      this family's work. `attempt` stays (dispatcher budget, possibly borrowed) so an existing
      reader keeps its contract; the pair is what stops a reader from conflating the two budgets.
      Same event type, one additive key — no new mutation type is introduced.
      */
      boundedPasses: input.pass.boundedPassCount,
      source: input.source,
      terminal: true,
    },
  });
}

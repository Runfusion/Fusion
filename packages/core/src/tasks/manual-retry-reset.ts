import { BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY, PLAN_ADMISSION_STALL_METADATA_KEY, PLAN_PREMISE_REJECTION_METADATA_KEY, type Task } from "../types.js";
import type { TaskStore } from "../store.js";

export const IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON = "in-review-stall-deadlock";
export const BRANCH_CONFLICT_UNRECOVERABLE_PAUSE_REASON = "branch-conflict-unrecoverable";
/*
FNXC:BranchConflictRecovery 2026-11-02-22:10 (RUFU-432):
The pause reason the branch-conflict recovery's TERMINAL park writes (`buildBranchConflictRecoveryParkPatch`
in `packages/engine/src/recovery/branch-conflict-recovery-accounting.ts`, which imports this constant so the
literal has exactly one spelling across the two packages). It joins the Retry allowlist below because the
park's own remedy sentence names Retry as its door — see the note on `buildAutoPauseClearPatch`.
*/
export const BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON = "branch-conflict-recovery-exhausted";

export const MANUAL_RETRY_RESET_COUNTER_KEYS = [
  "stuckKillCount",
  "resumeLimboCount",
  "executeRequeueLoopCount",
  "graphResumeRetryCount",
  "consecutiveToolFailureRetryCount",
  "recoveryRetryCount",
  "sessionContentionHoldCount",
  "taskDoneRetryCount",
  "worktreeSessionRetryCount",
  "workflowStepRetries",
  "verificationFailureCount",
  "postReviewFixCount",
  "planReviewReplanCount",
  "mergeConflictBounceCount",
  "branchConflictRecoveryCount",
  "reviewerContextRetryCount",
  "reviewerFallbackRetryCount",
  "reviewConvergenceStage",
  "reviewConvergenceEscalationCount",
  "completionHandoffLimboRecoveryCount",
  "mergeAuditBounceCount",
] as const satisfies ReadonlyArray<keyof Task>;

export function buildAutoPauseClearPatch(
  task: Pick<Task, "paused" | "userPaused" | "pausedReason">,
): Partial<Task> {
  /*
  FNXC:BranchConflictRecovery 2026-11-02-22:12 (RUFU-432):
  `branch-conflict-recovery-exhausted` joins this allowlist. It was missing, and the missing entry made
  the park self-contradictory three ways at once: a plain `fn task retry` / `POST /tasks/:id/retry` reset
  the counters and left `paused: true` with the exhausted reason in place, so (a) the remedy text named a
  door the engine refused to walk through, (b) the card needed a second Retry to actually restart, and
  (c) while the pause stood, the park retained `branch`/`worktree` — a dormant file-scope lease on every
  peer card that touches the same branch.

  The clear is safe by the same argument the two existing entries already rest on: this is a recovery
  park the ENGINE authored (an engine-owned disposition, like `in-review-stall-deadlock`), not an operator
  hold, so `userPaused === true` is checked FIRST and an operator's pause is never lifted here. It is also
  what makes the engine's applied-park suppression revocable: `branchConflictRecoveryParkAlreadyApplied`
  stops holding once the counter is zeroed, and this clear is the door the operator actually presses.
  */
  if (
    task.paused === true
    && task.userPaused !== true
    && (
      task.pausedReason === IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON
      || task.pausedReason === BRANCH_CONFLICT_UNRECOVERABLE_PAUSE_REASON
      || task.pausedReason === BRANCH_CONFLICT_RECOVERY_EXHAUSTED_PAUSE_REASON
    )
  ) {
    return {
      paused: false,
      pausedReason: null as unknown as Task["pausedReason"],
    };
  }

  return {};
}

/*
FNXC:BranchConflictRecoveryFence 2026-10-01-08:15:
A manual retry may race a scheduler that inspected the prior branch-conflict failure. The retry
writer must revalidate that generation while holding the task lock, so neither an explicit pause
nor a replacement checkout is cleared by a stale operator snapshot.
*/
export function buildManualRetryResetPatchIfCurrent(
  live: Task,
  expected: Pick<Task, "branch" | "worktree" | "status" | "error" | "paused" | "pausedReason" | "userPaused">,
  patch: Parameters<TaskStore["updateTask"]>[1],
): Parameters<TaskStore["updateTask"]>[1] | null {
  const hasNewerLifecycle = live.branch !== expected.branch
    || live.worktree !== expected.worktree
    || (live.userPaused === true && expected.userPaused !== true);
  if (hasNewerLifecycle) return null;

  return {
    ...patch,
    ...buildAutoPauseClearPatch(live),
  };
}

/**
 * The manual-retry patch shape: a `Partial<Task>` plus the key-preserving `sourceMetadataPatch`
 * writer that `store.updateTask`/`updateTaskAtomic` accept (see RUFU-246 note in the builder).
 */
export type ManualRetryResetPatch = Partial<Task> & { sourceMetadataPatch?: Record<string, unknown> | null };

export function buildManualRetryResetPatch(options?: { resetMergeRetries?: boolean }): ManualRetryResetPatch {
  const patch: ManualRetryResetPatch = {
    /*
    FNXC:PlanPremises 2026-09-16-04:08:
    RUFU-246 — operator Retry is the sanctioned un-park for a card terminally parked on an exhausted
    plan-premise contract, and it lifts the park by clearing the refusal episode. The clear is
    KEY-level (`planPremiseRejection: null` via sourceMetadataPatch), so unrelated sourceMetadata
    provenance keys (duplicate-of, handoff-from) survive a Retry untouched. Without this clear the
    episode's sticky-park signature would re-park the card on its very next release attempt, making
    the Retry a no-op. Every Retry surface (dashboard route branches, column-stage restart) spreads
    this builder, so the lift lives in exactly one place.
    */
    /*
    FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
    The same key-level clear applies to the planning-admission episode. An operator Retry IS the
    operator's answer to "this card is stuck waiting for planning", and leaving the episode behind
    would keep the chip asserting a gate the operator has just overruled — the card would re-show
    "waiting for a planner slot" after the run had already been restarted. Cleared in the same patch
    so both episodes lift together and unrelated provenance keys still survive.
    */
    /*
    FNXC:BranchConflictRecovery 2026-11-04-13:44 (RUFU-395):
    And to this family's own refusal register. RUFU-395 made `refusalCount` the sole authority for the
    terminal park, so a Retry that cleared the pause without clearing the register would be a no-op:
    the next refusal would recompute `ownAttempt = 4 > 3` from the surviving register and re-park the
    card the operator just released. This is the third key in the same patch, so all three lifts land
    in one statement — the acceptance requirement is that after ONE Retry a real conflict can consume
    the full budget again, and that only holds if every number the park reads is reset together.
    `WIP_ADMISSION_STALL_METADATA_KEY` is deliberately NOT cleared here: RUFU-393's episode is a
    state record whose release owner is the hold/release sweep, not the operator (architecture.md §
    Withheld hold→WIP crossing invariant), and RUFU-273's precedent does not generalise to an episode
    whose writer is a capacity gate rather than a refusal the operator is overruling.
    */
    sourceMetadataPatch: {
      [PLAN_PREMISE_REJECTION_METADATA_KEY]: null,
      [PLAN_ADMISSION_STALL_METADATA_KEY]: null,
      [BRANCH_CONFLICT_RECOVERY_EPISODE_METADATA_KEY]: null,
    },
    nextRecoveryAt: null as unknown as Task["nextRecoveryAt"],
    sessionContentionWaitReason: null as unknown as Task["sessionContentionWaitReason"],
    executorEscalationAttempted: false,
    toolFailureDetectorLogCursor: null,
    toolFailureRetryExhaustedAuditEmitted: false,
    // FNXC:Lifecycle 2026-07-16-21:40:
    // FN-8141 — an operator manual retry/edit is an honest exit signal that clears the
    // skip-bypass taint, so a legitimately retried task can promote on its skipped steps.
    bulkCompletionRefusalAt: null as unknown as Task["bulkCompletionRefusalAt"],
  };

  for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
    patch[key] = 0;
  }

  if (options?.resetMergeRetries) {
    patch.mergeRetries = 0;
  }

  return patch;
}

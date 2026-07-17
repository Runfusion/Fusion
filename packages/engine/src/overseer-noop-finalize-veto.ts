/**
 * FNXC:Lifecycle 2026-07-16-09:40:
 * FN-8141 overseer-layer backstop against no-op finalize laundering.
 *
 * Incident: FN-8141 was impossible as specced (an SDK bump broke verify every
 * attempt). The executor reverted the work 5 times; the planner overseer
 * emitted `stage=executor signal=failed` ("Executor stage parked failed with
 * work incomplete") TWICE, then — because the overseer is stage-scoped and
 * memoryless — an hour later classified the same task `stage=merger
 * signal=progressing` and let the AI merger's EMPTY (zero net changes vs main)
 * no-op finalize promote the task to `done`. No reviewer ever saw it (skipped
 * steps request no review; the merge-review pass reviews an empty diff).
 *
 * Restored invariant: a task whose MOST RECENT executor-stage signal is
 * failed-with-incomplete-work, with NO subsequent execution session completing
 * green, must NOT reach `done` via a zero-diff no-op merge finalize. It takes
 * the blocked path instead (error set, durable log entry,
 * `overseer:no-op-finalize-vetoed-failed-executor` run-audit event, moved back
 * to `todo` with progress preserved — mirroring the FN-6461 no-commits blocked
 * lane in `merger-ai.ts`).
 *
 * Two pure, unit-testable pieces (no I/O, never throw), following the FN-7514
 * `evaluateOverseerHumanControl` precedent (pure predicate + ids/outcomes-only
 * audit metadata):
 *   - `deriveExecutorSignalMemory` — reconstructs the most-recent executor
 *     signal from the durable `overseer:intervention` timeline the overseer
 *     already writes (no new persisted column; "the existing oversight state
 *     storage the controller uses").
 *   - `evaluateNoOpFinalizeExecutorVeto` — the veto decision.
 *
 * This composes with, and is independent of, the merger-layer lineage-proof
 * guard (a sibling change): both can fire, and EITHER alone must stop FN-8141.
 *
 * Scope guards, by construction:
 *  - Only a zero-diff (empty) merge is in scope. A NON-empty merge (a real
 *    squash landed) is NEVER vetoed here — reviewers / merge review cover real
 *    diffs; this guard is only for the completion-laundering shape.
 *  - The guard DEFERS (never vetoes) whenever the FN-7514 human-control
 *    predicate withholds oversight (user-paused, approval-blocked, or
 *    `autoMerge:false` / PR-based human-review terminal contract) — it must not
 *    fight user-paused / autoMerge:false semantics; a human owns those tasks.
 */

import type { ExecutorOverseerSignalMemory, PlannerInterventionEntry, Settings, Task } from "@fusion/core";
import { EXECUTOR_FAILED_INCOMPLETE_REASON } from "./planner-overseer.js";
import {
  evaluateOverseerHumanControl,
  type OverseerHumanControlWithholdReason,
} from "./overseer-human-control-policy.js";

/** Minimal task shape the veto needs — narrowed for testability + the human-control delegation. */
export type NoOpFinalizeExecutorVetoTask = Pick<
  Task,
  "userPaused" | "paused" | "pausedReason" | "status" | "autoMerge" | "prInfo" | "prInfos"
>;

export interface NoOpFinalizeExecutorVetoDecision {
  /** `true` when the empty no-op finalize must be blocked (task → todo, progress preserved). */
  veto: boolean;
  /**
   * Present only when `veto` is `true`. A CONSTANT string (no interpolated
   * timestamps/ids) so the run-audit dedup per (taskId, reason) — mirroring
   * `overseer:oversight-withheld-human-control` — is stable across polls.
   */
  reason?: string;
  /**
   * `true` when the guard deferred to the FN-7514 human-control contract and
   * therefore did NOT veto (user-paused / approval-blocked / autoMerge-off).
   * Audit-only signal; `veto` is `false` in this case.
   */
  deferredForHumanControl?: boolean;
  /** The human-control withhold reason, when `deferredForHumanControl` is `true`. */
  humanControlReason?: OverseerHumanControlWithholdReason;
}

/** The constant veto reason — kept stable for (taskId, reason) audit dedup. */
export const NO_OP_FINALIZE_EXECUTOR_VETO_REASON =
  "most recent executor-stage signal was failed-with-incomplete-work and no subsequent execution completed green";

/**
 * FNXC:Lifecycle 2026-07-16-09:40:
 * Pure derivation of the most-recent executor-stage overseer signal from the
 * durable `overseer:intervention` timeline (newest-first, as
 * `getPlannerInterventionTimeline` returns it). Considers ONLY passive
 * observations (`action === "observe"`) on the `executor` stage — steering/
 * retry/escalate entries also carry `stage: "executor"` but their `reason` is a
 * recovery message, not a signal. Returns `null` when there is no executor
 * observation to reason about. Never throws.
 *
 * `incompleteWork` is `true` iff the newest executor observation's reason is the
 * canonical `EXECUTOR_FAILED_INCOMPLETE_REASON`; any later observation
 * (progressing/stuck/blocked/...) supersedes it, which is how "no subsequent
 * execution completed green" is derived.
 */
export function deriveExecutorSignalMemory(
  entries: ReadonlyArray<PlannerInterventionEntry> | null | undefined,
): ExecutorOverseerSignalMemory | null {
  if (!entries || entries.length === 0) {
    return null;
  }
  let newest: PlannerInterventionEntry | null = null;
  for (const entry of entries) {
    if (!entry || entry.stage !== "executor" || entry.action !== "observe") {
      continue;
    }
    if (newest === null || entry.timestamp > newest.timestamp) {
      newest = entry;
    }
  }
  if (!newest) {
    return null;
  }
  const incompleteWork = newest.reason === EXECUTOR_FAILED_INCOMPLETE_REASON;
  const observedAt = Date.parse(newest.timestamp);
  return {
    // The timeline does not carry the raw signal enum; map the one reason we
    // act on back to its signal and label everything else "progressing"
    // (any non-failed executor observation is, for veto purposes, "not
    // failed-with-incomplete-work").
    signal: incompleteWork ? "failed" : "progressing",
    incompleteWork,
    observedAt: Number.isFinite(observedAt) ? observedAt : 0,
  };
}

/**
 * Pure predicate — no I/O, no throws on well-formed input. Decides whether an
 * EMPTY (zero net changes) merge finalize for `task` must be vetoed because the
 * overseer's cross-stage memory says the executor last parked
 * failed-with-incomplete-work and nothing completed green since.
 *
 * Precedence:
 *  1. `mergeIsEmpty === false` → never veto (real diff; reviewers cover it).
 *  2. Missing task → never veto (nothing to reason about; fail open here —
 *     the FN-6461 guard and the sibling lineage guard remain the safety nets).
 *  3. FN-7514 human-control withholds → DEFER (no veto; a human owns the task).
 *  4. `memory.incompleteWork === true` → VETO.
 *  5. Otherwise → no veto.
 */
export function evaluateNoOpFinalizeExecutorVeto(input: {
  /** Whether the landed merge produced zero net changes vs the integration branch. */
  mergeIsEmpty: boolean;
  task: NoOpFinalizeExecutorVetoTask | null | undefined;
  /** Derived most-recent executor overseer signal (see `deriveExecutorSignalMemory`). */
  memory: ExecutorOverseerSignalMemory | null | undefined;
  /** Engine settings for the human-control `allowsAutoMergeProcessing` check; defaults to auto-merge-on. */
  settings?: Pick<Settings, "autoMerge"> | null;
}): NoOpFinalizeExecutorVetoDecision {
  const { mergeIsEmpty, task, memory, settings } = input;

  // (1) A real squash landing is out of scope — never vetoed here.
  if (!mergeIsEmpty) {
    return { veto: false };
  }

  // (2) No task to reason about — fail open; other guards remain in force.
  if (!task) {
    return { veto: false };
  }

  // (3) FN-7514 precedent: never fight user-paused / approval-blocked /
  // autoMerge:false-human-review. Defer to the human in the loop.
  const humanControl = evaluateOverseerHumanControl(task, settings ?? { autoMerge: true });
  if (humanControl.withhold) {
    return {
      veto: false,
      deferredForHumanControl: true,
      humanControlReason: humanControl.reason,
    };
  }

  // (4) Cross-stage memory says the executor last parked
  // failed-with-incomplete-work and nothing progressed since.
  if (memory && memory.incompleteWork === true) {
    return { veto: true, reason: NO_OP_FINALIZE_EXECUTOR_VETO_REASON };
  }

  // (5) Executor last seen healthy (or no memory) → allow the no-op finalize.
  return { veto: false };
}

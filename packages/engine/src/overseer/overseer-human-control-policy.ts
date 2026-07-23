/**
 * FNXC:PlannerOverseer 2026-07-04-15:00:
 * FN-7514 human-control safeguard for the planner overseer chain
 * (FN-7508→FN-7513). Requirement: the planner overseer must be fully inert
 * — no steering, retry, targeted-fix, or FN-7513 confirmation-required
 * action (merge/PR progression, destructive git, external-service side
 * effect) may fire, and no pending confirmation may even be recorded —
 * whenever a task is (a) user-paused, (b) blocked on a pending human
 * approval decision, or (c) not eligible for auto-merge processing per the
 * FN-5147 `autoMerge:false` / PR-based human-review terminal contract. This
 * module supplies a single PURE predicate (`evaluateOverseerHumanControl`,
 * no I/O) that the FN-7512/FN-7513 dispatch seam
 * (`PlannerRecoveryController.tick`) must consult BEFORE any action
 * classification, confirmation gating, steering, retry, or dispatch —
 * mirroring the pure-decision style of `recovery-policy.ts` /
 * `overseer-confirmation-policy`-equivalent `planner-confirmation.ts`.
 *
 * Pause-source distinction (do NOT conflate with engine/self-healing
 * rebounds, which must remain eligible for oversight):
 *  - `task.userPaused === true` is the unambiguous explicit-user-pause
 *    signal (set by a user-source `moveTask(in-progress → todo)` hard
 *    cancel per the Move-Task contract in `store.ts`).
 *  - `task.paused === true` with NO `task.pausedReason` is also treated as
 *    user-source pause: the `fn_task_pause` tool (`TaskStore.pauseTask`)
 *    sets `paused=true` without ever writing `pausedReason`, whereas every
 *    engine/self-healing park path (branch-conflict-unrecoverable,
 *    token_budget_exceeded, in-review-stall-deadlock,
 *    worktrunk_operation_failed, etc.) always stamps a specific
 *    `pausedReason` string when it parks a task. A `paused===true` task that
 *    DOES carry a `pausedReason` is therefore an engine-originated park, not
 *    a user pause, and must NOT withhold oversight on that basis alone (the
 *    separate `allowsAutoMergeProcessing` / autoMerge-off check still
 *    applies independently) — UNLESS that `pausedReason` is specifically the
 *    canonical `AWAITING_APPROVAL_PAUSE_REASON` (see below).
 *
 * FNXC:ApprovalHold 2026-07-09-00:25:
 * FN-7736: a task can also be blocked on a pending human tool-approval
 * decision (`pauseForApproval` -> `pauseTask(id, true, { pausedReason:
 * AWAITING_APPROVAL_PAUSE_REASON })`, or the triage plan-approval gate's
 * `status: "awaiting-approval"`). Before FN-7736 stamped a durable reason,
 * this hold shape (`paused:true`, no reason) was indistinguishable from —
 * and only accidentally covered by — the user-pause branch above. Once the
 * durable reason was introduced, that branch would STOP matching (the task
 * now carries a `pausedReason`), which would silently regress FN-7514's
 * hold. This module therefore checks `isTaskBlockedOnApproval` as its own
 * explicit, non-accidental branch, checked ahead of the user-pause /
 * auto-merge-off checks so introducing the durable reason can never flip an
 * approval-held task from withhold to act.
 *
 * Auto-merge-off / human-review half: delegates verbatim to
 * `allowsAutoMergeProcessing` from `@fusion/core` (the canonical FN-5147
 * predicate `self-healing.ts` already gates lifecycle mutation on) — never
 * re-derive the autoMerge/human-review contract inline here.
 */

import type { Settings, Task } from "@fusion/core";
import { allowsAutoMergeProcessing, isTaskBlockedOnApproval } from "@fusion/core";

export type OverseerHumanControlWithholdReason = "user-paused" | "approval-blocked" | "auto-merge-off-human-review";

export interface OverseerHumanControlDecision {
  /** `true` when the overseer must take NO action of any kind for this task. */
  withhold: boolean;
  /** Present only when `withhold` is `true`. */
  reason?: OverseerHumanControlWithholdReason;
}

/** The minimal task shape the predicate needs — narrowed for testability and to keep the module engine-local/pure. */
export type OverseerHumanControlTask = Pick<Task, "userPaused" | "paused" | "pausedReason" | "status" | "autoMerge" | "prInfo" | "prInfos">;

/** The minimal settings shape the predicate needs (forwarded to `allowsAutoMergeProcessing`). */
export type OverseerHumanControlSettings = Pick<Settings, "autoMerge">;

/**
 * Pure predicate — no I/O, no throws on well-formed input. Returns whether
 * the planner overseer must withhold ALL oversight action for `task`, and
 * why. Precedence: the approval hold is checked first (FN-7736 — a durable,
 * unambiguous marker that must never be shadowed by the weaker
 * accidental-no-reason user-pause heuristic below it), then user-pause, then
 * the FN-5147 auto-merge-off / human-review terminal contract.
 */
export function evaluateOverseerHumanControl(
  task: OverseerHumanControlTask | null | undefined,
  settings: OverseerHumanControlSettings | null | undefined,
): OverseerHumanControlDecision {
  if (!task) {
    // No task to reason about — nothing to withhold from, but also nothing
    // safe to act on. Fail closed with no specific reason (neither withhold
    // reason cleanly applies to a missing task).
    return { withhold: true };
  }

  if (isTaskBlockedOnApproval(task)) {
    return { withhold: true, reason: "approval-blocked" };
  }

  const isUserPaused =
    task.userPaused === true || (task.paused === true && !task.pausedReason);
  if (isUserPaused) {
    return { withhold: true, reason: "user-paused" };
  }

  const settingsForGate: OverseerHumanControlSettings = settings ?? { autoMerge: true };
  if (!allowsAutoMergeProcessing(task, settingsForGate)) {
    return { withhold: true, reason: "auto-merge-off-human-review" };
  }

  return { withhold: false };
}

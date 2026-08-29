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
 *   - `deriveExecutorSignalMemory` — reconstructs the executor signal from the
 *     durable `overseer:intervention` timeline the overseer already writes (no
 *     new persisted column; "the existing oversight state storage the controller
 *     uses") PLUS the durable task log for completion supersession.
 *   - `evaluateNoOpFinalizeExecutorVeto` — the veto decision.
 *
 * FNXC:Lifecycle 2026-07-16-12:10 (follow-up 3):
 * A mid-execution `progressing` observation must NOT clear the veto. The overseer
 * emits `progressing` ("Task is actively executing in-progress work") the moment
 * a task re-enters execution, long before it finishes — so failed-incomplete →
 * requeue → re-execution starts → dies/reverts again (no newer failed
 * observation) once left `progressing` as the newest signal and defeated the
 * veto. A failure park is now superseded ONLY by a clean-completion task-log
 * marker STRICTLY newer than it (the executor stage emits no green-completion
 * observation), never by an in-flight progressing/stuck/blocked signal.
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

import type { ExecutorOverseerSignalMemory, PlannerInterventionEntry, Settings, Task, TaskLogEntry } from "@fusion/core";
import { CLEAN_COMPLETION_MARKERS } from "@fusion/core";
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

/** Minimal task-log shape the supersession check needs — narrowed for testability. */
export type ExecutorSignalMemoryLogEntry = Pick<TaskLogEntry, "action" | "timestamp">;

/** Bound the task-log tail scan; the merger calls this per empty-lane finalize. */
const MAX_LOG_SCAN = 250;

/**
 * FNXC:Lifecycle 2026-07-16-12:10:
 * Newest (most-recent-timestamp) durable clean-completion marker in the task log,
 * as epoch-ms, or `null` when none is present / parseable. Scans the tail only
 * (log is append-ordered) and reuses the SHARED `CLEAN_COMPLETION_MARKERS` set
 * from `evaluateCompletedPromotionFailureProvenance` so the accepted-completion
 * vocabulary stays single-sourced (no string drift; picks up sibling edits to
 * that list automatically). Pure; never throws.
 */
function newestCleanCompletionMarkerMs(
  taskLog: ReadonlyArray<ExecutorSignalMemoryLogEntry> | null | undefined,
): number | null {
  if (!taskLog || taskLog.length === 0) {
    return null;
  }
  const scanFloor = Math.max(0, taskLog.length - MAX_LOG_SCAN);
  let newestMs: number | null = null;
  for (let i = taskLog.length - 1; i >= scanFloor; i--) {
    const action = taskLog[i]?.action ?? "";
    if (!CLEAN_COMPLETION_MARKERS.some((marker) => action.includes(marker))) {
      continue;
    }
    const ms = Date.parse(taskLog[i]?.timestamp ?? "");
    if (Number.isFinite(ms) && (newestMs === null || ms > newestMs)) {
      newestMs = ms;
    }
  }
  return newestMs;
}

/**
 * FNXC:Lifecycle 2026-07-16-12:10:
 * Pure derivation of the executor-stage overseer signal memory from the durable
 * `overseer:intervention` timeline PLUS the durable task log. Considers ONLY
 * passive observations (`action === "observe"`) on the `executor` stage —
 * steering/retry/escalate entries also carry `stage: "executor"` but their
 * `reason` is a recovery message, not a signal. Returns `null` when there is no
 * executor observation to reason about. Never throws.
 *
 * TIGHTENED (FN-8141 follow-up 3): the earlier version took the NEWEST executor
 * observation and cleared `incompleteWork` whenever it was anything but the
 * canonical failed reason. But the overseer emits a `progressing` observation
 * ("Task is actively executing in-progress work") the moment a task re-enters
 * execution — long before that execution finishes. So a shape of
 * failed-incomplete → requeue → re-execution starts (progressing observed) →
 * execution dies/reverts again with NO newer failed observation left the newest
 * observation as `progressing` and DEFEATED the veto, laundering an empty no-op
 * finalize to `done`. `progressing` is not "completed green".
 *
 * New rule — a failure park is superseded ONLY by genuine completion-family
 * evidence NEWER than it, never by an in-flight `progressing`/`stuck`/`blocked`
 * signal:
 *  1. Find the newest executor `observe` whose reason is
 *     `EXECUTOR_FAILED_INCOMPLETE_REASON` (the failure park). No failure park at
 *     all ⇒ `incompleteWork: false`.
 *  2. `incompleteWork` stays TRUE unless a clean-completion marker in the task
 *     log is STRICTLY NEWER than that failure park. The executor stage emits no
 *     "completed green" observation (planner-overseer.ts writes only
 *     progressing/failed/stuck/blocked for `executor`), so the durable task-log
 *     `CLEAN_COMPLETION_MARKERS` are the sole supersession evidence.
 *  3. A malformed/unparseable failure timestamp fails SAFE (cannot prove a
 *     completion is newer ⇒ stays vetoed).
 */
export function deriveExecutorSignalMemory(
  entries: ReadonlyArray<PlannerInterventionEntry> | null | undefined,
  taskLog?: ReadonlyArray<ExecutorSignalMemoryLogEntry> | null,
): ExecutorOverseerSignalMemory | null {
  let newestObs: PlannerInterventionEntry | null = null;
  let newestFailed: PlannerInterventionEntry | null = null;
  for (const entry of entries ?? []) {
    if (!entry || entry.stage !== "executor" || entry.action !== "observe") {
      continue;
    }
    if (newestObs === null || entry.timestamp > newestObs.timestamp) {
      newestObs = entry;
    }
    if (entry.reason === EXECUTOR_FAILED_INCOMPLETE_REASON) {
      if (newestFailed === null || entry.timestamp > newestFailed.timestamp) {
        newestFailed = entry;
      }
    }
  }
  // No executor observation at all → no memory to reason about.
  if (!newestObs) {
    return null;
  }
  // No failure park in the timeline → nothing to veto; the executor never
  // parked failed-with-incomplete-work.
  if (!newestFailed) {
    const observedAt = Date.parse(newestObs.timestamp);
    return { signal: "progressing", incompleteWork: false, observedAt: Number.isFinite(observedAt) ? observedAt : 0 };
  }

  const failedAtMs = Date.parse(newestFailed.timestamp);
  const completionAtMs = newestCleanCompletionMarkerMs(taskLog);
  // Supersession requires a clean completion STRICTLY newer than the failure
  // park. A NaN failure timestamp cannot be proven older than any completion, so
  // it fails safe (stays vetoed).
  const superseded = completionAtMs !== null && Number.isFinite(failedAtMs) && completionAtMs > failedAtMs;
  if (superseded) {
    return { signal: "progressing", incompleteWork: false, observedAt: completionAtMs };
  }
  return { signal: "failed", incompleteWork: true, observedAt: Number.isFinite(failedAtMs) ? failedAtMs : 0 };
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

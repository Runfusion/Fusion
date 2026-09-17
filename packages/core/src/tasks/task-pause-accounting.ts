import type { Task } from "../types.js";

/**
 * FNXC:TaskPauseAccounting 2026-09-16-06:16:
 * FN-457 — the ONE place that opens and closes a task's pause segment.
 *
 * WHY A SHARED HELPER RATHER THAN ARITHMETIC AT THE PAUSE SEAM: eight seams in `packages/core/src`
 * write `task.paused` (explicit pause/unpause, `updateTask`, agent-unassign auto-unpause, artifact
 * cleanup, lifecycle reset, reopen-into-planning, legacy adoption, and the in-review stall SQL
 * patch). Banking pause at `pauseTaskImpl` alone leaves segments opened there and cleared elsewhere,
 * never closed — and a reader that keeps subtracting a segment that ended hours ago produces a chip
 * MORE wrong than the wall clock this work replaced.
 *
 * CONTRACT (each clause is covered by a named case in `pause-active-time-accounting.test.ts`):
 * - Becoming paused while the card is in a WIP lane and no segment is open sets `pausedStartedAt`.
 * - Becoming un-paused while a segment is open banks `cumulativePausedMs += max(0, now - start)`
 *   and clears `pausedStartedAt`. It banks exactly once.
 * - A pause taken OUTSIDE a WIP lane opens no segment: there is no live execution segment for it to
 *   be subtracted from, so banking it would over-deduct.
 * - A second consecutive pause does NOT open a second segment (the first one is still running).
 * - A resume with no open segment is a no-op — never a negative or fabricated bank.
 * - A malformed or future `pausedStartedAt` banks 0 rather than a negative value.
 *
 * WHAT THIS MUST NEVER TOUCH: `executionStartedAt`, `firstExecutionAt`, and `cumulativeActiveMs`.
 * `packages/engine/src/self-healing.ts` and `executor/release-pre-execution-worktree.ts` read those
 * as freshness/resume anchors; shifting them at pause time would move recovery decisions, which is
 * far outside a display fix. Pause accounting is display evidence only.
 *
 * Readers live in `packages/dashboard/app/utils/taskTiming.ts` and `tasks/task-timing.ts`; they
 * additionally ignore an ORPHANED `pausedStartedAt` (set while the card is no longer paused), which
 * is the reader-side valve for a historical row or a future eighth seam that slips the wiring.
 */
export type PauseAccountingTask = Pick<Task, "column" | "cumulativePausedMs" | "pausedStartedAt">;

/**
 * FNXC:TaskPauseAccounting 2026-09-16-06:16:
 * DELIBERATE-LITERAL, named once. Callers resolve the card's real wip lane and fall back to this id
 * only when the workflow cannot be resolved at all. Naming it keeps the lifecycle-column literal
 * ratchet honest: the id lives in one place instead of being re-typed at each accounting seam.
 */
export const LEGACY_WIP_COLUMN_FALLBACK = "in-progress";

/** Mutates `task`'s pause accounting in place for a transition to `nextPaused`. */
export function applyPauseAccounting(
  task: PauseAccountingTask,
  nextPaused: boolean,
  nowIso: string,
  isWipLane: boolean,
): void {
  if (nextPaused) {
    if (!isWipLane) return;
    if (task.pausedStartedAt) return;
    task.pausedStartedAt = nowIso;
    return;
  }

  const startedMs = Date.parse(task.pausedStartedAt ?? "");
  if (!Number.isFinite(startedMs)) {
    // No open segment (or an unparseable one): clear the anchor without banking anything.
    if (task.pausedStartedAt !== undefined) task.pausedStartedAt = undefined;
    return;
  }

  const endMs = Date.parse(nowIso);
  const elapsedMs = Number.isFinite(endMs) ? Math.max(0, endMs - startedMs) : 0;
  task.cumulativePausedMs = Math.max(0, task.cumulativePausedMs ?? 0) + elapsedMs;
  task.pausedStartedAt = undefined;
}

/**
 * Patch-shaped variant for seams that build an update object instead of mutating a task
 * (`updateTask` payloads, legacy adoption patches). Returns only the fields that change.
 */
export function computePauseAccountingPatch(
  task: PauseAccountingTask,
  nextPaused: boolean,
  nowIso: string,
  isWipLane: boolean,
): { cumulativePausedMs?: number; pausedStartedAt?: string | undefined } {
  const draft: PauseAccountingTask = {
    column: task.column,
    cumulativePausedMs: task.cumulativePausedMs,
    pausedStartedAt: task.pausedStartedAt,
  };
  applyPauseAccounting(draft, nextPaused, nowIso, isWipLane);

  const patch: { cumulativePausedMs?: number; pausedStartedAt?: string | undefined } = {};
  if (draft.cumulativePausedMs !== task.cumulativePausedMs) patch.cumulativePausedMs = draft.cumulativePausedMs;
  if (draft.pausedStartedAt !== task.pausedStartedAt) patch.pausedStartedAt = draft.pausedStartedAt;
  return patch;
}

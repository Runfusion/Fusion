import type { Task } from "@fusion/core";

/**
 * FNXC:TaskRevert 2026-07-04-00:00:
 * FN-7524 stamps an AI-undo task with `sourceMetadata.revertOf = <sourceTaskId>`
 * (see `REVERT_OF_METADATA_KEY` in `packages/engine/src/task-revert.ts`) — this is
 * the sole authoritative undo→source pointer written by `createAiUndoTask`. The
 * backend deliberately does NOT set `sourceParentTaskId` for undo tasks (that field
 * is owned by refine/duplicate lineage and child-task counting), so this helper only
 * falls back to `sourceParentTaskId` defensively for forward-compatibility with a
 * future backend shape; today it always resolves via `revertOf`.
 *
 * The `sourceParentTaskId` fallback is gated to `sourceType === "recovery"` (the
 * sourceType `createAiUndoTask` stamps). `task_refine`/`task_duplicate` tasks also
 * set `sourceParentTaskId`, but for an UNRELATED lineage relationship that already
 * renders its own "Created via Refinement/Duplicate of <id>" provenance clause
 * (`getProvenanceLabel` in TaskDetailModal.tsx) — without this gate, an undo-of
 * clause would double-render alongside it for the same id.
 *
 * FN-7555 (this task) surfaces this marker bi-directionally in the dashboard only —
 * no new API, no backend changes. Both `TaskCard` and `TaskDetailModal` import this
 * helper (and `findOpenUndoTaskForSource` below) so the forward/reverse affordances
 * never disagree about what counts as "an undo relationship".
 */
/**
 * FNXC:TaskRevert 2026-07-16-00:00:
 * FN-8066 considers a source task reverted only when the route persisted a
 * non-blank `revertedAt` marker after a clean or already-reverted git outcome.
 * Keep this defensive predicate shared so every card/detail consumer applies the
 * same provenance contract to untyped historical source metadata.
 */
export function isTaskReverted(sourceMetadata: Task["sourceMetadata"] | undefined): boolean {
  return typeof sourceMetadata?.revertedAt === "string" && sourceMetadata.revertedAt.trim().length > 0;
}

export function getRevertOfId(
  sourceMetadata: Task["sourceMetadata"] | undefined,
  sourceParentTaskId?: string | null,
  sourceType?: string,
): string | undefined {
  const revertOf = sourceMetadata?.revertOf;
  if (typeof revertOf === "string" && revertOf.trim().length > 0) {
    return revertOf.trim();
  }

  if (
    sourceType === "recovery"
    && typeof sourceParentTaskId === "string"
    && sourceParentTaskId.trim().length > 0
  ) {
    return sourceParentTaskId.trim();
  }

  return undefined;
}

/**
 * FNXC:TaskRevert 2026-07-04-00:00:
 * Reverse lookup: given the full loaded `tasks` list and a source task id, find the
 * most recently created OPEN undo task that points back at it via `revertOf`. This
 * mirrors `TaskStore.findOpenRevertTaskForSource` (packages/core/src/store.ts)
 * client-side: `done`/`archived`/soft-deleted undo tasks are intentionally excluded
 * so a completed or discarded undo attempt never renders as an active "Undo task"
 * link (no stale/leftover affordance). When multiple open undo tasks exist (should
 * not normally happen given the route's own dedup guard, but the UI must stay
 * defensive), the most recently created one wins.
 */
/*
FNXC:WorkflowResolvedColumns 2026-07-30-11:30 (batch-dashboard-app):
`columnFlags` is a per-task lookup supplied by the caller; omitted -> the legacy pair, i.e. today's
behaviour. This searches for an OPEN undo task, so a finished one must be skipped. Keyed on the
literals, a renamed board never skipped anything: a completed undo task counted as still open, and
the UI offered to resume work that had already landed.
*/
export function findOpenUndoTaskForSource(tasks: readonly Task[], sourceTaskId: string): Task | undefined {
  const trimmedSourceId = sourceTaskId.trim();
  if (trimmedSourceId.length === 0) {
    return undefined;
  }

  let best: Task | undefined;
  for (const candidate of tasks) {
    if (candidate.deletedAt) {
      continue;
    }
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-22:40 (REVERTED — the seam had no supplier):
    STILL A LITERAL, deliberately, and left counted.

    I converted this and added a `columnFlags` parameter. Its only caller is TaskDetailModal ~line
    926, which sits ~60 lines ABOVE where `detailColumnFlags` is derived, so it could not supply one.
    The parameter was therefore never passed: the guard was gone, the census counted a conversion,
    and the behaviour was the legacy fallback forever.

    Reverted rather than left as a dead seam. An unsupplied optional parameter is strictly worse than
    the literal — the literal is at least honest, and the census keeps pointing here. Unblocking it
    means hoisting the flags derivation above that call, which is a hook-ordering change in a
    5000-line component (same blocker as the near-duplicate gate in that file).
    */
    if (candidate.column === "done" || candidate.column === "archived") {
      continue;
    }
    if (getRevertOfId(candidate.sourceMetadata) !== trimmedSourceId) {
      continue;
    }
    if (!best || new Date(candidate.createdAt).getTime() > new Date(best.createdAt).getTime()) {
      best = candidate;
    }
  }

  return best;
}

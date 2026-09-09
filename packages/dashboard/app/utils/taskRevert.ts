import type { Task } from "@fusion/core";
import { isTerminalColumnRole, type ColumnRoleTraitFlags } from "@fusion/core/column-roles";

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

/**
 * FNXC:TaskRevert 2026-08-01-19:51:
 * A successful revert is not completed work. Keep its persisted column intact for
 * provenance, but partition it out of ordinary completed collections so every host
 * can expose one consistent resolution path instead of silently losing the task.
 */
export function partitionRevertedTasks<T extends Task>(tasks: readonly T[]): { normal: T[]; reverted: T[] } {
  const normal: T[] = [];
  const reverted: T[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    (isTaskReverted(task.sourceMetadata) ? reverted : normal).push(task);
  }
  return { normal, reverted };
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
 * client-side: Complete and soft-deleted undo tasks are intentionally excluded
 * so a completed or discarded undo attempt never renders as an active "Undo task"
 * link (no stale/leftover affordance). When multiple open undo tasks exist (should
 * not normally happen given the route's own dedup guard, but the UI must stay
 * defensive), the most recently created one wins.
 */
/*
FNXC:WorkflowResolvedColumns 2026-07-30-11:30 (batch-dashboard-app):
`columnFlags` is a per-task lookup supplied by the caller; omitted -> the legacy `done` fallback. This searches for an OPEN undo task, so a finished one must be skipped. Keyed on the
literals, a renamed board never skipped anything: a completed undo task counted as still open, and
the UI offered to resume work that had already landed.
*/
export function findOpenUndoTaskForSource(
  tasks: readonly Task[],
  sourceTaskId: string,
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:20:
  PER-NEIGHBOUR flags, keyed by task id — the thing the note below said did not exist. Optional and
  fail-soft: a candidate the map does not cover yields `undefined` and the role helper falls back to
  the legacy ids, which is the documented degraded answer rather than a fabricated one.
  */
  flagsByTaskId?: ReadonlyMap<string, ColumnRoleTraitFlags>,
): Task | undefined {
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

    I converted this and added a `columnFlags` parameter — SINCE REMOVED, so this function takes only
    `(tasks, sourceTaskId)` today. Its only caller is TaskDetailModal ~line 926, which sits ~60 lines
    ABOVE where `detailColumnFlags` is derived, so it could not supply one. The parameter was therefore
    never passed: the guard was gone, the census counted a conversion, and the behaviour was the legacy
    fallback forever.

    Reverted rather than left as a dead seam. An unsupplied optional parameter is strictly worse than
    the literal — the literal is at least honest, and the census keeps pointing here.

    FNXC:WorkflowResolvedColumns 2026-07-30-20:50 (correcting the unblock recorded above):
    HOISTING THE FLAGS WOULD NOT UNBLOCK THIS — the column classified here belongs to a NEIGHBOUR, and
    `detailColumnFlags` describes the MODAL'S OWN task. Supplying it would answer "is this neighbour
    finished?" with a different row's traits — wrong on data, not merely stale on vocabulary.

    FNXC:WorkflowResolvedColumns 2026-07-31-23:20 (CONVERTED — the blocker named the wrong variable):
    Both notes above are right that `detailColumnFlags` is the wrong supplier. The conclusion drawn
    from that — "the modal does not have per-neighbour flags and should not fetch mid-render" — is
    false, and the counter-example is in the same component.

    `columnFlagsByTaskId` is a per-task map, already a prop of TaskDetailModal (declared :367,
    destructured :727), and the call site at :992 is BELOW that destructure. TaskDetailModal itself
    already uses it exactly this way for the near-duplicate canonical
    (`columnFlagsByTaskId?.get(nearDuplicateCanonical.id)`), under a note making the same point: the
    blocker there had been "asserted from the shape of the problem rather than tested against what was
    in scope". This is the same assertion, one function over.

    So the supplier the 22:40 note went looking for exists, it is per-neighbour, and it needs no fetch.
    The parameter is supplied at the only call site in the same commit, so this is not a dead seam.
    */
    if (isTerminalColumnRole(flagsByTaskId?.get(candidate.id), candidate.column)) {
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

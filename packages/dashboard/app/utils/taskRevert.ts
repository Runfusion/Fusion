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

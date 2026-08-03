/**
 * FNXC:CodeOrganization 2026-08-03-12:50:
 * Pause/abort provenance union + classifier peeled from executor.ts (U4 Slice A).
 */

/*
FNXC:WorkflowLifecycle 2026-07-26-11:20:
KB-PROV: Provenance of a pause/abort marker, in one named union so the ~10 signatures that pass it around cannot drift apart.

- `hard-cancel` — OPERATOR withdrawal only. AGENTS.md "Move-Task contract": user `moveTask(in-progress -> todo)`, task soft-delete, and a user-sourced move out of a planning lane. These carry `userCanceled: true` into `awaitAbortInFlightTaskWork`.
- `engine-abort` — ENGINE/lifecycle teardown with no operator intent: workflow rerun bounces, archive disposal, approval-gate suspension, engine-sourced moves, `abortAllInFlight` (shutdown/global stop), stuck-kill force-requeue. Before KB-PROV these were mislabeled `hard-cancel`.
- `global-pause` / `merge-seam` / `completion-finalize` — unchanged FN-6568/FN-6625 seams.

`hard-cancel` and `engine-abort` are the two "generic" aborts; test them together with `isGenericAbortProvenance()`.
*/
export type PausedAbortProvenance = "global-pause" | "merge-seam" | "hard-cancel" | "engine-abort" | "completion-finalize";

/*
FNXC:WorkflowLifecycle 2026-07-26-11:20:
KB-PROV: The benign-abort classifiers in handleGraphFailure were written against the pre-split `hard-cancel` catch-all and exist PRECISELY to recover engine-initiated aborts (FN-6796, FN-6735, FN-7143, FN-7214, FN-7749). Splitting the label must not narrow them, so every former `=== "hard-cancel"` test routes through this predicate. Operator intent is still discriminated where it matters by `userCanceledTaskIds` / `live.userPaused`, never by the label alone.
*/
export function isGenericAbortProvenance(provenance: PausedAbortProvenance | undefined): boolean {
  return provenance === "hard-cancel" || provenance === "engine-abort";
}

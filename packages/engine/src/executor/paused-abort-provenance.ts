/**
 * FNXC:CodeOrganization 2026-08-03-12:50:
 * Pause/abort provenance union + classifier peeled from executor.ts (U4 Slice A).
 *
 * FNXC:WorkflowLifecycle 2026-06-17-03:42:
 * FN-6568 separates pause provenance from the legacy pausedAborted hard-cancel bit. Merge-seam/internal aborts caused FN-6528/FN-6531/FN-6534/FN-6537 to look like pause/resume aborts and left mergeRetries=NULL, so handleGraphFailure must know whether the abort came from global pause, the merge seam, or a generic hard cancel before choosing operator-action parking.
 *
 * FNXC:WorkflowLifecycle 2026-06-17-23:31:
 * FN-6625 adds completion-finalize provenance for the FN-6614 symptom where a completed/no-commit execution already handed off to in-review, then a trailing graph abort looked like a pause/resume engine abort and re-parked the task failed. Completion-finalize is sibling provenance to FN-6568 merge-seam, not operator pause intent.
 *
 * FNXC:WorkflowLifecycle 2026-07-26-11:20:
 * KB-PROV: `hard-cancel` had become a catch-all bucket: `awaitAbortInFlightTaskWork` stamped it unconditionally, so an ENGINE-initiated teardown was labeled with the provenance AGENTS.md reserves for the operator Move-Task hard cancel ("User moveTask(in-progress -> todo) is a hard cancel ... Engine rebounds must not set userPaused"). Observed on FN-8596: the graph's own `performWorkflowRerunBounce` (in-progress -> todo -> in-progress re-dispatch, moveSource "engine") logged `provenance=hard-cancel source=abort-in-flight:parent moved from in-progress to todo` even though `userCanceled` was correctly false and `userPaused` was never set. Behaviour was right, the LABEL lied.
 *
 * `engine-abort` splits that bucket: `hard-cancel` now means ONLY an operator withdrawal (`options.userCanceled === true`), `engine-abort` means an engine/lifecycle teardown. Both are "generic" (non-global-pause, non-merge-seam, non-completion-finalize) aborts, so every downstream classifier that used to accept `hard-cancel` must accept BOTH via `isGenericAbortProvenance()` — those classifiers exist FOR the engine case (see FN-6796's note that "an engine restart/pause-resume abort reaches graph-failure handling as `hard-cancel` provenance even when no user canceled the task") and discriminate real user intent through `userCanceledTaskIds`, not through the provenance label. Narrowing them to `hard-cancel` alone would strand benign engine aborts as operator-action failures.
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

/*
FNXC:PostMergeProducerSurface 2026-11-02-18:16 (RUFU-450):
Whether a required post-merge gate can STILL receive its evidence row was, until this card, answered only
from workflow bookkeeping (`workflowStepResults`, the IR, continuation rows) plus a column trait. Two
measured boards proved that question is unanswerable from bookkeeping:

- VLLM-081 (singular): the merge landed, the branch was gone (`task:auto-rebind-skipped`
  `reason=no-live-branch`), no post-merge work item had ever been created, and the finalize fast path
  demanded the row anyway — 5 `task:auto-merge-finalize-column-mismatch-no-action` audit rows inside the
  single minute 19:44, and nothing released the card until an operator waiver.
- RUFU-326: merge confirmed (`mergeConfirmed: true`, `main..fusion/rufu-326` = 0/0, clean tree) with a
  NON-NULL stale `task.branch`, zero gate rows, and a re-seed attempt refused
  `[post-merge gate reseed: active-continuation]`. So "no post-merge work item was ever created" is false
  here: the row exists and simply has nothing left to dispatch.

The task's own pointers cannot decide this either. Post-landing cleanup clears `worktree` alone
(`post-landing-worktree-cleanup.ts` writes `{ worktree: null }`) and leaves `branch` populated with a
stale name, so a `task.branch === null && task.worktree === null` test can NEVER fire on a landed card —
it is a prohibited reachability predicate, not a conservative one.

This module therefore holds only the OBSERVATION the engine reports and the pure rule over it. Core never
shells out and never touches the filesystem (same split as `post-merge-evidence-contract.ts`, RUFU-430,
whose injectable-observation shape this mirrors); the engine half lives in
`packages/engine/src/merge/post-merge-producer-surface.ts`.

Deliberately absent from this shape:
- No refusal reason, sentence, error text, SHA, ref tip, or branch name. A verdict derived from a seam
  outcome is an admission result, not a delivery fact — and the re-seed seam refuses `gate-not-resumable`
  BEFORE it would ever produce `active-continuation`, so a seam-derived verdict resolves `missing` exactly
  on RUFU-326's card.
- No `mergeDetails` on the readers' public `Pick<>`. The durable-landing leg rides in the observation
  instead, so `complete-column-gate-evidence.ts` (which passes a narrower task projection and no
  contract) compiles untouched.
- `"unknown"` is never an exemption. An unreadable repository must keep today's demand, not relax it.
*/

/** The git verdict for the card's delivery ref, measured from the project root, never from task pointers. */
export type PostMergeProducerSurface =
  /** `git show-ref --verify --quiet refs/heads/<ref>` proves the ref is gone. */
  | "ref-absent"
  /** The ref exists and `git merge-base --is-ancestor <ref> <target>` succeeds: zero commits the target lacks. */
  | "ref-merged"
  /** The ref exists and still carries at least one commit the merge target does not have. */
  | "ref-divergent"
  /** The probe failed, timed out, the root was unavailable, or the merge target could not be resolved. */
  | "unknown";

/**
 * What the engine observed about one card's ability to still PRODUCE its post-merge evidence row.
 *
 * Field order is the order the engine measures them: git first, then the read-only dispatchability read,
 * with the durable-landing leg carried from the row's own `mergeDetails`.
 */
export interface PostMergeProducerSurfaceObservation {
  surface: PostMergeProducerSurface;
  /** `task.mergeDetails?.mergeConfirmed === true` — the durable-landing leg. Absent/false never exempts. */
  mergeConfirmed: boolean;
  /**
   * The engine's READ-ONLY answer to "can any producer of this card still be advanced without performing
   * a repair write first?". Absent or true is never an exemption: an installed, scheduler-claimable,
   * lease-owned, or owner-held continuation must never be pre-empted by this rule.
   */
  producerCanRun?: boolean;
}

/**
 * True only when the landing is durable AND the git verdict is conclusive AND nothing can still run.
 *
 * `"ref-divergent"` (the target genuinely still owes this card's commits), `"unknown"` (we could not ask),
 * a missing observation, and `producerCanRun: true` all keep the demand for evidence. A negative verdict
 * from the gate itself is handled by the ladder's `not-approved` arm and is never laundered here.
 */
export function isPostMergeProducerUnreachable(
  observation: PostMergeProducerSurfaceObservation | undefined,
): boolean {
  if (!observation) return false;
  if (observation.mergeConfirmed !== true) return false;
  if (observation.producerCanRun !== false) return false;
  return observation.surface === "ref-absent" || observation.surface === "ref-merged";
}

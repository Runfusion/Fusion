import { CODE_REVIEW_GROUP_ID } from "./builtin-code-review-group.js";

/*
FNXC:ReviewVerdictState 2026-10-19-12:20 (RUFU-369):
"Has a code-review verdict already been recorded for this card?" and "did this card ever ask for a code review?"
were private to `scheduling/review-dispatch-sweep.ts`, which is the DISPATCH authority. RUFU-369 found the same
question being answered by a second authority — the reviewer lane's heartbeat wake — with no answer at all: a
reviewer-capability agent holding a bind on a card whose lifecycle cannot carry an open `code-review` gate was
woken anyway (RUFU-350: `done`, landed, gate already approved; RUFU-365/366: `todo`, zero steps run,
`**No commits expected:** true`), and a reviewer session has no verdict surface after U10, so the wake burned a
whole session on a gate that does not exist.

The two predicates live here so the dispatch sweep and the wake seam answer from ONE implementation and cannot
drift. STATE, not authority: `review-verdict-authority.ts` answers "must this step author a structured verdict",
and `merge/required-pre-merge-steps.ts` answers "which gates must the merge door see"; this module answers only
"does the row already carry one".
*/

/**
 * The lane's own authority on "review happened": a non-superseded code-review step result that
 * carries an authored outcome.
 * FNXC:ReviewLaneDispatch 2026-09-16-13:22 (#3619 review G2):
 * `skipped` counts only when a named authority skipped the step (`bypassedBy`, FN-7720) — that is
 * a recorded human decision. A `skipped` with a `notRunReason` and no bypass is the MISSING-review
 * shape this sweep exists to rescue: the merge gate refuses to approve on it for exactly the same
 * reason, so treating it as a verdict would hide the card from both authorities at once.
 * `failed`/`advisory_failure` are authored review outcomes: their re-run belongs to the bounded
 * remediation authority (failed-pre-merge-step recovery, FN-7720 bypass), and dispatching a second
 * review here would race it. Superseded results (a newer commit invalidated them) and `pending`
 * results (dispatched, verdict never delivered) must not count, or the sweep would call an
 * unanswered review a completed one.
 */
export function hasRecordedCodeReviewVerdict(
  task: { workflowStepResults?: readonly WorkflowStepResultLike[] | null },
): boolean {
  return (task.workflowStepResults ?? []).some(
    (result) =>
      result.workflowStepId === CODE_REVIEW_GROUP_ID &&
      result.supersededAt == null &&
      (result.status === "passed" ||
        ((result.status === "failed" || result.status === "advisory_failure") &&
          carriesAuthoredReviewOutcome(result)) ||
        (result.status === "skipped" && result.bypassedBy != null)),
  );
}

/*
FNXC:ReviewDispatch 2026-10-04-17:25 (RUFU-343):
The `failed` / `advisory_failure` arm above used to count ANY row with that status, on the premise that such a
row is an authored reviewer outcome. Measured on production it is not always one: SANE-406/468/504/531 carry
`code-review -> {status: "failed", verdict: null, bypassedBy: null}` with ZERO completed reviewer runs
(`task_reviewer_runs`: 3 rows, 0 completed, 2 invalidated), while their `plan-review` row on the same card does
carry a real verdict. An evidence-free failure row is the exact shape this sweep exists to rescue, and counting
it as a verdict made the card invisible to BOTH authorities at once: dispatch said `verdict-recorded` while the
merge gate refused the same reason.
The authority split stays: a failure that carries its verdict (REVISE/RETHINK/UNAVAILABLE) or an operator bypass
is still authored work, owned by failed-pre-merge-step recovery and FN-7720, and must not be re-dispatched here.
Only the row with no authored evidence at all stops counting.
*/
export function carriesAuthoredReviewOutcome(result: { verdict?: unknown; bypassedBy?: unknown }): boolean {
  return result.verdict != null || result.bypassedBy != null;
}

/** The step-result shape both predicates read; declared structurally so the module stays import-light. */
export interface WorkflowStepResultLike {
  workflowStepId?: string;
  status?: string;
  supersededAt?: string | null;
  verdict?: unknown;
  bypassedBy?: unknown;
}

/*
FNXC:ReviewVerdictState 2026-10-19-12:20 (RUFU-369):
`enabledWorkflowSteps` is the runtime source of truth for which optional review groups a card
wants (reviewLevel is creation-time only). An unset list means the card never restricted
itself, so only an explicit list without code-review counts as a deliberate exclusion.
*/
export function isCodeReviewExcluded(task: {
  reviewLevel?: number;
  enabledWorkflowSteps?: readonly string[] | null;
}): boolean {
  if (task.reviewLevel === 0) return true;
  const enabled = task.enabledWorkflowSteps;
  return Array.isArray(enabled) && !enabled.includes(CODE_REVIEW_GROUP_ID);
}

/**
 * The card's own durable authorization that it lands with zero commits — plan-declared
 * `**No commits expected:** true`, the same flag `merge/zero-commit-landing-proof.ts` accepts as the reason
 * git has nothing to show, and the flag `merge/no-commits-finalize-guard.ts` lets finalize a zero-diff lane
 * WITHOUT an approved code review. A card carrying it therefore has no reviewable diff by its own contract,
 * so it is excluded from reviewer dispatch on both authorities.
 */
export function hasNoCommitReviewExclusion(task: { noCommitsExpected?: boolean }): boolean {
  return task.noCommitsExpected === true;
}

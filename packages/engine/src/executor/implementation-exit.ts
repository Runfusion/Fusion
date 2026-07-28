/*
FNXC:WorkflowExecutionOwnership 2026-07-28-20:10 (U8 / R4, R5 — workflow-owned lifecycle):

THE IMPLEMENTATION PHASE'S EXIT VOCABULARY.

`runImplementation` can end in many ways, and the graph is told about exactly one bit of it:
`result.taskDone`. That is the whole language the execute seam has (`executor.ts` — the seam
maps it to `"implemented"` or `"implementation-incomplete"`), and it is why the implementation
phase transitions cards ITSELF for the endings the boolean cannot express:

  - a session that paused AFTER the work was already complete finalizes to review inline;
  - a session that stopped because a step is blocked on a pending review hands off to review
    inline, because it cannot continue and review is not an error bucket.

The graph then sees `taskDone === false`, reports `implementation-incomplete`, and
`handleGraphFailure` compensates with `alreadyFinalizedToReview` / `completionFinalized` —
classifiers whose entire job is recognising a move the graph did not make. Dual ownership, and
today it is INVISIBLE: nothing anywhere records that the executor, not the graph, moved the card.

This module names those endings so they can be observed before they are moved. Each id is a
closed enum value, never prose — these ids travel on the U3 lifecycle bus to plugin subscribers
under its ids-only rule.

WHAT THIS DELIBERATELY DOES NOT DO. It does not change routing. The execute seam returns exactly
the outcome and value it returned before, for every exit, and `executor-implementation-exit-
events.test.ts` pins that. An exit id is a REACTION under R5 — a dropped event must cost a
notification and never a state change — so nothing downstream may branch on one until the
routing move lands with its own IR edges. Reporting first, moving second, is what keeps the two
changes independently revertable.

COVERAGE IS PARTIAL ON PURPOSE. `runImplementation` has ~28 lifecycle dispositions (measured by
`executor-lifecycle-ownership-ledger.test.ts`) and this instruments the six completion-adjacent
ones — the three graph handbacks and the three inline review handoffs. Those are the exits U8's
routing move needs; the rest report nothing yet and the ledger, not this enum, is the record of
that gap.
*/

/** How the implementation phase ended. Closed enum — ids only, never prose. */
export type ImplementationExit =
  /** fn_task_done (or implicit completion): handed back to the graph, which owns what follows. */
  | "complete"
  /** Completion reached on a retry session after the agent first failed to signal done. */
  | "complete-after-retry"
  /** Completion proven from live modified files when the session ended without a done signal. */
  | "complete-from-live-files"
  /**
   * OUT OF BAND: the session paused after the work was already complete, and the executor
   * finalized the card to review itself. The graph is told only `taskDone === false`.
   */
  | "review-handoff-paused-after-completion"
  /**
   * OUT OF BAND: the agent stopped without signalling done because a step is blocked on a
   * pending review. The executor parks the card in review itself — a pending-review block is a
   * wait, not a failure, and marking it failed deadlocks a row that is both in-review and failed.
   */
  | "review-handoff-pending-review";

/** The exits where the EXECUTOR performs the lifecycle transition instead of the graph. */
export const OUT_OF_BAND_IMPLEMENTATION_EXITS: readonly ImplementationExit[] = [
  "review-handoff-paused-after-completion",
  "review-handoff-pending-review",
];

export function isOutOfBandImplementationExit(exit: ImplementationExit | undefined): boolean {
  return exit !== undefined && OUT_OF_BAND_IMPLEMENTATION_EXITS.includes(exit);
}

/** Reporter threaded into `runImplementation`; each instrumented exit calls it exactly once. */
export type ImplementationExitReporter = (exit: ImplementationExit) => void;

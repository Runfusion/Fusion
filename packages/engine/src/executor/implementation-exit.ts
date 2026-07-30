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

/*
FNXC:WorkflowExecutionOwnership 2026-07-28-22:20 (U8, PR #2507 review — greptile):
THE UNION MOVED TO CORE. It was declared here and the public `NodeCompletedEvent.exit` was typed
`string`, so the contract permitted ids no consumer routes — and that failure is silent (the card
does not advance; nothing reports anything). A public contract cannot defer its vocabulary to one
of its producers, so `ImplementationExit` now lives beside the event that carries it, is checked
at the emit boundary against `IMPLEMENTATION_EXITS`, and is re-exported here for the call sites.

What stays in the engine is POLICY, not contract: which of those endings are ones the EXECUTOR
performed rather than the graph. That is a statement about this engine's current ownership split,
it changes as U8 lands its routing moves, and core has no business knowing it.
*/
import type { ImplementationExit as CoreImplementationExit } from "@fusion/core";
export type { ImplementationExit } from "@fusion/core";

/** The exits where the EXECUTOR performs the lifecycle transition instead of the graph. */
/*
FNXC:WorkflowExecutionOwnership 2026-07-29-19:20 (U8 / R4):
The ledger of endings the implementation phase still transitions itself, and it SHRINKS as U8
lands routing moves. `review-handoff-pending-review` left it: the phase reports the ending and
stops, and the graph's `review-pending-handoff` node performs the handoff.

Caveat so the list is not read as more than it is: a user-authored graph without the
`outcome:review-pending` edge still gets an executor-performed handoff, from a single named
classifier in `handleGraphFailure` — not from inside the session loop. "Out-of-band" here means
the IMPLEMENTATION PHASE performs it.
*/
export const OUT_OF_BAND_IMPLEMENTATION_EXITS: readonly CoreImplementationExit[] = [
  "review-handoff-paused-after-completion",
];

export function isOutOfBandImplementationExit(exit: CoreImplementationExit | undefined): boolean {
  return exit !== undefined && OUT_OF_BAND_IMPLEMENTATION_EXITS.includes(exit);
}

/** Reporter threaded into `runImplementation`; each instrumented exit calls it exactly once. */
export type ImplementationExitReporter = (exit: CoreImplementationExit) => void;

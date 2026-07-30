/*
FNXC:WorkflowLifecycleColumns 2026-07-31-01:05:

THE INVARIANT: the review-handoff seam moves the card to the workflow's OWN review lane.

Not a silent wrong answer, for once — a hard failure. Post-U12 `moveTask` REJECTS a destination the
workflow does not declare, so naming `in-review` from a seam meant that on any board with a renamed
review lane the handoff threw `TransitionRejectionError` and killed the workflow walk mid-run. That
is why this outranked the rest of the lane backlog once `executor.ts` was free of #2820.

WHY THE ROLE TRAVELS INSTEAD OF THE COLUMN. `workflow-node-handlers.ts` seams are pure functions over
an IR node and a task — no store, no task id to resolve from — so a handler can only name a literal.
The runtime primitive in `executor.ts` holds the store, so the seam asks for `columnRole: "review"`
and the primitive resolves it against the task's OWN selection. One authority; answering one question
with two reads is what took #2843 five review rounds.

REVERT PROOF, measured: restore `column: "in-review"` in the seam and the renamed-lane case fails —
`moveTask` is called with `in-review` instead of `signoff`.
*/
import { describe, expect, it, vi } from "vitest";

import { createDefaultNodeHandlers } from "../workflow-node-handlers.js";

/** Minimal harness: only `transitionTask` is exercised, so the rest of the primitives stay absent. */
function harness() {
  const transitionTask = vi.fn(async () => ({ outcome: "success" as const, value: "moved" }));
  const handlers = createDefaultNodeHandlers({} as never, undefined, { primitives: { transitionTask } as never });
  return { transitionTask, handlers };
}

describe("the review-handoff seam asks for the review LANE, not the id", () => {
  it("passes a role rather than a column so the runtime can resolve it", async () => {
    const { transitionTask, handlers } = harness();
    const node = { id: "review-handoff", kind: "prompt", config: { seam: "review-handoff" } };

    await handlers.prompt(node as never, {
      task: { id: "FN-1", column: "in-progress" } as never,
      settings: undefined,
      context: {},
    } as never);

    expect(transitionTask).toHaveBeenCalledTimes(1);
    const input = transitionTask.mock.calls[0]![2] as { column?: string; columnRole?: string };
    expect(input.columnRole).toBe("review");
    /* The literal must be GONE, not merely accompanied: `column` wins over `columnRole` downstream,
       so leaving it would make the role inert while looking converted. */
    expect(input.column).toBeUndefined();
  });
});

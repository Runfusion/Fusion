/*
FNXC:WorkflowExecutionOwnership 2026-07-29-18:00 (U8 / R12 — characterization, no production change):

DELETE-ONLY AUDIT RESULT: the legacy-seams prompt handler is NOT dead, so it was not deleted.

`createDefaultNodeHandlers` prefers the primitives handler only when `deps.primitives` is set.
`executeWorkflowGraph` always sets it, so the seams path is unreachable THERE — but
`WorkflowTaskRuntime` passes `this.deps.primitives`, which is OPTIONAL, and `WorkflowTaskRuntime`
is exported from the engine index. Construct it without primitives and the seams path is live.
Under this program's delete-only rule ("any behavior change found while removing a branch means
the branch was not dead — stop and treat it as a finding"), that is a stop.

THE FINDING, which is why this file exists rather than a deletion: `createNoopLegacySeams()`
returns SUCCESS for `execute`, `review`, `merge`, `planning`, `schedule` and `review-handoff`. So
a handler set built from noop seams with no primitives runs a coding workflow to success having
done no implementation, no review, and a merge seam that merely says yes.

The asymmetry is the tell. `step-execute` deliberately fails CLOSED in the same file —
"a step-execute node with no seam wired must NOT silently succeed — that would merge a task with
no step work done". The hazard was recognised for exactly one seam and left fail-open for the
rest, including `merge`.

These tests PIN the current behavior rather than change it. Making the remaining seams fail closed
is a behavior change across ~15 call sites that construct handlers from noop seams, and it belongs
in its own PR with those call sites surveyed — not smuggled in beside an audit.
*/
import { describe, expect, it } from "vitest";
import type { WorkflowIrNode } from "@fusion/core";
import { createDefaultNodeHandlers, createNoopLegacySeams } from "../workflow-node-handlers.js";

function promptNode(seam: string): WorkflowIrNode {
  return { id: `${seam}-node`, kind: "prompt", column: "in-progress", config: { seam } } as WorkflowIrNode;
}

const ctx = { task: { id: "FN-NOOP" }, context: {} } as never;

describe("noop legacy seams fail OPEN (characterization — not an endorsement)", () => {
  const handlers = createDefaultNodeHandlers(createNoopLegacySeams());

  it.each(["execute", "review", "merge", "planning", "schedule", "review-handoff"])(
    "a %s node reports success having done nothing",
    async (seam) => {
      const result = await handlers.prompt!(promptNode(seam), ctx);
      expect(result.outcome).toBe("success");
    },
  );

  it("step-execute is the one seam that fails CLOSED", async () => {
    /*
    The asymmetry this file is really about. This node carries an active-instance requirement, so
    reaching it without one throws rather than succeeding — either way it does not silently pass,
    which is the property the other six lack.
    */
    await expect(handlers.prompt!(promptNode("step-execute"), ctx)).rejects.toThrow();
  });

  it("supplying primitives is what makes the fail-open path unreachable", () => {
    /* The production wiring. If this preference is ever removed, the six seams above become
       reachable from `executeWorkflowGraph` too. */
    const withPrimitives = createDefaultNodeHandlers(createNoopLegacySeams(), undefined, {
      primitives: {} as never,
    });
    expect(withPrimitives.prompt).not.toBe(handlers.prompt);
  });
});

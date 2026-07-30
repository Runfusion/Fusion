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
import { describe, expect, it, vi } from "vitest";
import type { WorkflowIrNode } from "@fusion/core";
import { createDefaultNodeHandlers, createNoopLegacySeams, FOREACH_ACTIVE_CONTEXT_KEY } from "../workflow-node-handlers.js";

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

  it("step-execute reached with NO active instance throws on the precondition", async () => {
    /*
    FNXC:WorkflowExecutionOwnership 2026-07-29-19:40 (PR #2585 review):
    Split out and renamed. The original single case asserted `rejects.toThrow()` and claimed to
    characterize the fail-CLOSED branch — but it could not reach it. The handler throws on the
    missing-active-instance precondition FIRST, and the fail-closed branch RETURNS
    `{ outcome: "failure", value: "step-execute-unwired" }` rather than throwing, so an assertion
    on a throw can never observe it. Right outcome, wrong cause: the test passed while the
    property it named went unexercised.
    */
    await expect(handlers.prompt!(promptNode("step-execute"), ctx)).rejects.toThrow(
      /without an active foreach instance/i,
    );
  });

  it("step-execute WITH an active instance and no seam wired fails CLOSED", async () => {
    /* The branch the file is actually about: supply the active instance so the precondition
       passes, then assert the explicit failure VALUE rather than merely "did not succeed". */
    const activeCtx = {
      task: { id: "FN-NOOP" },
      context: { [FOREACH_ACTIVE_CONTEXT_KEY]: { stepIndex: 0 } },
    } as never;

    const result = await handlers.prompt!(promptNode("step-execute"), activeCtx);

    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("step-execute-unwired");
  });

  it("supplying primitives ROUTES AWAY from the seams — asserted by call, not by identity", async () => {
    /*
    FNXC:WorkflowExecutionOwnership 2026-07-29-19:40 (PR #2585 review):
    Was `expect(withPrimitives.prompt).not.toBe(handlers.prompt)`, which proved only that two
    closures were created. VERIFIED VACUOUS: two IDENTICAL `createDefaultNodeHandlers` calls —
    both without primitives — already return different closures, so that assertion passed no
    matter what primitives did. It could not fail.

    Asserted by behaviour instead: with primitives supplied, invoking the handler must call the
    PRIMITIVE and must NOT call the seam. That fails if the preference is ever removed, which is
    the property this case exists to protect.
    */
    const runPlanningSession = vi.fn(async () => ({ outcome: "success" as const }));
    const seams = createNoopLegacySeams();
    const planningSeam = vi.spyOn(seams, "planning");

    const withPrimitives = createDefaultNodeHandlers(seams, undefined, {
      primitives: { runPlanningSession } as never,
    });

    const result = await withPrimitives.prompt!(promptNode("planning"), ctx);

    expect(runPlanningSession).toHaveBeenCalledTimes(1);
    expect(planningSeam).not.toHaveBeenCalled();
    expect(result.outcome).toBe("success");
  });
});

/*
FNXC:WorkflowReviewGates 2026-07-26-13:55:
The pre-merge review gates (Code Review, Browser Verification) run with the card in `in-review`, so
their paired remediation nodes cross `in-review -> in-progress` — a real crossing back INTO a
capacity-bearing column. Capacity is enforced in-transaction and is never bypassable, so if the
pool filled while the gate ran, that move is rejected. Before this fix the controller rethrew, the
graph run died at the remediation node, and the card was stranded in `in-review` behind a failed
pre-merge step with nothing scheduled to fix it.

The invariant these tests pin: a CAPACITY rejection parks (suspends) so the run unwinds cleanly and
the next graph run retries the move, while a NON-capacity rejection (an invariant violation) still
propagates as a real error. Regression direction matters — a change that makes every rejection park
would silently swallow invariant violations, so both halves are asserted.
*/
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  TransitionRejectionError,
  getWorkflowEventBus,
  resetWorkflowEventBusForTesting,
  type WorkflowIr,
  type WorkflowLifecycleEvent,
} from "@fusion/core";
import { createWorkflowColumnBoundary } from "../workflow-column-boundary.js";

/** Minimal two-column IR: a wip column and a review column, plus the remediation target. */
function ir(): WorkflowIr {
  return {
    version: "v2",
    name: "review-gate-capacity",
    columns: [
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "In review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
    ],
    nodes: [
      { id: "code-review", kind: "optional-group", column: "in-review", config: {} },
      { id: "code-review-remediation", kind: "prompt", column: "in-progress", config: {} },
    ],
    edges: [{ from: "code-review", to: "code-review-remediation", condition: "failure" }],
  } as unknown as WorkflowIr;
}

const remediationNode = () => ir().nodes.find((n) => n.id === "code-review-remediation")!;

function capacityError() {
  return new TransitionRejectionError(
    { code: "capacity-exhausted", messageKey: "transition.rejected.capacityExhausted", retryable: true },
    "Column 'in-progress' is at capacity (4/4)",
  );
}

function invariantError() {
  return new TransitionRejectionError(
    { code: "merge-blocked", messageKey: "transition.rejected.mergeBlocked", retryable: false },
    "merge blocked",
  );
}

describe("workflow column boundary — capacity rejection on the remediation crossing", () => {
  it("parks (suspends) instead of failing the run when in-progress is at capacity", async () => {
    const moveTask = vi.fn().mockRejectedValue(capacityError());
    const onSuspend = vi.fn();
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-CAP1",
      workflowId: "builtin:coding",
      ir: ir(),
      initialColumn: "in-review",
      moveTask,
      onSuspend,
    });

    const result = await boundary.onNodeEntry(remediationNode());

    expect(result).toMatchObject({
      kind: "suspended",
      reason: "capacity",
      nodeId: "code-review-remediation",
      fromColumn: "in-review",
      toColumn: "in-progress",
    });
    // The suspension must be persisted so the run has a durable continuation.
    expect(onSuspend).toHaveBeenCalledTimes(1);
    // The card did NOT move: the controller must keep reporting the review column,
    // otherwise a later node entry would compute its boundary from a phantom column.
    expect(boundary.currentColumn()).toBe("in-review");
  });

  it("still propagates a non-capacity rejection so invariant violations are not swallowed", async () => {
    const moveTask = vi.fn().mockRejectedValue(invariantError());
    const onSuspend = vi.fn();
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-CAP1",
      workflowId: "builtin:coding",
      ir: ir(),
      initialColumn: "in-review",
      moveTask,
      onSuspend,
    });

    await expect(boundary.onNodeEntry(remediationNode())).rejects.toThrow(TransitionRejectionError);
    expect(onSuspend).not.toHaveBeenCalled();
    expect(boundary.currentColumn()).toBe("in-review");
  });

  it("advances normally when capacity allows the remediation move", async () => {
    const moveTask = vi.fn().mockResolvedValue(undefined);
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-CAP1",
      workflowId: "builtin:coding",
      ir: ir(),
      initialColumn: "in-review",
      moveTask,
    });

    const result = await boundary.onNodeEntry(remediationNode());

    expect(result).toMatchObject({ kind: "entered" });
    expect(moveTask).toHaveBeenCalledWith("in-progress", expect.objectContaining({
      fromColumn: "in-review",
      nodeId: "code-review-remediation",
    }));
    expect(boundary.currentColumn()).toBe("in-progress");
  });
});

/*
FNXC:WorkflowEvents 2026-07-27-17:40 (U3, PR #2467 review):
ANTI-"BORN DEAD" GUARD. The bus REFUSES a payload that violates the ids-only or
required-key rules, and refusal is silent by design (the emitter is post-commit;
throwing there would turn a shape bug into a lifecycle fault). That combination
means an emitter regression — a dropped `nodeId`, a renamed field, a stray
`error` — would stop the event firing with NO test failure anywhere, and every
subscriber built on it would quietly never run.

So the real emitters are asserted end-to-end through the real bus: not "was emit
called" (a spy would pass on a refused payload) but "did a subscriber actually
receive it". These tests fail if a future edit makes the boundary's payloads
invalid.
*/
describe("column boundary emits SURVIVE the bus's shape validation (U3)", () => {
  beforeEach(() => resetWorkflowEventBusForTesting());
  afterEach(() => getWorkflowEventBus().clear());

  it("NodeEntered is DELIVERED for a column-bearing node", async () => {
    const received: WorkflowLifecycleEvent[] = [];
    getWorkflowEventBus().subscribe((event) => { received.push(event); }, { name: "probe" });

    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-EV-1",
      workflowId: "builtin:coding",
      ir: ir(),
      initialColumn: "in-review",
      moveTask: async () => {},
    });
    await boundary.onNodeEntry(remediationNode());
    await getWorkflowEventBus().drain();

    const entered = received.filter((e) => e.type === "NodeEntered");
    expect(entered).toHaveLength(1);
    expect(entered[0]).toMatchObject({
      type: "NodeEntered",
      taskId: "FN-EV-1",
      nodeId: "code-review-remediation",
      column: "in-progress",
    });
  });

  it("NodeEntered is DELIVERED for a COLUMNLESS node, with column omitted", async () => {
    const received: WorkflowLifecycleEvent[] = [];
    getWorkflowEventBus().subscribe((event) => { received.push(event); }, { name: "probe" });

    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-EV-2",
      workflowId: "builtin:coding",
      ir: ir(),
      initialColumn: "in-review",
    });
    // `end` carries no column — the case the optional `column` field exists for.
    await boundary.onNodeEntry({ id: "end", kind: "end" } as never);
    await getWorkflowEventBus().drain();

    const entered = received.filter((e) => e.type === "NodeEntered");
    expect(entered).toHaveLength(1);
    expect(entered[0].taskId).toBe("FN-EV-2");
    expect("column" in entered[0]).toBe(false);
  });

  it("RunSuspended is DELIVERED when a capacity rejection parks the crossing", async () => {
    const received: WorkflowLifecycleEvent[] = [];
    getWorkflowEventBus().subscribe((event) => { received.push(event); }, { name: "probe" });

    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-EV-3",
      workflowId: "builtin:coding",
      ir: ir(),
      initialColumn: "in-review",
      moveTask: async () => { throw capacityError(); },
    });
    const result = await boundary.onNodeEntry(remediationNode());
    await getWorkflowEventBus().drain();

    expect(result).toMatchObject({ kind: "suspended", reason: "capacity" });
    const suspended = received.filter((e) => e.type === "RunSuspended");
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({
      type: "RunSuspended",
      taskId: "FN-EV-3",
      nodeId: "code-review-remediation",
      reason: "capacity",
      fromColumn: "in-review",
      toColumn: "in-progress",
    });
  });
});

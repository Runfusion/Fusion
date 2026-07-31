/*
FNXC:MergedPlanningColumn 2026-07-28-18:30 (U11):

THE SAFETY ARGUMENT FOR THE MERGE, proven rather than asserted.

Merging Todo into Planning changes the graph's entry point for a planning-lane card: it now
resumes at `start` instead of at the specification node, because the two share a column. The
smoke test's expected node sequence changes from ["plan", ...] to ["start", "plan", ...] as a
result.

"Just update the expected array" is the dangerous move here, and it is dangerous for a specific
reason: entering at `start` is EXACTLY what dragged cards backward in the three earlier, reverted
attempts at this merge. A run that re-entered at the first node of the first column pulled the
card back through columns it had already left, firing `abort-on-exit` on its live session and
stranding it in a pre-wip column with no releaser.

The claim that makes it safe now is narrow and mechanical: `start` and the specification node are
in the SAME column, so entering `start` has no column to move to. This file proves that claim
against the real controller and the real production IR before the expectation is touched. If the
no-move property does not hold, the smoke failure is a genuine regression and the IR change is
wrong — so these tests are the gate on that decision, not decoration.

Mechanism under test (`workflow-column-boundary.ts`): `onNodeEntry` returns at
`if (toColumn === column) return { kind: "entered" }` BEFORE any move, before the hold->wip
capacity seam, and before `moveTask` is reachable at all.
*/
import { describe, expect, it, vi } from "vitest";
import { getBuiltinWorkflow, parseWorkflowIr, type WorkflowIr, type WorkflowIrNode } from "@fusion/core";
import { createWorkflowColumnBoundary } from "../workflow-column-boundary.js";

/** The real default workflow — `builtin:coding`, post-merge. Not a hand-written fixture. */
const defaultIr: WorkflowIr = parseWorkflowIr(getBuiltinWorkflow("builtin:coding")!.ir as never);

function nodeById(id: string): WorkflowIrNode {
  const node = defaultIr.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`default workflow has no node '${id}'`);
  return node;
}

const startNode = () => defaultIr.nodes.find((n) => n.kind === "start")!;

describe("merged planning column — entering `start` moves nothing (U11 safety argument)", () => {
  it("puts `start` and the specification node in the SAME column (the premise)", () => {
    /*
    Every assertion below rests on this. Asserted first and separately so that if the premise ever
    stops holding — a future edit moving `start` back to its own column — the failure names the
    cause instead of surfacing as a confusing move-count mismatch.
    */
    const start = startNode();
    const successors = defaultIr.edges.filter(
      (edge) => edge.from === start.id
        && (edge.condition === undefined || edge.condition === "success")
        && edge.kind !== "rework",
    );
    expect(successors).toHaveLength(1);

    const specificationNode = nodeById(successors[0]!.to);
    expect(start.column).toBe(specificationNode.column);
    expect(start.column).toBe("todo");
  });

  it("performs NO move when a planning-column card enters `start`", async () => {
    const moveTask = vi.fn();
    const onSuspend = vi.fn();
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-MERGED-1",
      workflowId: "builtin:coding",
      ir: defaultIr,
      // The card is already in the merged planning column — the intake case.
      initialColumn: "todo",
      moveTask,
      onSuspend,
    } as never);

    const result = await boundary.onNodeEntry(startNode());

    expect(result).toMatchObject({ kind: "entered" });
    // THE PROPERTY. Not "the move succeeded" — the move was never attempted.
    expect(moveTask).not.toHaveBeenCalled();
    expect(boundary.currentColumn()).toBe("todo");
  });

  it("performs NO move on the whole start → specification chain", async () => {
    /*
    One node entry proving no-move is not enough: the run continues into the specification node
    immediately. Both entries must be no-ops, or the card moves one column and back — which is a
    real transition pair with real trait side effects (reset-on-entry re-arming, timing accounting),
    even though the start and end columns are equal.
    */
    const moveTask = vi.fn();
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-MERGED-2",
      workflowId: "builtin:coding",
      ir: defaultIr,
      initialColumn: "todo",
      moveTask,
      onSuspend: vi.fn(),
    } as never);

    const start = startNode();
    const specificationId = defaultIr.edges.find(
      (edge) => edge.from === start.id && (edge.condition === undefined || edge.condition === "success"),
    )!.to;

    await boundary.onNodeEntry(start);
    await boundary.onNodeEntry(nodeById(specificationId));

    expect(moveTask).not.toHaveBeenCalled();
    expect(boundary.currentColumn()).toBe("todo");
  });

  it("never reaches the hold→wip capacity seam while traversing the planning chain", async () => {
    /*
    The merged column carries BOTH `hold` and `intake`. A same-column entry must return before the
    hold->wip boundary check, or entering `start` on a hold-carrying column could suspend the run
    at a capacity seam it never actually crossed — a card parked waiting for capacity it does not
    need, which presents as a silently stuck card.
    */
    const onSuspend = vi.fn();
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-MERGED-3",
      workflowId: "builtin:coding",
      ir: defaultIr,
      initialColumn: "todo",
      moveTask: vi.fn(),
      onSuspend,
    } as never);

    const result = await boundary.onNodeEntry(startNode());

    expect(onSuspend).not.toHaveBeenCalled();
    expect(result).not.toMatchObject({ kind: "suspended" });
  });

  it("still MOVES on a real crossing, so the no-op is same-column and not a disabled boundary", async () => {
    /*
    The regression direction that matters. A change making `onNodeEntry` never move would satisfy
    every assertion above while breaking the entire lifecycle. Prove the controller still crosses
    when the columns genuinely differ.
    */
    const moveTask = vi.fn().mockResolvedValue(undefined);
    const boundary = createWorkflowColumnBoundary({
      taskId: "FN-MERGED-4",
      workflowId: "builtin:coding",
      ir: defaultIr,
      // Coming from the wip column into a review node is a real crossing.
      initialColumn: "in-progress",
      moveTask,
      onSuspend: vi.fn(),
    } as never);

    const reviewNode = defaultIr.nodes.find((node) => node.column === "in-review")!;
    await boundary.onNodeEntry(reviewNode);

    expect(moveTask).toHaveBeenCalledTimes(1);
    expect(boundary.currentColumn()).toBe("in-review");
  });
});

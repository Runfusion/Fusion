import { describe, expect, it, vi } from "vitest";
import type { WorkflowIr } from "@fusion/core";
import { createWorkflowColumnBoundary } from "../workflows/workflow-column-boundary.js";

function ir(): WorkflowIr {
  return {
    version: "v2",
    name: "review-gate-in-place",
    columns: [
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "In review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
      { id: "unclassified", name: "Unclassified", traits: [] },
    ],
    nodes: [
      { id: "security-review", kind: "optional-group", column: "in-progress", config: {} },
      { id: "code-review", kind: "step-review", column: "in-progress", config: {} },
      { id: "remediation", kind: "prompt", column: "in-progress", config: {} },
      { id: "forward-review", kind: "optional-group", column: "in-review", config: {} },
      { id: "columnless-review", kind: "optional-group", config: {} },
      { id: "unknown-review", kind: "optional-group", column: "unclassified", config: {} },
    ],
    edges: [],
  } as WorkflowIr;
}

function node(id: string) {
  return ir().nodes.find((candidate) => candidate.id === id)!;
}

describe("workflow column boundary review-gate re-entry", () => {
  it.each(["security-review", "code-review"])("enters backward %s gates in place", async (nodeId) => {
    const moveTask = vi.fn();
    const emitAudit = vi.fn();
    const boundary = createWorkflowColumnBoundary({ taskId: "FN-9243", workflowId: "review-gate-in-place", ir: ir(), initialColumn: "in-review", moveTask, emitAudit });

    await expect(boundary.onNodeEntry(node(nodeId))).resolves.toEqual({ kind: "entered" });
    expect(moveTask).not.toHaveBeenCalled();
    expect(emitAudit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "task:column-transition" }));
    expect(boundary.currentColumn()).toBe("in-review");
  });

  it("preserves non-gate backward, forward, same-column, columnless, and unknown-role crossings", async () => {
    const backwardMove = vi.fn();
    const backward = createWorkflowColumnBoundary({ taskId: "FN-9243", workflowId: "review-gate-in-place", ir: ir(), initialColumn: "in-review", moveTask: backwardMove });
    await backward.onNodeEntry(node("remediation"));
    expect(backwardMove).toHaveBeenCalledTimes(1);

    const forwardMove = vi.fn();
    const forward = createWorkflowColumnBoundary({ taskId: "FN-9243", workflowId: "review-gate-in-place", ir: ir(), initialColumn: "in-progress", moveTask: forwardMove });
    await forward.onNodeEntry(node("forward-review"));
    expect(forwardMove).toHaveBeenCalledTimes(1);
    expect(forward.currentColumn()).toBe("in-review");

    const sameMove = vi.fn();
    const same = createWorkflowColumnBoundary({ taskId: "FN-9243", workflowId: "review-gate-in-place", ir: ir(), initialColumn: "in-review", moveTask: sameMove });
    await same.onNodeEntry({ ...node("forward-review"), column: "in-review" });
    await same.onNodeEntry(node("columnless-review"));
    expect(sameMove).not.toHaveBeenCalled();

    const unknownMove = vi.fn();
    const unknown = createWorkflowColumnBoundary({ taskId: "FN-9243", workflowId: "review-gate-in-place", ir: ir(), initialColumn: "in-review", moveTask: unknownMove });
    await unknown.onNodeEntry(node("unknown-review"));
    expect(unknownMove).toHaveBeenCalledTimes(1);
  });
});

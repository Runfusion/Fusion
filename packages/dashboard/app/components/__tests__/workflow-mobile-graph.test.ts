import { describe, expect, it } from "vitest";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { buildMobileWorkflowGraph, reorderWorkflowNode } from "../workflow-mobile-graph";
import type { WorkflowFlowNodeData } from "../nodes/WorkflowNodeTypes";
import { columnBandNodeId, foreachChildFlowId } from "../workflow-flow-mapping";

function node(
  id: string,
  kind: WorkflowFlowNodeData["kind"],
  x: number,
  y: number,
  extra: Partial<FlowNode<WorkflowFlowNodeData>> = {},
): FlowNode<WorkflowFlowNodeData> {
  return {
    id,
    type: kind,
    position: { x, y },
    data: { kind, label: id, ...(extra.data ?? {}) },
    ...extra,
  };
}

function edge(id: string, source: string, target: string, condition = "success"): FlowEdge {
  return {
    id,
    source,
    target,
    label: condition,
    data: { condition },
  };
}

function rowOrder(nodes: FlowNode<WorkflowFlowNodeData>[]): string[] {
  return buildMobileWorkflowGraph(nodes, []).map((row) => row.id);
}

describe("reorderWorkflowNode", () => {
  it("swaps adjacent editable top-level siblings in the same column and re-derives the new order", () => {
    const nodes = [
      node("a", "prompt", 0, 0, { data: { kind: "prompt", label: "A", column: "todo" } }),
      node("b", "script", 0, 80, { data: { kind: "script", label: "B", column: "todo" } }),
      node("c", "gate", 0, 160, { data: { kind: "gate", label: "C", column: "todo" } }),
    ];

    const reordered = reorderWorkflowNode(nodes, "b", "up");

    expect(rowOrder(reordered)).toEqual(["b", "a", "c"]);
    expect(reordered.find((n) => n.id === "b")?.position).toEqual({ x: 0, y: 0 });
    expect(reordered.find((n) => n.id === "a")?.position).toEqual({ x: 0, y: 80 });
  });

  it("does not move past same-group boundaries", () => {
    const nodes = [
      node("a", "prompt", 0, 0, { data: { kind: "prompt", label: "A", column: "todo" } }),
      node("b", "script", 0, 80, { data: { kind: "script", label: "B", column: "todo" } }),
    ];

    expect(reorderWorkflowNode(nodes, "a", "up")).toBe(nodes);
    expect(reorderWorkflowNode(nodes, "b", "down")).toBe(nodes);
  });

  it("does not move top-level nodes across column groups", () => {
    const nodes = [
      node("todo-a", "prompt", 0, 0, { data: { kind: "prompt", label: "A", column: "todo" } }),
      node("doing-a", "script", 0, 80, { data: { kind: "script", label: "B", column: "doing" } }),
    ];

    expect(reorderWorkflowNode(nodes, "todo-a", "down")).toBe(nodes);
    expect(rowOrder(reorderWorkflowNode(nodes, "doing-a", "up"))).toEqual(["todo-a", "doing-a"]);
  });

  it("reorders template children only within the same parent", () => {
    const first = foreachChildFlowId("each", "first");
    const second = foreachChildFlowId("each", "second");
    const other = foreachChildFlowId("other", "first");
    const nodes = [
      node("each", "foreach", 0, 0, { data: { kind: "foreach", label: "Each" } }),
      node(first, "prompt", 20, 60, { parentId: "each", data: { kind: "prompt", label: "First" } }),
      node(second, "script", 20, 120, { parentId: "each", data: { kind: "script", label: "Second" } }),
      node("other", "loop", 0, 200, { data: { kind: "loop", label: "Other" } }),
      node(other, "prompt", 20, 60, { parentId: "other", data: { kind: "prompt", label: "Other child" } }),
    ];

    const rows = buildMobileWorkflowGraph(reorderWorkflowNode(nodes, second, "up"), []);

    expect(rows.find((row) => row.id === "each")?.children.map((child) => child.id)).toEqual([second, first]);
    expect(rows.find((row) => row.id === "other")?.children.map((child) => child.id)).toEqual([other]);
  });

  it("refuses to reorder non-editable nodes or swap with a non-editable neighbor", () => {
    const nodes = [
      node("start", "start", 0, 0, { data: { kind: "start", label: "Start", column: "todo" } }),
      node("step", "prompt", 0, 80, { data: { kind: "prompt", label: "Step", column: "todo" } }),
      node(columnBandNodeId("todo"), "start", -40, 0, {
        type: "group",
        data: { kind: "start", label: "Todo", column: "todo" },
      }),
    ];

    expect(reorderWorkflowNode(nodes, "start", "down")).toBe(nodes);
    expect(reorderWorkflowNode(nodes, "step", "up")).toBe(nodes);
    expect(reorderWorkflowNode(nodes, columnBandNodeId("todo"), "down")).toBe(nodes);
  });
});

describe("buildMobileWorkflowGraph", () => {
  it("returns ordered linear rows with outgoing edge destinations", () => {
    const rows = buildMobileWorkflowGraph(
      [
        node("end", "end", 300, 0),
        node("start", "start", 0, 0),
        node("lint", "gate", 150, 0, { data: { kind: "gate", label: "Lint", config: { gateMode: "gate" } } }),
      ],
      [edge("e1", "start", "lint"), edge("e2", "lint", "end")],
    );

    expect(rows.map((row) => row.id)).toEqual(["start", "lint", "end"]);
    expect(rows[0].outgoing[0]).toMatchObject({ target: "lint", targetLabel: "Lint" });
    expect(rows[1].summary).toBe("Gate (blocks)");
  });

  it("preserves branch edges and column labels while ignoring column band nodes", () => {
    const rows = buildMobileWorkflowGraph(
      [
        node(columnBandNodeId("todo"), "start", -40, 0, {
          type: "group",
          data: { kind: "start", label: "Todo", column: "todo" },
        }),
        node("split", "split", 0, 0, { data: { kind: "split", label: "Split", column: "todo" } }),
        node("a", "prompt", 160, 20, { data: { kind: "prompt", label: "A", column: "todo" } }),
        node("b", "script", 160, 90, { data: { kind: "script", label: "B", column: "todo" } }),
      ],
      [edge("e1", "split", "a", "success"), edge("e2", "split", "b", "failure")],
      [{ id: "todo", name: "Todo", traits: [] }],
    );

    expect(rows.map((row) => row.id)).toEqual(["split", "a", "b"]);
    expect(rows[0].columnName).toBe("Todo");
    expect(rows[0].outgoing.map((out) => [out.label, out.targetLabel])).toEqual([
      ["success", "A"],
      ["failure", "B"],
    ]);
  });

  it("nests foreach template children without exposing local ids as top-level rows", () => {
    const childId = foreachChildFlowId("each", "step");
    const rows = buildMobileWorkflowGraph(
      [
        node("each", "foreach", 0, 0, { data: { kind: "foreach", label: "Each step", config: { mode: "parallel" } } }),
        node(childId, "prompt", 20, 60, {
          parentId: "each",
          data: { kind: "prompt", label: "Run step", config: { seam: "step-execute" } },
        }),
      ],
      [edge("e-child", childId, childId, "outcome:revise")],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("each");
    expect(rows[0].children).toHaveLength(1);
    expect(rows[0].children[0]).toMatchObject({
      id: childId,
      templateLocalId: "step",
      label: "Run step",
    });
  });
});

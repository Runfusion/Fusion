import { describe, it, expect } from "vitest";
import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import type { WorkflowFlowNodeData } from "../nodes/WorkflowNodeTypes";
import {
  simpleVerticalLayout,
  edgeSupportsSimpleInsert,
  insertNodeOnEdge,
  findAppendEdgeId,
  spliceInsertedSubgraphOnEdge,
  SIMPLE_NODE_WIDTH,
} from "../workflow-simple-layout";

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
Unit coverage for the simplified view's derived vertical layout and its
insert-on-edge rewiring — the two pure invariants the simple canvas depends
on: (1) display layout never mutates input nodes, (2) inserting on an edge
preserves the inbound routing condition and the source node's column band y.
*/

type N = FlowNode<WorkflowFlowNodeData>;

function node(id: string, kind: WorkflowFlowNodeData["kind"], x = 0, y = 0, extra: Partial<N> = {}): N {
  return {
    id,
    type: kind,
    position: { x, y },
    data: { kind, label: id, config: {} },
    ...extra,
  };
}

function edge(id: string, source: string, target: string, condition = "success", kind?: string): FlowEdge {
  return { id, source, target, data: { condition, kind } };
}

const linearNodes = (): N[] => [
  node("start", "start", 0, 0),
  node("a", "prompt", 300, 0),
  node("b", "script", 600, 0),
  node("end", "end", 900, 0),
];

const linearEdges = (): FlowEdge[] => [
  edge("e1", "start", "a"),
  edge("e2", "a", "b"),
  edge("e3", "b", "end"),
];

describe("simpleVerticalLayout", () => {
  it("stacks a linear graph top-to-bottom in topology order", () => {
    const positions = simpleVerticalLayout(linearNodes(), linearEdges());
    const y = (id: string) => positions.get(id)!.y;
    expect(y("start")).toBeLessThan(y("a"));
    expect(y("a")).toBeLessThan(y("b"));
    expect(y("b")).toBeLessThan(y("end"));
  });

  it("places same-layer branch siblings side by side, ordered by canvas x", () => {
    const nodes = [
      node("start", "start"),
      node("split", "split", 200, 0),
      node("right", "prompt", 700, 0),
      node("left", "prompt", 400, 0),
      node("end", "end", 900, 0),
    ];
    const edges = [
      edge("e1", "start", "split"),
      edge("e2", "split", "left"),
      edge("e3", "split", "right"),
      edge("e4", "left", "end"),
      edge("e5", "right", "end"),
    ];
    const positions = simpleVerticalLayout(nodes, edges);
    expect(positions.get("left")!.y).toBe(positions.get("right")!.y);
    // "left" has the smaller advanced-canvas x, so it stays the left sibling.
    expect(positions.get("left")!.x).toBeLessThan(positions.get("right")!.x);
    expect(positions.get("right")!.x - positions.get("left")!.x).toBeGreaterThanOrEqual(SIMPLE_NODE_WIDTH);
  });

  it("skips container template children and column band nodes", () => {
    const nodes = [
      node("start", "start"),
      node("group", "foreach", 300, 0, { style: { width: 560, height: 220 } }),
      node("child", "prompt", 30, 56, { parentId: "group" }),
      node("__col__:col-1", "start", 0, 0),
      node("end", "end", 600, 0),
    ];
    const edges = [edge("e1", "start", "group"), edge("e2", "group", "end")];
    const positions = simpleVerticalLayout(nodes, edges);
    expect(positions.has("child")).toBe(false);
    expect(positions.has("__col__:col-1")).toBe(false);
    expect(positions.has("group")).toBe(true);
  });

  it("does not mutate the input nodes (display-only layout)", () => {
    const nodes = linearNodes();
    const before = nodes.map((n) => ({ ...n.position }));
    simpleVerticalLayout(nodes, linearEdges());
    expect(nodes.map((n) => ({ ...n.position }))).toEqual(before);
  });
});

describe("edgeSupportsSimpleInsert", () => {
  it("accepts plain forward edges and rejects rework/visual-only edges", () => {
    expect(edgeSupportsSimpleInsert(edge("e", "a", "b"))).toBe(true);
    expect(edgeSupportsSimpleInsert(edge("e", "a", "b", "failure"))).toBe(true);
    expect(edgeSupportsSimpleInsert(edge("e", "a", "b", "success", "rework"))).toBe(false);
    expect(
      edgeSupportsSimpleInsert({
        id: "e",
        source: "a",
        target: "b",
        data: { condition: "entry", visualOnly: "template-boundary" },
      }),
    ).toBe(false);
  });
});

describe("insertNodeOnEdge", () => {
  it("rewires source→new→target preserving the inbound condition", () => {
    const nodes = linearNodes();
    const edges = [edge("e1", "start", "a"), edge("e2", "a", "b", "failure"), edge("e3", "b", "end")];
    const result = insertNodeOnEdge(nodes, edges, "e2", { kind: "script", label: "Lint" });
    expect(result).not.toBeNull();
    const { nodes: nextNodes, edges: nextEdges, newNodeId } = result!;
    expect(nextNodes.some((n) => n.id === newNodeId && n.data.kind === "script")).toBe(true);
    expect(nextEdges.find((e) => e.id === "e2")).toBeUndefined();
    const inbound = nextEdges.find((e) => e.source === "a" && e.target === newNodeId);
    const outbound = nextEdges.find((e) => e.source === newNodeId && e.target === "b");
    expect(inbound?.data?.condition).toBe("failure");
    expect(outbound?.data?.condition).toBe("success");
  });

  it("places the new node at the source's y so its column band is preserved", () => {
    const nodes = [
      node("start", "start", 0, 120),
      node("a", "prompt", 300, 120),
      node("end", "end", 900, 480),
    ];
    const edges = [edge("e1", "start", "a"), edge("e2", "a", "end")];
    const result = insertNodeOnEdge(nodes, edges, "e2", { kind: "prompt", label: "Review" });
    const inserted = result!.nodes.find((n) => n.id === result!.newNodeId)!;
    expect(inserted.position.y).toBe(120 + 8);
  });

  it("seeds a template child when inserting a container kind", () => {
    const result = insertNodeOnEdge(linearNodes(), linearEdges(), "e2", {
      kind: "loop",
      label: "Retry loop",
      presetConfig: { maxIterations: 3 },
      containerChildLabel: "Loop step",
    });
    const group = result!.nodes.find((n) => n.id === result!.newNodeId)!;
    expect(group.data.kind).toBe("loop");
    const child = result!.nodes.find((n) => n.parentId === group.id);
    expect(child).toBeDefined();
    expect(child!.data.label).toBe("Loop step");
  });

  it("inserts a sibling child (same parentId) on a template-internal edge", () => {
    const nodes = [
      ...linearNodes(),
      node("group", "foreach", 300, 300, { style: { width: 560, height: 220 } }),
      node("c1", "prompt", 30, 56, { parentId: "group" }),
      node("c2", "prompt", 300, 56, { parentId: "group" }),
    ];
    const edges = [...linearEdges(), edge("t1", "c1", "c2")];
    const result = insertNodeOnEdge(nodes, edges, "t1", { kind: "prompt", label: "Middle" });
    const inserted = result!.nodes.find((n) => n.id === result!.newNodeId)!;
    expect(inserted.parentId).toBe("group");
  });

  it("rejects container kinds on template-internal edges (no nesting)", () => {
    const nodes = [
      ...linearNodes(),
      node("group", "foreach", 300, 300, { style: { width: 560, height: 220 } }),
      node("c1", "prompt", 30, 56, { parentId: "group" }),
      node("c2", "prompt", 300, 56, { parentId: "group" }),
    ];
    const edges = [...linearEdges(), edge("t1", "c1", "c2")];
    expect(insertNodeOnEdge(nodes, edges, "t1", { kind: "loop", label: "Loop" })).toBeNull();
  });

  it("returns null for rework edges and unknown edge ids", () => {
    const edges = [edge("r1", "b", "a", "failure", "rework")];
    expect(insertNodeOnEdge(linearNodes(), edges, "r1", { kind: "prompt", label: "X" })).toBeNull();
    expect(insertNodeOnEdge(linearNodes(), edges, "missing", { kind: "prompt", label: "X" })).toBeNull();
  });
});

describe("findAppendEdgeId", () => {
  it("returns the single edge into end", () => {
    expect(findAppendEdgeId(linearNodes(), linearEdges())).toBe("e3");
  });

  it("returns null when multiple edges enter end (ambiguous)", () => {
    const edges = [...linearEdges(), edge("e4", "a", "end", "failure")];
    expect(findAppendEdgeId(linearNodes(), edges)).toBeNull();
  });

  it("returns null when the graph has no end target", () => {
    const nodes = [node("start", "start"), node("a", "prompt")];
    expect(findAppendEdgeId(nodes, [edge("e1", "start", "a")])).toBeNull();
  });
});


/*
FNXC:WorkflowSimpleView 2026-07-12-10:30:
PR #2006 review coverage: edge-targeted fragment / optional-group inserts must
splice the already-inserted subgraph into the targeted edge (entries inherit
the original condition, exits feed the old target, the original edge is
removed, the subgraph moves into the source's y band).
*/
describe("spliceInsertedSubgraphOnEdge", () => {
  const baseNodes = (): N[] => [
    node("start", "start", 0, 120),
    node("a", "prompt", 300, 120),
    node("end", "end", 900, 120),
  ];
  const baseEdges = (): FlowEdge[] => [edge("e1", "start", "a"), edge("e2", "a", "end", "failure")];

  it("wires source→entry and exit→target, removes the edge, preserves condition", () => {
    const nodes = [
      ...baseNodes(),
      node("f1", "gate", 240, 700),
      node("f2", "script", 520, 700),
    ];
    const edges = [...baseEdges(), edge("f-e", "f1", "f2")];
    const result = spliceInsertedSubgraphOnEdge(nodes, edges, "e2", ["f1", "f2"]);
    expect(result).not.toBeNull();
    const { nodes: nextNodes, edges: nextEdges } = result!;
    expect(nextEdges.find((e) => e.id === "e2")).toBeUndefined();
    const inbound = nextEdges.find((e) => e.source === "a" && e.target === "f1");
    const outbound = nextEdges.find((e) => e.source === "f2" && e.target === "end");
    expect(inbound?.data?.condition).toBe("failure");
    expect(outbound?.data?.condition).toBe("success");
    // Subgraph translated into the source's y band, preserving relative layout.
    const f1 = nextNodes.find((n) => n.id === "f1")!;
    const f2 = nextNodes.find((n) => n.id === "f2")!;
    expect(f1.position.y).toBe(120 + 8);
    expect(f2.position.x - f1.position.x).toBe(280);
  });

  it("wires an optional-group container while leaving its template children alone", () => {
    const nodes = [
      ...baseNodes(),
      node("grp", "optional-group", 240, 700, { style: { width: 560, height: 220 } }),
      node("grp-child", "prompt", 30, 56, { parentId: "grp" }),
    ];
    const result = spliceInsertedSubgraphOnEdge(nodes, baseEdges(), "e2", ["grp", "grp-child"]);
    expect(result).not.toBeNull();
    const inbound = result!.edges.find((e) => e.source === "a" && e.target === "grp");
    const outbound = result!.edges.find((e) => e.source === "grp" && e.target === "end");
    expect(inbound).toBeDefined();
    expect(outbound).toBeDefined();
    // Child keeps its parent-relative position.
    const child = result!.nodes.find((n) => n.id === "grp-child")!;
    expect(child.position).toEqual({ x: 30, y: 56 });
  });

  it("returns null when the target edge is gone or ineligible", () => {
    const nodes = [...baseNodes(), node("f1", "gate", 240, 700)];
    expect(spliceInsertedSubgraphOnEdge(nodes, baseEdges(), "missing", ["f1"])).toBeNull();
    const rework = [edge("r1", "a", "start", "failure", "rework")];
    expect(spliceInsertedSubgraphOnEdge(nodes, rework, "r1", ["f1"])).toBeNull();
    expect(spliceInsertedSubgraphOnEdge(baseNodes(), baseEdges(), "e2", ["not-present"])).toBeNull();
  });
});

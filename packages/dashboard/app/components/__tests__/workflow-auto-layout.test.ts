import { describe, it, expect } from "vitest";
import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import { BUILTIN_CODING_WORKFLOW_IR, BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "@fusion/core";
import type { WorkflowDefinition, WorkflowIrColumn } from "@fusion/core";
import type { WorkflowFlowNodeData } from "../nodes/WorkflowNodeTypes";
import { autoLayout, applyAutoLayout, WF_AUTO_LAYOUT_GAP_X } from "../workflow-auto-layout";
import {
  strictColumnForY,
  bandTop,
  columnBandNodeId,
  COLUMN_BAND_HEIGHT,
  FOREACH_GROUP_WIDTH,
  WF_CARD_MAX_WIDTH,
  irToFlow,
} from "../workflow-flow-mapping";

type N = FlowNode<WorkflowFlowNodeData>;

function node(
  id: string,
  kind: WorkflowFlowNodeData["kind"],
  x: number,
  y: number,
  extra: Partial<N> & { column?: string } = {},
): N {
  const { column, ...rest } = extra;
  return {
    id,
    type: kind,
    position: { x, y },
    data: { kind, label: id, ...(column ? { column } : {}) },
    ...rest,
  } as N;
}

function edge(source: string, target: string, kind?: "rework"): FlowEdge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    data: { condition: "success", kind },
  };
}

const COLUMNS_3: WorkflowIrColumn[] = [
  { id: "triage", name: "Triage", traits: [] },
  { id: "in-progress", name: "In progress", traits: [] },
  { id: "done", name: "Done", traits: [] },
];

/** Mid-band y for a column index (a stable starting placement). */
function midBand(index: number): number {
  return bandTop(index) + COLUMN_BAND_HEIGHT / 2;
}

function workflowDef(ir: WorkflowDefinition["ir"]): WorkflowDefinition {
  return {
    id: ir.name,
    kind: "workflow",
    name: ir.name,
    description: "",
    ir,
    layout: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function nodeWidthFromFlow(node: FlowNode<WorkflowFlowNodeData>): number {
  return typeof node.style?.width === "number" ? node.style.width : WF_CARD_MAX_WIDTH;
}

function assertAutoLayoutRunConnected(
  name: string,
  def: WorkflowDefinition,
  run: readonly string[],
): void {
  const columns = def.ir.version === "v2" ? def.ir.columns : [];
  const flow = irToFlow(def);
  const byId = new Map(flow.nodes.map((candidate) => [candidate.id, candidate] as const));
  const positions = autoLayout(flow.nodes, flow.edges, columns);

  for (const id of run) {
    const node = byId.get(id);
    const position = positions.get(id);
    expect(node, `${name} ${id} node`).toBeTruthy();
    expect(position, `${name} ${id} position`).toBeTruthy();
    if (node && position && node.data.column) {
      expect(strictColumnForY(position.y, columns), `${name} ${id} column`).toBe(node.data.column);
    }
  }

  for (let index = 0; index < run.length - 1; index++) {
    const currentId = run[index];
    const nextId = run[index + 1];
    const current = byId.get(currentId)!;
    const next = byId.get(nextId)!;
    const currentPosition = positions.get(currentId)!;
    const nextPosition = positions.get(nextId)!;
    expect(
      nextPosition.x,
      `${name} ${currentId}->${nextId} should leave rendered-width gap`,
    ).toBeGreaterThanOrEqual(currentPosition.x + nodeWidthFromFlow(current) + WF_AUTO_LAYOUT_GAP_X);
    expect(current.type, `${name} ${currentId} type`).toBe(current.data.kind);
    expect(next.type, `${name} ${nextId} type`).toBe(next.data.kind);
  }
}

describe("autoLayout — v2 (column-preserving)", () => {
  it("linear chain: strictly increasing x and every node keeps its column", () => {
    const nodes: N[] = [
      node("start", "start", 999, midBand(0), { column: "triage" }),
      node("a", "prompt", 50, midBand(1), { column: "in-progress" }),
      node("b", "prompt", 10, midBand(1), { column: "in-progress" }),
      node("end", "end", 0, midBand(2), { column: "done" }),
    ];
    const edges = [edge("start", "a"), edge("a", "b"), edge("b", "end")];
    const pos = autoLayout(nodes, edges, COLUMNS_3);

    const xs = ["start", "a", "b", "end"].map((id) => pos.get(id)!.x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }

    // Invariant: column unchanged for every node.
    for (const n of nodes) {
      const original = n.data.column!;
      const newY = pos.get(n.id)!.y;
      expect(strictColumnForY(newY, COLUMNS_3)).toBe(original);
    }
  });

  it("branching graph: two branch targets get distinct positions", () => {
    const nodes: N[] = [
      node("start", "start", 0, midBand(0), { column: "triage" }),
      node("ok", "prompt", 0, midBand(1), { column: "in-progress" }),
      node("fail", "prompt", 0, midBand(1), { column: "in-progress" }),
    ];
    const edges = [edge("start", "ok"), edge("start", "fail")];
    const pos = autoLayout(nodes, edges, COLUMNS_3);

    const a = pos.get("ok")!;
    const b = pos.get("fail")!;
    expect(a.x === b.x && a.y === b.y).toBe(false);
    // Same layer + same band → stacked vertically.
    expect(a.x).toBe(b.x);
    expect(a.y).not.toBe(b.y);
    expect(strictColumnForY(a.y, COLUMNS_3)).toBe("in-progress");
    expect(strictColumnForY(b.y, COLUMNS_3)).toBe("in-progress");
  });

  it("dense band: more same-layer/same-band nodes than fit 220px stay in-band, staggered x, no collisions", () => {
    const count = 12;
    const nodes: N[] = [node("start", "start", 0, midBand(0), { column: "triage" })];
    const edges: FlowEdge[] = [];
    for (let i = 0; i < count; i++) {
      nodes.push(node(`n${i}`, "prompt", 0, midBand(1), { column: "in-progress" }));
      edges.push(edge("start", `n${i}`));
    }
    const pos = autoLayout(nodes, edges, COLUMNS_3);

    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      const p = pos.get(`n${i}`)!;
      // All stay in their band.
      expect(strictColumnForY(p.y, COLUMNS_3)).toBe("in-progress");
      // No two nodes share a position.
      const key = `${p.x},${p.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Overflow forced horizontal staggering (more than one distinct x).
    const distinctX = new Set([...seen].map((k) => k.split(",")[0]));
    expect(distinctX.size).toBeGreaterThan(1);
  });

  it("derives column from y when data.column is absent", () => {
    const nodes: N[] = [
      node("start", "start", 0, midBand(0)),
      node("a", "prompt", 0, midBand(2)),
    ];
    const pos = autoLayout(nodes, [edge("start", "a")], COLUMNS_3);
    expect(strictColumnForY(pos.get("start")!.y, COLUMNS_3)).toBe("triage");
    expect(strictColumnForY(pos.get("a")!.y, COLUMNS_3)).toBe("done");
  });
});

describe("autoLayout — v1 (free placement)", () => {
  it("produces layered positions, no NaN, deterministic across two calls", () => {
    const nodes: N[] = [
      node("start", "start", 0, 0),
      node("a", "prompt", 0, 0),
      node("b", "prompt", 0, 0),
      node("end", "end", 0, 0),
    ];
    const edges = [edge("start", "a"), edge("start", "b"), edge("a", "end"), edge("b", "end")];
    const p1 = autoLayout(nodes, edges, []);
    const p2 = autoLayout(nodes, edges, []);

    for (const n of nodes) {
      const p = p1.get(n.id)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // start before branches before end.
    expect(p1.get("start")!.x).toBeLessThan(p1.get("a")!.x);
    expect(p1.get("a")!.x).toBeLessThan(p1.get("end")!.x);
    // Deterministic.
    for (const n of nodes) {
      expect(p1.get(n.id)).toEqual(p2.get(n.id));
    }
  });
});

describe("autoLayout — foreach / unreachable / cycles", () => {
  it("spaces layers by container width so group handles do not overlap following nodes", () => {
    const nodes: N[] = [
      node("start", "start", 0, midBand(0), { column: "triage" }),
      node("verify", "optional-group", 0, midBand(1), {
        column: "in-progress",
        style: { width: FOREACH_GROUP_WIDTH, height: 220 },
      }),
      node("review", "prompt", 0, midBand(1), { column: "in-progress" }),
      node("end", "end", 0, midBand(2), { column: "done" }),
    ];
    const pos = autoLayout(nodes, [edge("start", "verify"), edge("verify", "review"), edge("review", "end")], COLUMNS_3);

    expect(pos.get("verify")!.x).toBeGreaterThanOrEqual(pos.get("start")!.x + WF_CARD_MAX_WIDTH + WF_AUTO_LAYOUT_GAP_X);
    expect(pos.get("review")!.x).toBeGreaterThanOrEqual(pos.get("verify")!.x + FOREACH_GROUP_WIDTH + WF_AUTO_LAYOUT_GAP_X);
  });

  it("keeps built-in consecutive container runs connected in the editor layout", () => {
    assertAutoLayoutRunConnected("coding", workflowDef(BUILTIN_CODING_WORKFLOW_IR), [
      "execute",
      "browser-verification",
      "code-review",
      "review",
    ]);
    /*
    FNXC:WorkflowAutoLayout 2026-07-07-08:10:
    FN-7265 (align per-step review workflow) removed the standalone `review` prompt node from the stepwise IR — per-step review now happens inside the foreach (step-review), so the post-foreach success path is steps → browser-verification → code-review → completion-summary → merge-gate. The connected editor run for the stepwise built-in therefore ends at `completion-summary`, not `review`.
    */
    assertAutoLayoutRunConnected("stepwise", workflowDef(BUILTIN_STEPWISE_CODING_WORKFLOW_IR), [
      "steps",
      "browser-verification",
      "code-review",
      "completion-summary",
    ]);
  });

  it("keeps consecutive optional-group foreach and loop containers connected", () => {
    const synthetic: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "container-run",
      columns: COLUMNS_3,
      nodes: [
        { id: "start", kind: "start", column: "triage" },
        {
          id: "optional",
          kind: "optional-group",
          column: "in-progress",
          config: { defaultOn: false, template: { nodes: [], edges: [] } },
        },
        {
          id: "foreach",
          kind: "foreach",
          column: "in-progress",
          config: { source: "task-steps", template: { nodes: [], edges: [] } },
        },
        {
          id: "loop",
          kind: "loop",
          column: "in-progress",
          config: { maxIterations: 2, template: { nodes: [], edges: [] } },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "optional", condition: "success" },
        { from: "optional", to: "foreach", condition: "success" },
        { from: "foreach", to: "loop", condition: "success" },
        { from: "loop", to: "end", condition: "success" },
      ],
    };

    assertAutoLayoutRunConnected("synthetic", workflowDef(synthetic), ["optional", "foreach", "loop", "end"]);
  });

  it("repositions a foreach group but leaves its parentId children untouched", () => {
    const childPos = { x: 30, y: 56 };
    const nodes: N[] = [
      node("start", "start", 0, midBand(0), { column: "triage" }),
      node("grp", "foreach", 999, midBand(1), { column: "in-progress" }),
      {
        id: "grp::c1",
        type: "prompt",
        position: { ...childPos },
        parentId: "grp",
        extent: "parent",
        data: { kind: "prompt", label: "c1" },
      } as N,
    ];
    const edges = [edge("start", "grp")];
    const pos = autoLayout(nodes, edges, COLUMNS_3);

    // Group moved.
    expect(pos.has("grp")).toBe(true);
    expect(pos.get("grp")!.x).not.toBe(999);
    // Child not in the position map → untouched.
    expect(pos.has("grp::c1")).toBe(false);

    const applied = applyAutoLayout(nodes, pos);
    const child = applied.find((n) => n.id === "grp::c1")!;
    expect(child.position).toEqual(childPos);
  });

  it("gives an unreachable node a finite position in a trailing layer", () => {
    const nodes: N[] = [
      node("start", "start", 0, midBand(0), { column: "triage" }),
      node("a", "prompt", 0, midBand(1), { column: "in-progress" }),
      node("orphan", "prompt", 0, midBand(2), { column: "done" }),
    ];
    const edges = [edge("start", "a")];
    const pos = autoLayout(nodes, edges, COLUMNS_3);

    const o = pos.get("orphan")!;
    expect(Number.isFinite(o.x)).toBe(true);
    expect(Number.isFinite(o.y)).toBe(true);
    // Trailing layer is past the reachable nodes.
    expect(o.x).toBeGreaterThan(pos.get("a")!.x);
    expect(strictColumnForY(o.y, COLUMNS_3)).toBe("done");
  });

  it("leaves an unplaced node (no column, parked outside all bands) unplaced", () => {
    // y far below the last band, with no explicit column → strictColumnForY undefined.
    const outsideY = bandTop(COLUMNS_3.length) + 5000;
    const nodes: N[] = [
      node("start", "start", 0, midBand(0), { column: "triage" }),
      node("a", "prompt", 0, midBand(1), { column: "in-progress" }),
      node("loose", "prompt", 0, outsideY),
    ];
    const edges = [edge("start", "a"), edge("a", "loose")];
    const pos = autoLayout(nodes, edges, COLUMNS_3);

    const loose = pos.get("loose")!;
    // y is preserved (still outside every band) — NOT clamped into a band.
    expect(loose.y).toBe(outsideY);
    expect(strictColumnForY(loose.y, COLUMNS_3)).toBeUndefined();
    // x still flows left-to-right with the layering tidy.
    expect(loose.x).toBeGreaterThan(pos.get("a")!.x);
  });

  it("terminates and stays sane with a rework cycle edge present", () => {
    const nodes: N[] = [
      node("start", "start", 0, midBand(0), { column: "triage" }),
      node("a", "prompt", 0, midBand(1), { column: "in-progress" }),
      node("b", "prompt", 0, midBand(1), { column: "in-progress" }),
      node("end", "end", 0, midBand(2), { column: "done" }),
    ];
    const edges = [
      edge("start", "a"),
      edge("a", "b"),
      edge("b", "end"),
      edge("b", "a", "rework"), // rework loop — ignored for layering
    ];
    const pos = autoLayout(nodes, edges, COLUMNS_3);

    // Layering ignores rework: a strictly before b.
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
    for (const n of nodes) {
      expect(strictColumnForY(pos.get(n.id)!.y, COLUMNS_3)).toBe(n.data.column);
    }
  });

  it("ignores column band group nodes", () => {
    const nodes: N[] = [
      {
        id: columnBandNodeId("triage"),
        type: "group",
        position: { x: -40, y: bandTop(0) },
        data: { kind: "start", label: "Triage" },
      } as N,
      node("start", "start", 0, midBand(0), { column: "triage" }),
    ];
    const pos = autoLayout(nodes, [], COLUMNS_3);
    expect(pos.has(columnBandNodeId("triage"))).toBe(false);
    expect(pos.has("start")).toBe(true);
  });
});

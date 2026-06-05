import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@fusion/core";
import type { Node as FlowNode } from "@xyflow/react";
import {
  irToFlow,
  flowToIr,
  columnsOf,
  columnForY,
  bandTop,
  columnsToBandNodes,
  isColumnBandNode,
  validateColumnsClient,
  unplacedNodeIds,
  foreachChildFlowId,
  templateNodeIdFromChild,
  shortConditionLabel,
  COLUMN_BAND_HEIGHT,
} from "../workflow-flow-mapping";
import type { WorkflowFlowNodeData } from "../nodes/WorkflowNodeTypes";
import type { TraitCatalogEntry } from "../../api";

function makeDef(ir: WorkflowDefinition["ir"]): WorkflowDefinition {
  return {
    id: "WF-001",
    name: ir.name,
    description: "",
    ir,
    layout: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("workflow-flow-mapping name preservation", () => {
  it("does not inject synthetic names for unnamed start/end/merge nodes on round-trip", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { prompt: "do work" } },
        { id: "m1", kind: "prompt", config: { seam: "merge" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1", condition: "success" },
        { from: "n1", to: "m1", condition: "success" },
        { from: "m1", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(ir));
    const { ir: out } = flowToIr("wf", nodes, edges);

    const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n]));
    // start/end carry no config or a config without an injected name
    expect(byId.start.config?.name).toBeUndefined();
    expect(byId.end.config?.name).toBeUndefined();
    // merge boundary keeps its seam but does not gain a synthetic "Merge boundary" name
    expect(byId.m1.config?.seam).toBe("merge");
    expect(byId.m1.config?.name).toBeUndefined();
    // an unnamed prompt node keeps no synthetic id-as-name
    expect(byId.n1.config?.name).toBeUndefined();
    expect(byId.n1.config?.prompt).toBe("do work");
  });

  it("preserves an explicit node name across round-trips", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { name: "Implement", prompt: "do work" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1", condition: "success" },
        { from: "n1", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(ir));
    const { ir: out } = flowToIr("wf", nodes, edges);
    const n1 = out.nodes.find((n) => n.id === "n1");
    expect(n1?.config?.name).toBe("Implement");
  });

  it("persists a user-entered label as the node name", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { prompt: "do work" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1", condition: "success" },
        { from: "n1", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(ir));
    // Simulate the editor renaming the node via its label input.
    const renamed = nodes.map((n) =>
      n.id === "n1" ? { ...n, data: { ...n.data, label: "Build feature" } } : n,
    );
    const { ir: out } = flowToIr("wf", renamed, edges);
    const n1 = out.nodes.find((n) => n.id === "n1");
    expect(n1?.config?.name).toBe("Build feature");
  });
});

// ── U10: v2 round-trip (columns, placement, hold, split/join) ────────────────

const CATALOG: TraitCatalogEntry[] = [
  { id: "intake", name: "Intake", builtin: true, flags: { intake: true } },
  { id: "complete", name: "Complete", builtin: true, flags: { complete: true } },
  { id: "archived", name: "Archived", builtin: true, flags: { archived: true, hiddenFromBoard: true } },
  { id: "wip", name: "WIP", builtin: true, flags: { countsTowardWip: true } },
  { id: "hold", name: "Hold", builtin: true, flags: { hold: true } },
];

function v2Def(ir: WorkflowDefinition["ir"], layout: WorkflowDefinition["layout"] = {}): WorkflowDefinition {
  return { ...makeDef(ir), layout };
}

describe("workflow-flow-mapping v2 round-trip", () => {
  const ir: WorkflowDefinition["ir"] = {
    version: "v2",
    name: "wf2",
    columns: [
      { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip", config: { limit: 2 } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "triage" },
      { id: "h1", kind: "hold", column: "triage", config: { release: "manual" } },
      { id: "s1", kind: "split", column: "in-progress" },
      { id: "b1", kind: "prompt", column: "in-progress", config: { prompt: "lint" } },
      { id: "b2", kind: "prompt", column: "in-progress", config: { prompt: "test" } },
      { id: "j1", kind: "join", column: "in-progress", config: { mode: { quorum: 2 }, onBranchFailure: "fail-fast" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "h1", condition: "success" },
      { from: "h1", to: "s1", condition: "success" },
      { from: "s1", to: "b1", condition: "success" },
      { from: "s1", to: "b2", condition: "success" },
      { from: "b1", to: "j1", condition: "success" },
      { from: "b2", to: "j1", condition: "success" },
      { from: "j1", to: "end", condition: "success" },
    ],
  };

  it("round-trips columns, placement, hold, and split/join config losslessly", () => {
    const { nodes, edges } = irToFlow(v2Def(ir));
    const columns = columnsOf(v2Def(ir));
    const { ir: out } = flowToIr("wf2", nodes, edges, columns);

    expect(out.version).toBe("v2");
    if (out.version !== "v2") return;

    // Columns preserved in order with their traits.
    expect(out.columns.map((c) => c.id)).toEqual(["triage", "in-progress", "done"]);
    expect(out.columns[1].traits).toEqual([{ trait: "wip", config: { limit: 2 } }]);

    const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n]));
    // Placement preserved for every node.
    expect(byId.h1.column).toBe("triage");
    expect(byId.s1.column).toBe("in-progress");
    expect(byId.j1.column).toBe("in-progress");
    expect(byId.end.column).toBe("done");
    // Hold release config preserved.
    expect(byId.h1.config?.release).toBe("manual");
    // Split/join shape preserved.
    expect(byId.s1.kind).toBe("split");
    expect(byId.j1.kind).toBe("join");
    expect(byId.j1.config?.mode).toEqual({ quorum: 2 });
    expect(byId.j1.config?.onBranchFailure).toBe("fail-fast");
  });

  it("emits swimlane band group nodes that flowToIr strips back out", () => {
    const { nodes } = irToFlow(v2Def(ir));
    const bands = nodes.filter((n) => isColumnBandNode(n.id));
    expect(bands).toHaveLength(3);
    expect(bands.every((b) => b.type === "group")).toBe(true);
    // flowToIr must not emit band group nodes as IR nodes.
    const { ir: out } = flowToIr("wf2", nodes, [], columnsOf(v2Def(ir)));
    expect(out.nodes.some((n) => isColumnBandNode(n.id))).toBe(false);
  });

  it("derives node.column by position when a node is dropped into a band", () => {
    const columns = columnsOf(v2Def(ir));
    // Band index 2 = "done"; a node dragged to that band's y resolves to it.
    const yInDone = bandTop(2) + 40;
    expect(columnForY(yInDone, columns)).toBe("done");

    // Simulate a node moved into the "done" band with no explicit data.column.
    const stepNode: FlowNode<WorkflowFlowNodeData> = {
      id: "n9",
      type: "prompt",
      position: { x: 100, y: yInDone },
      data: { kind: "prompt", label: "ship", config: {} },
    };
    const bandNodes = columnsToBandNodes(columns);
    const { ir: out } = flowToIr("wf2", [...bandNodes, stepNode], [], columns);
    const n9 = out.version === "v2" ? out.nodes.find((n) => n.id === "n9") : undefined;
    expect(n9?.column).toBe("done");
  });

  it("v1 definitions map to empty columns (legacy round-trip stays v1)", () => {
    const v1: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "end", kind: "end" },
      ],
      edges: [{ from: "start", to: "end", condition: "success" }],
    };
    const def = makeDef(v1);
    expect(columnsOf(def)).toEqual([]);
    const { nodes, edges } = irToFlow(def);
    const { ir: out } = flowToIr("wf", nodes, edges, columnsOf(def));
    expect(out.version).toBe("v1");
  });
});

describe("workflow-flow-mapping validation helpers", () => {
  it("flags a trait conflict on the offending column", () => {
    const columns = [
      { id: "done", name: "Done", traits: [{ trait: "complete" }, { trait: "wip" }] },
    ];
    const violations = validateColumnsClient(columns, CATALOG);
    const conflict = violations.find((v) => v.code === "complete-with-wip");
    expect(conflict).toBeTruthy();
    expect(conflict?.columnId).toBe("done");
    expect(conflict?.severity).toBe("error");
  });

  it("flags more than one intake column workflow-wide", () => {
    const columns = [
      { id: "a", name: "A", traits: [{ trait: "intake" }] },
      { id: "b", name: "B", traits: [{ trait: "intake" }] },
    ];
    const v = validateColumnsClient(columns, CATALOG).find((x) => x.code === "multiple-intake-columns");
    expect(v?.columnId).toBeNull();
  });

  it("reports unplaced step nodes (not start/end, not bands)", () => {
    const columns = columnsOf(
      v2Def({
        version: "v2",
        name: "w",
        columns: [{ id: "c1", name: "C1", traits: [] }],
        nodes: [
          { id: "start", kind: "start" },
          { id: "end", kind: "end" },
        ],
        edges: [{ from: "start", to: "end", condition: "success" }],
      }),
    );
    const placed: FlowNode<WorkflowFlowNodeData> = {
      id: "p1",
      type: "prompt",
      position: { x: 0, y: bandTop(0) + 20 },
      data: { kind: "prompt", label: "x", config: {}, column: "c1" },
    };
    // A fresh node parked far below the single band (no explicit column) is
    // strictly outside every band → unplaced.
    const floating: FlowNode<WorkflowFlowNodeData> = {
      id: "float",
      type: "prompt",
      position: { x: 0, y: bandTop(0) + COLUMN_BAND_HEIGHT * 5 },
      data: { kind: "prompt", label: "y", config: {} },
    };
    const ids = unplacedNodeIds(
      [...columnsToBandNodes(columns), placed, floating,
        { id: "start", type: "start", position: { x: 0, y: 0 }, data: { kind: "start", label: "" } },
        { id: "end", type: "end", position: { x: 0, y: 0 }, data: { kind: "end", label: "" } },
      ],
      columns,
    );
    expect(ids).not.toContain("p1");
    expect(ids).not.toContain("start");
    expect(ids).not.toContain("end");
    expect(ids).toContain("float");
  });

  it("treats a node with an unknown column id as unplaced", () => {
    const columns = [{ id: "c1", name: "C1", traits: [] }];
    const ghost: FlowNode<WorkflowFlowNodeData> = {
      id: "ghost",
      type: "prompt",
      position: { x: 0, y: bandTop(0) },
      data: { kind: "prompt", label: "x", config: {}, column: "no-such-column" },
    };
    const ids = unplacedNodeIds([ghost], columns);
    expect(ids).toContain("ghost");
  });

  it("band height stays positive (geometry sanity)", () => {
    expect(COLUMN_BAND_HEIGHT).toBeGreaterThan(0);
  });
});

// ── U8: step-inversion round-trip (foreach template, rework edges) ───────────

describe("workflow-flow-mapping foreach + rework round-trip", () => {
  const ir: WorkflowDefinition["ir"] = {
    version: "v2",
    name: "stepwise",
    columns: [
      { id: "plan", name: "Plan", traits: [] },
      { id: "in-progress", name: "In progress", traits: [] },
      { id: "done", name: "Done", traits: [] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "plan" },
      { id: "parse", kind: "parse-steps", column: "plan", config: { artifact: "PROMPT.md", parser: "step-headings" } },
      {
        id: "loop",
        kind: "foreach",
        column: "in-progress",
        config: {
          source: "task-steps",
          mode: "sequential",
          isolation: "shared",
          maxReworkCycles: 3,
          template: {
            nodes: [
              { id: "exec", kind: "prompt", config: { seam: "step-execute", prompt: "do step" } },
              { id: "review", kind: "step-review", config: { type: "code" } },
            ],
            edges: [
              { from: "exec", to: "review", condition: "success" },
              { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" },
            ],
          },
        },
      },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "parse", condition: "success" },
      { from: "parse", to: "loop", condition: "success" },
      { from: "loop", to: "end", condition: "success" },
    ],
  };

  it("round-trips foreach template (children partitioned by parentId) losslessly", () => {
    const def = makeDef(ir);
    const { nodes, edges } = irToFlow(def);
    const columns = columnsOf(def);

    // The foreach group + its two template children render as parented nodes.
    const group = nodes.find((n) => n.id === "loop");
    expect(group?.type).toBe("foreach");
    const children = nodes.filter((n) => n.parentId === "loop");
    expect(children.map((c) => c.id).sort()).toEqual(
      [foreachChildFlowId("loop", "exec"), foreachChildFlowId("loop", "review")].sort(),
    );
    // Template edges (incl. the rework edge) live inside the group's id-scope.
    const reworkFlowEdge = edges.find((e) => e.data?.kind === "rework");
    expect(reworkFlowEdge).toBeTruthy();
    expect(reworkFlowEdge?.source).toBe(foreachChildFlowId("loop", "review"));

    const { ir: out } = flowToIr("stepwise", nodes, edges, columns);
    if (out.version !== "v2") throw new Error("expected v2");
    const loop = out.nodes.find((n) => n.id === "loop");
    expect(loop?.kind).toBe("foreach");
    const cfg = loop?.config as Record<string, unknown>;
    expect(cfg.source).toBe("task-steps");
    expect(cfg.mode).toBe("sequential");
    expect(cfg.maxReworkCycles).toBe(3);
    const template = cfg.template as { nodes: unknown[]; edges: { from: string; to: string; condition?: string; kind?: string }[] };
    // Template node ids are template-local (de-namespaced), not flow ids.
    expect((template.nodes as { id: string }[]).map((n) => n.id).sort()).toEqual(["exec", "review"]);
    // The rework edge survives with its kind and outcome condition.
    const rework = template.edges.find((e) => e.kind === "rework");
    expect(rework).toEqual({ from: "review", to: "exec", condition: "outcome:revise", kind: "rework" });
    // The plain success edge has no kind.
    const success = template.edges.find((e) => e.condition === "success");
    expect(success?.kind).toBeUndefined();
    // Top-level edges exclude the intra-template ones.
    expect(out.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "start->parse",
      "parse->loop",
      "loop->end",
    ]);
    // parse-steps config preserved.
    const parse = out.nodes.find((n) => n.id === "parse");
    expect(parse?.config).toMatchObject({ artifact: "PROMPT.md", parser: "step-headings" });
  });

  it("round-trips a code node config (source + timeoutMs)", () => {
    const codeIr: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "c1", kind: "code", config: { source: "export default async()=>({})", timeoutMs: 5000 } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "c1", condition: "success" },
        { from: "c1", to: "end", condition: "success" },
      ],
    };
    const { nodes, edges } = irToFlow(makeDef(codeIr));
    const { ir: out } = flowToIr("wf", nodes, edges);
    const c1 = out.nodes.find((n) => n.id === "c1");
    expect(c1?.kind).toBe("code");
    expect(c1?.config).toMatchObject({ source: "export default async()=>({})", timeoutMs: 5000 });
  });

  it("child id namespacing helpers are inverse", () => {
    const fid = foreachChildFlowId("loop", "exec");
    expect(templateNodeIdFromChild("loop", fid)).toBe("exec");
    // A non-namespaced id passes through unchanged.
    expect(templateNodeIdFromChild("loop", "other")).toBe("other");
  });

  it("shortens outcome:<verdict> edge labels", () => {
    expect(shortConditionLabel("outcome:approve")).toBe("approve");
    expect(shortConditionLabel("success")).toBe("success");
  });

  it("does not flag foreach template children as unplaced", () => {
    const def = makeDef(ir);
    const { nodes } = irToFlow(def);
    const columns = columnsOf(def);
    const ids = unplacedNodeIds(nodes, columns);
    expect(ids).not.toContain(foreachChildFlowId("loop", "exec"));
    expect(ids).not.toContain(foreachChildFlowId("loop", "review"));
  });
});

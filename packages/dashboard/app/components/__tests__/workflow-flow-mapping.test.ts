import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition, WorkflowIrNodeKind } from "@fusion/core";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
  parseWorkflowIr,
  validateColumnTraits,
} from "@fusion/core";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { ReactFlowProvider } from "@xyflow/react";
import {
  irToFlow,
  flowToIr,
  insertFragment,
  optionalGroupFragmentIr,
  fragmentSeamConflicts,
  copyIrWithFreshIds,
  columnsOf,
  columnForY,
  bandTop,
  columnsToBandNodes,
  isColumnBandNode,
  reconcileNodeColumns,
  validateColumnsClient,
  unplacedNodeIds,
  foreachChildFlowId,
  templateNodeIdFromChild,
  shortConditionLabel,
  edgeClassName,
  edgeConditionEditability,
  isVisualOnlyWorkflowEdge,
  wouldCreateCycle,
  buildConnectionEdge,
  cascadeDelete,
  refreshTemplateContainerVisualBoundaries,
  COLUMN_BAND_HEIGHT,
  WF_CARD_WIDTH,
  WF_FALLBACK_NODE_GAP,
  WF_CARD_MAX_WIDTH,
  WF_CARD_HEIGHT,
  FOREACH_GROUP_WIDTH,
  FOREACH_GROUP_HEIGHT,
  FOREACH_CHILD_X,
  FOREACH_CHILD_Y,
} from "../workflow-flow-mapping";
import { workflowNodeTypes } from "../nodes/WorkflowNodeTypes";
import type { WorkflowEditorNodeKind, WorkflowFlowNodeData } from "../nodes/WorkflowNodeTypes";
import type { TraitCatalogEntry } from "../../api";

function makeDef(ir: WorkflowDefinition["ir"], layout: WorkflowDefinition["layout"] = {}): WorkflowDefinition {
  return {
    id: "WF-001",
    kind: "workflow",
    name: ir.name,
    description: "",
    ir,
    layout,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function nodeWidth(node: FlowNode<WorkflowFlowNodeData>): number {
  const width = node.style?.width;
  return typeof width === "number" ? width : WF_CARD_WIDTH;
}

function assertRenderedHandles(
  kind: WorkflowEditorNodeKind,
  data: WorkflowFlowNodeData,
  expected: { target: number; source: number },
): void {
  const Component = workflowNodeTypes[kind];
  const { container, unmount } = render(
    createElement(ReactFlowProvider, null, createElement(Component, { data, id: `${kind}-handle-check` })),
  );
  try {
    const root = container.querySelector(`[data-testid="wf-node-${kind}"]`);
    expect(root).not.toBeNull();
    expect(root?.querySelectorAll(".react-flow__handle.target")).toHaveLength(expected.target);
    expect(root?.querySelectorAll(".react-flow__handle.source")).toHaveLength(expected.source);
  } finally {
    unmount();
  }
}

function assertContainerHandles(kind: "optional-group" | "foreach" | "loop", data: WorkflowFlowNodeData): void {
  assertRenderedHandles(kind, data, { target: 2, source: 2 });
}

function assertRunDoesNotOverlap(
  name: string,
  nodes: FlowNode<WorkflowFlowNodeData>[],
  run: readonly string[],
  gap = 0,
): void {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  for (let index = 0; index < run.length - 1; index++) {
    const currentId = run[index];
    const nextId = run[index + 1];
    const current = byId.get(currentId);
    const next = byId.get(nextId);
    expect(current, `${name} ${currentId}`).toBeTruthy();
    expect(next, `${name} ${nextId}`).toBeTruthy();
    expect(
      next!.position.x,
      `${name} ${currentId}->${nextId} should leave rendered-width gap`,
    ).toBeGreaterThanOrEqual(current!.position.x + nodeWidth(current!) + gap);
  }
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


  it("preserves aliased IR node kinds when round-tripping through editor render kinds", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "merge aliases",
      columns: [{ id: "in-progress", name: "In progress", traits: [] }],
      nodes: [
        { id: "gate", kind: "merge-gate", column: "in-progress", config: { name: "Gate" } },
        { id: "attempt", kind: "merge-attempt", column: "in-progress" },
        { id: "hold", kind: "manual-merge-hold", column: "in-progress", config: { release: "manual" } },
        {
          id: "retry",
          kind: "retry-backoff",
          column: "in-progress",
          config: {
            maxIterations: 2,
            template: {
              nodes: [{ id: "retry-step", kind: "prompt", config: { prompt: "try again" } }],
              edges: [{ from: "retry-step", to: "retry-step", condition: "retry", kind: "rework" }],
            },
          },
        },
      ] as WorkflowDefinition["ir"]["nodes"],
      edges: [],
    };

    const { nodes, edges } = irToFlow(v2Def(ir));
    expect(nodes.find((node) => node.id === "gate")?.type).toBe("gate");
    expect(nodes.find((node) => node.id === "hold")?.type).toBe("hold");
    expect(nodes.find((node) => node.id === "retry")?.type).toBe("hold");

    const { ir: out } = flowToIr("merge aliases", nodes, edges, columnsOf(v2Def(ir)));
    if (out.version !== "v2") throw new Error("expected v2");
    const byId = Object.fromEntries(out.nodes.map((node) => [node.id, node]));
    expect(byId.gate.kind).toBe("merge-gate");
    expect(byId.gate.config?.name).toBe("Gate");
    expect(byId.attempt.kind).toBe("merge-attempt");
    expect(byId.hold.kind).toBe("manual-merge-hold");
    expect(byId.hold.config?.release).toBe("manual");
    expect(byId.retry.kind).toBe("retry-backoff");
    expect(byId.retry.config).toEqual({
      maxIterations: 2,
      template: {
        nodes: [{ id: "retry-step", kind: "prompt", config: { prompt: "try again" } }],
        edges: [{ from: "retry-step", to: "retry-step", condition: "retry", kind: "rework" }],
      },
    });
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

  it("preserves start node column edits through the flow mapping round-trip", () => {
    const definition = v2Def(ir);
    const { nodes, edges } = irToFlow(definition);
    const edited = nodes.map((node) =>
      node.id === "start" ? { ...node, data: { ...node.data, column: "done" } } : node,
    );

    const { ir: out } = flowToIr("wf2", edited, edges, columnsOf(definition));

    if (out.version !== "v2") throw new Error("expected v2");
    expect(out.nodes.find((node) => node.kind === "start")?.column).toBe("done");
  });

  it("clears stale node columns while preserving valid placement and group nodes", () => {
    const columns = [
      { id: "todo", name: "Todo", traits: [] },
      { id: "done", name: "Done", traits: [] },
    ];
    const validStep: FlowNode<WorkflowFlowNodeData> = {
      id: "valid",
      type: "prompt",
      position: { x: 0, y: 0 },
      data: { kind: "prompt", label: "valid", column: "todo" },
    };
    const nodes: FlowNode<WorkflowFlowNodeData>[] = [
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { kind: "start", label: "start", column: "missing" } },
      { id: "step", type: "prompt", position: { x: 0, y: 0 }, data: { kind: "prompt", label: "step", column: "missing" } },
      { id: "end", type: "end", position: { x: 0, y: 0 }, data: { kind: "end", label: "end", column: "missing" } },
      validStep,
      columnsToBandNodes([{ id: "missing", name: "Old", traits: [] }])[0],
      { id: "template-group", type: "group", position: { x: 0, y: 0 }, data: { kind: "foreach", label: "group", column: "missing" } },
    ];

    const reconciled = reconcileNodeColumns(nodes, columns);

    expect(reconciled.find((node) => node.id === "start")?.data.column).toBeUndefined();
    expect(reconciled.find((node) => node.id === "step")?.data.column).toBeUndefined();
    expect(reconciled.find((node) => node.id === "end")?.data.column).toBeUndefined();
    expect(reconciled.find((node) => node.id === "valid")).toBe(validStep);
    expect(reconciled.find((node) => isColumnBandNode(node.id))?.data.column).toBe("missing");
    expect(reconciled.find((node) => node.id === "template-group")?.data.column).toBe("missing");
  });

  it("preserves column references across rename and reorder because ids remain stable", () => {
    const node: FlowNode<WorkflowFlowNodeData> = {
      id: "step",
      type: "prompt",
      position: { x: 0, y: 0 },
      data: { kind: "prompt", label: "step", column: "todo" },
    };

    expect(reconcileNodeColumns([node], [{ id: "todo", name: "Renamed Todo", traits: [] }])).toBeInstanceOf(Array);
    expect(reconcileNodeColumns([node], [{ id: "todo", name: "Renamed Todo", traits: [] }])[0]).toBe(node);
    expect(
      reconcileNodeColumns(
        [node],
        [
          { id: "done", name: "Done", traits: [] },
          { id: "todo", name: "Todo", traits: [] },
        ],
      )[0],
    ).toBe(node);
  });

  it("clears stale columns when the authored column set is empty", () => {
    const node: FlowNode<WorkflowFlowNodeData> = {
      id: "start",
      type: "start",
      position: { x: 0, y: 0 },
      data: { kind: "start", label: "start", column: "todo" },
    };

    const reconciled = reconcileNodeColumns([node], []);

    expect(reconciled[0]).not.toBe(node);
    expect(reconciled[0].data.column).toBeUndefined();
  });

  it("prevents stale start-node column ids from reaching IR validation after re-add", () => {
    const staleColumns = [{ id: "todo", name: "Todo", traits: [] }];
    const nextColumns = [{ id: "col-new", name: "Todo", traits: [] }];
    const nodes: FlowNode<WorkflowFlowNodeData>[] = [
      ...columnsToBandNodes(staleColumns),
      { id: "start", type: "start", position: { x: 0, y: 0 }, data: { kind: "start", label: "start", column: "todo" } },
      { id: "end", type: "end", position: { x: 100, y: 0 }, data: { kind: "end", label: "end", column: "todo" } },
    ];
    const startToEnd = [{ id: "e-start-end", source: "start", target: "end", data: { condition: "success" } }];
    const staleIr = flowToIr("wf", nodes, startToEnd, nextColumns).ir;
    expect(() => parseWorkflowIr(staleIr)).toThrow(/references undefined column 'todo'/);

    const reconciled = reconcileNodeColumns(nodes.filter((node) => !isColumnBandNode(node.id)), nextColumns);
    const { ir: out } = flowToIr("wf", [...columnsToBandNodes(nextColumns), ...reconciled], startToEnd, nextColumns);

    expect(() => parseWorkflowIr(out)).not.toThrow();
    if (out.version !== "v2") throw new Error("expected v2");
    expect(out.nodes.find((node) => node.id === "start")?.column).toBe("col-new");
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

  it("round-trips notify nodes as first-class editor nodes", () => {
    const notifyIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "notify-wf",
      columns: [{ id: "todo", name: "Todo", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        {
          id: "notify",
          kind: "notify",
          column: "todo",
          config: { event: "workflow-notify", title: "{{taskTitle}}", message: "Task {{taskId}}" },
        },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [
        { from: "start", to: "notify", condition: "success" },
        { from: "notify", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(v2Def(notifyIr));
    const notifyNode = nodes.find((node) => node.id === "notify");
    expect(notifyNode?.type).toBe("notify");
    expect(notifyNode?.data.kind).toBe("notify");

    const { ir: out } = flowToIr("notify-wf", nodes, edges, columnsOf(v2Def(notifyIr)));
    expect(out.version).toBe("v2");
    if (out.version !== "v2") return;
    const roundTripped = out.nodes.find((node) => node.id === "notify");
    expect(roundTripped).toMatchObject({
      kind: "notify",
      column: "todo",
      config: { event: "workflow-notify", title: "{{taskTitle}}", message: "Task {{taskId}}" },
    });
  });

  // FN-7579: ask-user and exit-gate round-trip like any other first-class editor node.
  it("round-trips ask-user and exit-gate nodes (brainstorming composition) losslessly", () => {
    const brainstormIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "brainstorm-wf",
      columns: [{ id: "todo", name: "Todo", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "ask", kind: "ask-user", column: "todo", config: { question: "Anything to refine?" } },
        {
          id: "exit",
          kind: "exit-gate",
          column: "todo",
          config: { condition: { type: "output-contains", nodeId: "ask", value: "looks good" } },
        },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [
        { from: "start", to: "ask", condition: "success" },
        { from: "ask", to: "exit", condition: "success" },
        { from: "exit", to: "end", condition: "outcome:exit" },
      ],
    };

    const { nodes, edges } = irToFlow(v2Def(brainstormIr));
    const askNode = nodes.find((node) => node.id === "ask");
    expect(askNode?.type).toBe("ask-user");
    expect(askNode?.data.kind).toBe("ask-user");
    const exitNode = nodes.find((node) => node.id === "exit");
    expect(exitNode?.type).toBe("exit-gate");
    expect(exitNode?.data.kind).toBe("exit-gate");

    const { ir: out } = flowToIr("brainstorm-wf", nodes, edges, columnsOf(v2Def(brainstormIr)));
    expect(out.version).toBe("v2");
    if (out.version !== "v2") return;
    expect(out.nodes.find((node) => node.id === "ask")).toMatchObject({
      kind: "ask-user",
      column: "todo",
      config: { question: "Anything to refine?" },
    });
    expect(out.nodes.find((node) => node.id === "exit")).toMatchObject({
      kind: "exit-gate",
      column: "todo",
      config: { condition: { type: "output-contains", nodeId: "ask", value: "looks good" } },
    });
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

  it("mirrors server trait ids for save-blocking composition conflicts", () => {
    const columns = [
      { id: "complete-wip", name: "Complete WIP", traits: [{ trait: "complete" }, { trait: "wip" }] },
      { id: "two-wip", name: "Two WIP", traits: [{ trait: "wip" }, { trait: "wip" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }, { trait: "intake" }] },
      { id: "archive", name: "Archive", traits: [{ trait: "archived" }, { trait: "wip" }] },
    ];
    const clientViolations = validateColumnsClient(columns, CATALOG);
    const serverViolations = validateColumnTraits(columns);

    for (const code of ["complete-with-wip", "two-capacity-traits", "complete-with-intake", "archived-with-wip"] as const) {
      expect(clientViolations.find((v) => v.code === code)?.traitIds.sort()).toEqual(
        serverViolations.find((v) => v.code === code)?.traitIds.sort(),
      );
    }
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

// ── IR-only graph node kinds map to existing editor node shapes ─────────────

const VALID_EDITOR_NODE_KINDS: readonly WorkflowEditorNodeKind[] = [
  "start",
  "end",
  "prompt",
  "script",
  "gate",
  "merge",
  "hold",
  "split",
  "join",
  "foreach",
  "loop",
  "step-review",
  "parse-steps",
  "code",
  "notify",
  "ask-user",
  "exit-gate",
];

const IR_ONLY_EDITOR_KIND = {
  "merge-gate": "gate",
  "merge-attempt": "merge",
  "manual-merge-hold": "hold",
  "retry-backoff": "hold",
  "recovery-router": "gate",
  "branch-group-member-integration": "merge",
  "branch-group-promotion": "merge",
} satisfies Partial<Record<WorkflowIrNodeKind, WorkflowEditorNodeKind>>;

describe("workflow-flow-mapping editor kind mapping", () => {
  it("maps workflow-owned IR-only node kinds to valid editor kinds", () => {
    const irOnlyKinds = Object.keys(IR_ONLY_EDITOR_KIND) as (keyof typeof IR_ONLY_EDITOR_KIND)[];
    const ir: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "policy-nodes",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "work" },
        ...irOnlyKinds.map((kind) => ({ id: kind, kind, column: "work" as const })),
        { id: "foreach", kind: "foreach", column: "work", config: {
          source: "task-steps",
          template: {
            nodes: [{ id: "template-merge-gate", kind: "merge-gate" }],
            edges: [],
          },
        } },
        { id: "end", kind: "end", column: "work" },
      ],
      edges: [],
    };

    const { nodes } = irToFlow(makeDef(ir));
    const stepNodes = nodes.filter((node) => !isColumnBandNode(node.id));
    expect(stepNodes.every((node) => VALID_EDITOR_NODE_KINDS.includes(node.data.kind))).toBe(true);
    expect(stepNodes.every((node) => VALID_EDITOR_NODE_KINDS.includes(node.type as WorkflowEditorNodeKind))).toBe(true);

    for (const rawKind of irOnlyKinds) {
      const flowNode = stepNodes.find((node) => node.id === rawKind);
      const expectedKind = IR_ONLY_EDITOR_KIND[rawKind];
      expect(flowNode?.type).toBe(expectedKind);
      expect(flowNode?.data.kind).toBe(expectedKind);
      expect(flowNode?.type).not.toBe(rawKind);
      expect(flowNode?.data.kind).not.toBe(rawKind);
    }

    const templateChild = stepNodes.find((node) => node.id === foreachChildFlowId("foreach", "template-merge-gate"));
    expect(templateChild?.type).toBe("gate");
    expect(templateChild?.data.kind).toBe("gate");
    expect(templateChild?.type).not.toBe("merge-gate");
  });

  it("keeps merge seam and PR graph-node special cases mapped to existing editor kinds", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "special-cases",
      nodes: [
        { id: "merge-seam", kind: "prompt", config: { seam: "merge" } },
        { id: "pr-merge", kind: "pr-merge" },
        { id: "pr-create", kind: "pr-create" },
        { id: "pr-respond", kind: "pr-respond" },
      ],
      edges: [],
    };

    const byId = Object.fromEntries(irToFlow(makeDef(ir)).nodes.map((node) => [node.id, node]));
    expect(byId["merge-seam"]?.type).toBe("merge");
    expect(byId["merge-seam"]?.data.kind).toBe("merge");
    expect(byId["pr-merge"]?.type).toBe("merge");
    expect(byId["pr-merge"]?.data.kind).toBe("merge");
    expect(byId["pr-create"]?.type).toBe("prompt");
    expect(byId["pr-create"]?.data.kind).toBe("prompt");
    expect(byId["pr-respond"]?.type).toBe("prompt");
    expect(byId["pr-respond"]?.data.kind).toBe("prompt");
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

  it("round-trips loop templates through parented group children", () => {
    const loopIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "bounded-loop",
      columns: ir.columns,
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        {
          id: "retry",
          kind: "loop",
          column: "in-progress",
          config: {
            maxIterations: 4,
            timeoutMs: 60000,
            exitWhen: { type: "output-matches", nodeId: "check", pattern: "DONE|COMPLETE" },
            template: {
              nodes: [
                { id: "try", kind: "prompt", config: { prompt: "try once" } },
                { id: "check", kind: "gate", config: { prompt: "done?" } },
              ],
              edges: [{ from: "try", to: "check", condition: "success" }],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "retry", condition: "success" },
        { from: "retry", to: "end", condition: "success" },
      ],
    };
    const { nodes, edges } = irToFlow(makeDef(loopIr));

    const group = nodes.find((n) => n.id === "retry");
    expect(group?.type).toBe("loop");
    expect(group?.data.kind).toBe("loop");
    expect(nodes.filter((n) => n.parentId === "retry").map((n) => templateNodeIdFromChild("retry", n.id))).toEqual([
      "try",
      "check",
    ]);

    const { ir: out } = flowToIr("bounded-loop", nodes, edges, columnsOf(makeDef(loopIr)));
    if (out.version !== "v2") throw new Error("expected v2");
    const retry = out.nodes.find((n) => n.id === "retry");
    expect(retry?.kind).toBe("loop");
    expect(retry?.config).toMatchObject({
      maxIterations: 4,
      timeoutMs: 60000,
      exitWhen: { type: "output-matches", nodeId: "check", pattern: "DONE|COMPLETE" },
    });
    const template = retry?.config?.template as { nodes: { id: string }[]; edges: { from: string; to: string }[] };
    expect(template.nodes.map((n) => n.id)).toEqual(["try", "check"]);
    expect(template.edges).toEqual([{ from: "try", to: "check", condition: "success" }]);
  });

  // FNXC:WorkflowOptionalGroup 2026-06-21-11:30: An optional-group's template
  // subgraph must round-trip through the editor's parentId-child rendering exactly
  // like foreach/loop — irToFlow renders the template as parented children;
  // flowToIr reassembles them into config.template, preserving defaultOn/name.
  it("round-trips an optional-group template (children partitioned by parentId) losslessly", () => {
    const optionalIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "optional",
      columns: ir.columns,
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        {
          id: "opt",
          kind: "optional-group",
          column: "in-progress",
          config: {
            defaultOn: true,
            name: "Browser verification",
            template: {
              nodes: [
                { id: "verify", kind: "prompt", config: { prompt: "verify in browser" } },
                { id: "check", kind: "gate", config: { prompt: "ok?" } },
              ],
              edges: [{ from: "verify", to: "check", condition: "success" }],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
      ],
    };
    const def = makeDef(optionalIr);
    const { nodes, edges } = irToFlow(def);
    const columns = columnsOf(def);

    // The optional-group renders via the registered group component (type
    // "optional-group", NOT react-flow__node-default) with parented children.
    const group = nodes.find((n) => n.id === "opt");
    expect(group?.type).toBe("optional-group");
    expect(group?.data.kind).toBe("optional-group");
    // The group node keeps defaultOn/name; the template is stripped onto children.
    expect(group?.data.config?.defaultOn).toBe(true);
    expect((group?.data.config as Record<string, unknown>)?.template).toBeUndefined();
    const children = nodes.filter((n) => n.parentId === "opt");
    expect(children.map((c) => templateNodeIdFromChild("opt", c.id)).sort()).toEqual(["check", "verify"]);

    const { ir: out } = flowToIr("optional", nodes, edges, columns);
    if (out.version !== "v2") throw new Error("expected v2");
    const opt = out.nodes.find((n) => n.id === "opt");
    expect(opt?.kind).toBe("optional-group");
    const cfg = opt?.config as Record<string, unknown>;
    expect(cfg.defaultOn).toBe(true);
    expect(cfg.name).toBe("Browser verification");
    const template = cfg.template as { nodes: { id: string }[]; edges: { from: string; to: string }[] };
    expect(template.nodes.map((n) => n.id)).toEqual(["verify", "check"]);
    expect(template.edges).toEqual([{ from: "verify", to: "check", condition: "success" }]);
    // Top-level edges exclude the intra-template ones.
    expect(out.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["start->opt", "opt->end"]);
  });

  it("marks optional-group template boundaries as visual-only child metadata", () => {
    const optionalIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "optional-boundaries",
      columns: ir.columns,
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        {
          id: "opt",
          kind: "optional-group",
          column: "in-progress",
          config: {
            defaultOn: true,
            template: {
              nodes: [
                { id: "prepare", kind: "prompt", config: { prompt: "prepare" } },
                { id: "approve", kind: "gate", config: { prompt: "approve?" } },
              ],
              edges: [{ from: "prepare", to: "approve", condition: "success" }],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(optionalIr));
    const byId = new Map(nodes.map((node) => [node.id, node] as const));
    expect(byId.get("opt::prepare")?.data.optionalGroupBoundary).toEqual({ entry: true, exit: false });
    expect(byId.get("opt::approve")?.data.optionalGroupBoundary).toEqual({ entry: false, exit: true });
    expect(edges.filter((edge) => edge.source === "opt::prepare" && edge.target === "opt::approve")).toHaveLength(1);

    const { ir: out } = flowToIr("optional-boundaries", nodes, edges, columnsOf(makeDef(optionalIr)));
    if (out.version !== "v2") throw new Error("expected v2");
    const opt = out.nodes.find((node) => node.id === "opt");
    const cfg = opt?.config as
      | { template?: { nodes: Array<{ config?: Record<string, unknown> }>; edges: unknown[] } }
      | undefined;
    expect(cfg?.template?.edges).toEqual([{ from: "prepare", to: "approve", condition: "success" }]);
    expect(cfg?.template?.nodes.map((node) => node.config?.optionalGroupBoundary)).toEqual([undefined, undefined]);
  });

  it("connects each independent optional-group boundary child with visual-only container edges", () => {
    const optionalIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "optional-independent-boundaries",
      columns: ir.columns,
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        {
          id: "opt",
          kind: "optional-group",
          column: "in-progress",
          config: {
            template: {
              nodes: [
                { id: "alpha", kind: "prompt", config: { prompt: "alpha" } },
                { id: "beta", kind: "prompt", config: { prompt: "beta" } },
              ],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(optionalIr));
    const byId = new Map(nodes.map((node) => [node.id, node] as const));
    expect(byId.get("opt::alpha")?.data.optionalGroupBoundary).toEqual({ entry: true, exit: true });
    expect(byId.get("opt::beta")?.data.optionalGroupBoundary).toEqual({ entry: true, exit: true });

    const visualBoundaryEdges = edges.filter((edge) => isVisualOnlyWorkflowEdge(edge));
    expect(visualBoundaryEdges.map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      "opt->opt::alpha",
      "opt->opt::beta",
      "opt::alpha->opt",
      "opt::beta->opt",
    ]);
    expect(visualBoundaryEdges.every((edge) => edge.selectable === false && edge.deletable === false)).toBe(true);

    const { ir: out } = flowToIr("optional-independent-boundaries", nodes, edges, columnsOf(makeDef(optionalIr)));
    const opt = out.nodes.find((node) => node.id === "opt");
    const cfg = opt?.config as { template?: { nodes?: Array<{ config?: Record<string, unknown> }>; edges?: unknown[] } } | undefined;
    expect(cfg?.template?.edges).toEqual([]);
    expect(cfg?.template?.nodes?.map((node) => node.config?.optionalGroupBoundary)).toEqual([undefined, undefined]);
    expect(out.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["start->opt", "opt->end"]);
  });

  it("recomputes optional-group visual boundaries after live template edge mutations", () => {
    const optionalIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "optional-live-boundaries",
      columns: ir.columns,
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        {
          id: "opt",
          kind: "optional-group",
          column: "in-progress",
          config: {
            template: {
              nodes: [
                { id: "alpha", kind: "prompt", config: { prompt: "alpha" } },
                { id: "beta", kind: "prompt", config: { prompt: "beta" } },
              ],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
      ],
    };

    const initial = irToFlow(makeDef(optionalIr));
    const realInternalEdge: FlowEdge = {
      id: "e-live-alpha-beta",
      source: "opt::alpha",
      target: "opt::beta",
      data: { condition: "success" },
      label: "success",
    };

    const connected = refreshTemplateContainerVisualBoundaries(initial.nodes, [...initial.edges, realInternalEdge]);
    const connectedById = new Map(connected.nodes.map((node) => [node.id, node] as const));
    expect(connectedById.get("opt::alpha")?.data.optionalGroupBoundary).toEqual({ entry: true, exit: false });
    expect(connectedById.get("opt::beta")?.data.optionalGroupBoundary).toEqual({ entry: false, exit: true });
    expect(connected.edges.filter((edge) => isVisualOnlyWorkflowEdge(edge)).map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      "opt->opt::alpha",
      "opt::beta->opt",
    ]);

    const disconnected = refreshTemplateContainerVisualBoundaries(
      connected.nodes,
      connected.edges.filter((edge) => edge.id !== realInternalEdge.id),
    );
    const disconnectedById = new Map(disconnected.nodes.map((node) => [node.id, node] as const));
    expect(disconnectedById.get("opt::alpha")?.data.optionalGroupBoundary).toEqual({ entry: true, exit: true });
    expect(disconnectedById.get("opt::beta")?.data.optionalGroupBoundary).toEqual({ entry: true, exit: true });
    expect(disconnected.edges.filter((edge) => isVisualOnlyWorkflowEdge(edge)).map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      "opt->opt::alpha",
      "opt->opt::beta",
      "opt::alpha->opt",
      "opt::beta->opt",
    ]);

    const { ir: out } = flowToIr("optional-live-boundaries", disconnected.nodes, disconnected.edges, columnsOf(makeDef(optionalIr)));
    const opt = out.nodes.find((node) => node.id === "opt");
    const cfg = opt?.config as { template?: { edges?: unknown[]; nodes?: Array<{ config?: Record<string, unknown> }> } } | undefined;
    expect(cfg?.template?.edges).toEqual([]);
    expect(cfg?.template?.nodes?.map((node) => node.config?.optionalGroupBoundary)).toEqual([undefined, undefined]);
  });

  it("derives optional-group boundaries from forward edges without letting rework cycles hide exits", () => {
    const optionalIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "optional-rework-boundaries",
      columns: ir.columns,
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        {
          id: "opt",
          kind: "optional-group",
          column: "in-progress",
          config: {
            template: {
              nodes: [
                { id: "exec", kind: "prompt", config: { prompt: "execute" } },
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
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(optionalIr));
    const byId = new Map(nodes.map((node) => [node.id, node] as const));
    expect(byId.get("opt::exec")?.data.optionalGroupBoundary).toEqual({ entry: true, exit: false });
    expect(byId.get("opt::review")?.data.optionalGroupBoundary).toEqual({ entry: false, exit: true });
    expect(edges.filter((edge) => edge.source === "opt::exec" && edge.target === "opt::review")).toHaveLength(1);
    expect(
      edges.filter((edge) => edge.source === "opt::review" && edge.target === "opt::exec" && edge.data?.kind === "rework"),
    ).toHaveLength(1);
    expect(
      edges.filter((edge) => isVisualOnlyWorkflowEdge(edge) && edge.source === "opt" && edge.target === "opt::exec"),
    ).toHaveLength(1);
    expect(
      edges.filter((edge) => isVisualOnlyWorkflowEdge(edge) && edge.source === "opt::review" && edge.target === "opt"),
    ).toHaveLength(1);
  });

  it("derives visual-only template boundary connectors across foreach, loop, and optional-group states", () => {
    const cases = [
      {
        name: "single child",
        nodes: [{ id: "only", kind: "prompt" as const, config: { prompt: "only" } }],
        edges: [] as NonNullable<WorkflowDefinition["ir"]["edges"]>,
        visual: ["box->box::only", "box::only->box"],
        boundaries: { only: { entry: true, exit: true } },
      },
      {
        name: "linear children",
        nodes: [
          { id: "alpha", kind: "prompt" as const, config: { prompt: "alpha" } },
          { id: "beta", kind: "gate" as const },
        ],
        edges: [{ from: "alpha", to: "beta", condition: "success" }],
        visual: ["box->box::alpha", "box::beta->box"],
        boundaries: { alpha: { entry: true, exit: false }, beta: { entry: false, exit: true } },
      },
      {
        name: "independent children",
        nodes: [
          { id: "alpha", kind: "prompt" as const, config: { prompt: "alpha" } },
          { id: "beta", kind: "prompt" as const, config: { prompt: "beta" } },
        ],
        edges: [] as NonNullable<WorkflowDefinition["ir"]["edges"]>,
        visual: ["box->box::alpha", "box->box::beta", "box::alpha->box", "box::beta->box"],
        boundaries: { alpha: { entry: true, exit: true }, beta: { entry: true, exit: true } },
      },
      {
        name: "empty template",
        nodes: [] as NonNullable<WorkflowDefinition["ir"]["nodes"]>,
        edges: [] as NonNullable<WorkflowDefinition["ir"]["edges"]>,
        visual: [] as string[],
        boundaries: {},
      },
      {
        name: "rework cycle ignored for boundaries",
        nodes: [
          { id: "alpha", kind: "prompt" as const, config: { prompt: "alpha" } },
          { id: "beta", kind: "step-review" as const, config: { type: "code" } },
        ],
        edges: [
          { from: "alpha", to: "beta", condition: "success" },
          { from: "beta", to: "alpha", condition: "outcome:revise", kind: "rework" as const },
        ],
        visual: ["box->box::alpha", "box::beta->box"],
        boundaries: { alpha: { entry: true, exit: false }, beta: { entry: false, exit: true } },
      },
    ];

    for (const containerKind of ["foreach", "loop", "optional-group"] as const) {
      for (const testCase of cases) {
        const template = { nodes: testCase.nodes, edges: testCase.edges };
        const config =
          containerKind === "foreach"
            ? { source: "task-steps" as const, template }
            : containerKind === "loop"
              ? { maxIterations: 2, template }
              : { defaultOn: true, template };
        const containerIr: WorkflowDefinition["ir"] = {
          version: "v2",
          name: `${containerKind}-${testCase.name}`,
          columns: ir.columns,
          nodes: [
            { id: "start", kind: "start", column: "plan" },
            { id: "box", kind: containerKind, column: "in-progress", config },
            { id: "end", kind: "end", column: "done" },
          ],
          edges: [
            { from: "start", to: "box", condition: "success" },
            { from: "box", to: "end", condition: "success" },
          ],
        };

        const { nodes, edges } = irToFlow(makeDef(containerIr));
        const byId = new Map(nodes.map((node) => [node.id, node] as const));
        for (const [childId, boundary] of Object.entries(testCase.boundaries)) {
          expect(byId.get(`box::${childId}`)?.data.templateBoundary, `${containerKind} ${testCase.name} ${childId}`).toEqual(boundary);
        }
        expect(edges.filter((edge) => isVisualOnlyWorkflowEdge(edge)).map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual(
          testCase.visual.sort(),
        );

        const { ir: out } = flowToIr(containerIr.name, nodes, edges, columnsOf(makeDef(containerIr)));
        if (out.version !== "v2") throw new Error("expected v2");
        expect(out.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(["start->box", "box->end"]);
        const outBox = out.nodes.find((node) => node.id === "box")!;
        const outTemplate = outBox.config?.template as { nodes?: Array<{ config?: Record<string, unknown> }>; edges?: unknown[] };
        expect(outTemplate.edges).toEqual(testCase.edges);
        expect(outTemplate.nodes?.map((node) => node.config?.templateBoundary)).toEqual(testCase.nodes.map(() => undefined));
      }
    }
  });

  it("connects built-in stepwise foreach steps to visual-only boundary guides", () => {
    const { nodes, edges } = irToFlow(makeDef(BUILTIN_STEPWISE_CODING_WORKFLOW_IR));
    const byId = new Map(nodes.map((node) => [node.id, node] as const));
    expect(byId.get("steps")?.type).toBe("foreach");
    expect(byId.get(foreachChildFlowId("steps", "step-execute"))?.data.templateBoundary).toEqual({ entry: true, exit: false });
    expect(byId.get(foreachChildFlowId("steps", "step-done"))?.data.templateBoundary).toEqual({ entry: false, exit: true });
    expect(edges.filter((edge) => isVisualOnlyWorkflowEdge(edge) && (edge.source === "steps" || edge.target === "steps"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "steps", sourceHandle: "template-boundary-entry", target: foreachChildFlowId("steps", "step-execute") }),
        expect.objectContaining({ source: foreachChildFlowId("steps", "step-done"), target: "steps", targetHandle: "template-boundary-exit" }),
      ]),
    );

    const { ir: out } = flowToIr("stepwise", nodes, edges, columnsOf(makeDef(BUILTIN_STEPWISE_CODING_WORKFLOW_IR)));
    if (out.version !== "v2") throw new Error("expected v2");
    expect(out.edges.some((edge) => edge.from === "steps" && edge.to.includes("step"))).toBe(false);
    const steps = out.nodes.find((node) => node.id === "steps")!;
    const template = steps.config?.template as { nodes?: Array<{ config?: Record<string, unknown> }>; edges?: Array<{ from: string; to: string }> };
    expect(template.nodes?.map((node) => node.config?.templateBoundary)).toEqual([undefined, undefined, undefined]);
    expect(template.edges?.some((edge) => edge.from === "steps" || edge.to === "steps")).toBe(false);
  });

  it("marks built-in Plan Review and Code Review single children as optional-group entry and exit boundaries", () => {
    for (const [workflowName, builtinIr] of [
      ["coding", BUILTIN_CODING_WORKFLOW_IR],
      ["stepwise coding", BUILTIN_STEPWISE_CODING_WORKFLOW_IR],
    ] as const) {
      const { nodes } = irToFlow(makeDef(builtinIr));
      const byId = new Map(nodes.map((node) => [node.id, node] as const));
      for (const [groupId, childId] of [
        ["plan-review", "plan-review-step"],
        ["code-review", "code-review-step"],
      ] as const) {
        expect(byId.get(groupId), `${workflowName} ${groupId} group`).toBeTruthy();
        expect(
          byId.get(`${groupId}::${childId}`)?.data.optionalGroupBoundary,
          `${workflowName} ${groupId} child`,
        ).toEqual({
          entry: true,
          exit: true,
        });
      }
    }
  });

  /*
   * FNXC:WorkflowContainerEdges 2026-06-26-07:30:
   * Browser Verification is an optional-group container on the built-in workflow path. The mapping invariant is broader than that repro: optional-group/foreach/loop containers must keep top-level edges attached to the container id, layer routed edges above the group background, render exactly one target/source handle pair, and use width-aware fallback positions so adjacent nodes do not occlude those handles.
   *
   * FNXC:WorkflowOptionalGroup 2026-06-29-20:41:
   * Plan Review and Code Review are single-node optional-group templates. The child node must be visibly connected to the optional block boundary through visual-only entry/exit connector edges, while save serialization keeps those fake boundary connectors out of the persisted IR.
   */
  it("keeps container edges and handles connected across built-in workflow containers", () => {
    const loopNode = {
      id: "diagnostic-loop",
      kind: "loop" as const,
      column: "in-progress",
      config: {
        maxIterations: 2,
        template: {
          nodes: [{ id: "loop-check", kind: "prompt" as const, config: { prompt: "Check once" } }],
          edges: [],
        },
      },
    };
    const codingWithLoop: WorkflowDefinition["ir"] = {
      ...BUILTIN_CODING_WORKFLOW_IR,
      name: "builtin-coding-with-loop-test",
      nodes: BUILTIN_CODING_WORKFLOW_IR.nodes.flatMap((node) =>
        node.id === "browser-verification" ? [loopNode, node] : [node],
      ),
      edges: [
        ...BUILTIN_CODING_WORKFLOW_IR.edges.filter(
          (edge) => !(edge.from === "execute" && edge.to === "browser-verification"),
        ),
        { from: "execute", to: "diagnostic-loop", condition: "success" },
        { from: "diagnostic-loop", to: "browser-verification", condition: "success" },
      ],
    };
    const stepwiseLoopNode = { ...loopNode, id: "post-steps-loop" };
    const stepwiseWithLoop: WorkflowDefinition["ir"] = {
      ...BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
      name: "builtin-stepwise-with-loop-test",
      nodes: BUILTIN_STEPWISE_CODING_WORKFLOW_IR.nodes.flatMap((node) =>
        node.id === "browser-verification" ? [stepwiseLoopNode, node] : [node],
      ),
      edges: [
        ...BUILTIN_STEPWISE_CODING_WORKFLOW_IR.edges.filter(
          (edge) => !(edge.from === "steps" && edge.to === "browser-verification"),
        ),
        { from: "steps", to: "post-steps-loop", condition: "success" },
        { from: "post-steps-loop", to: "browser-verification", condition: "success" },
      ],
    };

    const cases: Array<{
      name: string;
      ir: WorkflowDefinition["ir"];
      id: string;
      kind: "optional-group" | "foreach" | "loop";
    }> = [
      { name: "coding plan review", ir: BUILTIN_CODING_WORKFLOW_IR, id: "plan-review", kind: "optional-group" },
      { name: "coding browser verification", ir: BUILTIN_CODING_WORKFLOW_IR, id: "browser-verification", kind: "optional-group" },
      { name: "coding code review", ir: BUILTIN_CODING_WORKFLOW_IR, id: "code-review", kind: "optional-group" },
      { name: "stepwise plan review", ir: BUILTIN_STEPWISE_CODING_WORKFLOW_IR, id: "plan-review", kind: "optional-group" },
      { name: "stepwise browser verification", ir: BUILTIN_STEPWISE_CODING_WORKFLOW_IR, id: "browser-verification", kind: "optional-group" },
      { name: "stepwise code review", ir: BUILTIN_STEPWISE_CODING_WORKFLOW_IR, id: "code-review", kind: "optional-group" },
      { name: "stepwise foreach", ir: BUILTIN_STEPWISE_CODING_WORKFLOW_IR, id: "steps", kind: "foreach" },
      { name: "coding inserted loop", ir: codingWithLoop, id: "diagnostic-loop", kind: "loop" },
      { name: "stepwise inserted loop", ir: stepwiseWithLoop, id: "post-steps-loop", kind: "loop" },
    ];

    for (const testCase of cases) {
      const { nodes, edges } = irToFlow(makeDef(testCase.ir));
      const byId = new Map(nodes.map((node) => [node.id, node] as const));
      const group = byId.get(testCase.id);
      expect(group, testCase.name).toBeTruthy();
      expect(group?.type, testCase.name).toBe(testCase.kind);
      expect(group?.data.kind, testCase.name).toBe(testCase.kind);
      expect(group?.style?.width, testCase.name).toBe(FOREACH_GROUP_WIDTH);
      assertContainerHandles(testCase.kind, group!.data);

      const connectedTopLevelEdges = edges.filter(
        (edge) => !isVisualOnlyWorkflowEdge(edge) && (edge.source === testCase.id || edge.target === testCase.id),
      );
      expect(connectedTopLevelEdges.length, testCase.name).toBeGreaterThan(0);
      for (const edge of connectedTopLevelEdges) {
        expect(edge.source.includes("::"), `${testCase.name} source should be top-level`).toBe(false);
        expect(edge.target.includes("::"), `${testCase.name} target should be top-level`).toBe(false);
        expect(edge.zIndex, `${testCase.name} edge should layer above group`).toBeGreaterThan(group!.zIndex ?? 0);
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        expect(source, `${testCase.name} source node ${edge.source}`).toBeTruthy();
        expect(target, `${testCase.name} target node ${edge.target}`).toBeTruthy();
        if (source && target) {
          const sourceRight = source.position.x + nodeWidth(source);
          const targetRight = target.position.x + nodeWidth(target);
          if (source.position.x <= target.position.x) {
            expect(sourceRight, `${testCase.name} ${edge.source}->${edge.target} should not overlap`).toBeLessThanOrEqual(target.position.x);
          } else {
            expect(targetRight, `${testCase.name} ${edge.source}->${edge.target} should not overlap`).toBeLessThanOrEqual(source.position.x);
          }
        }
      }

      const templateEdges = edges.filter((edge) => !isVisualOnlyWorkflowEdge(edge) && (edge.source.includes("::") || edge.target.includes("::")));
      expect(templateEdges.some((edge) => edge.source === testCase.id || edge.target === testCase.id), testCase.name).toBe(false);
      const children = nodes.filter((node) => node.parentId === testCase.id);
      expect(children.every((node) => node.zIndex! > group!.zIndex!), testCase.name).toBe(true);
      if (testCase.kind === "optional-group") {
        const visualBoundaryEdges = edges.filter((edge) => isVisualOnlyWorkflowEdge(edge) && (edge.source === testCase.id || edge.target === testCase.id));
        expect(visualBoundaryEdges, testCase.name).toHaveLength(children.length > 0 ? 2 : 0);
        expect(visualBoundaryEdges.every((edge) => edge.selectable === false && edge.deletable === false), testCase.name).toBe(true);
        for (const edge of visualBoundaryEdges) {
          const source = byId.get(edge.source);
          const target = byId.get(edge.target);
          expect(source, `${testCase.name} visual source ${edge.source}`).toBeTruthy();
          expect(target, `${testCase.name} visual target ${edge.target}`).toBeTruthy();
          if (source!.data.kind === "optional-group") {
            assertContainerHandles("optional-group", source!.data);
          } else {
            assertRenderedHandles(source!.data.kind, source!.data, {
              target: source!.data.kind === "start" ? 0 : 1,
              source: source!.data.kind === "end" ? 0 : 1,
            });
          }
          if (target!.data.kind === "optional-group") {
            assertContainerHandles("optional-group", target!.data);
          } else {
            assertRenderedHandles(target!.data.kind, target!.data, {
              target: target!.data.kind === "start" ? 0 : 1,
              source: target!.data.kind === "end" ? 0 : 1,
            });
          }
        }
        const { ir: roundTripped } = flowToIr(testCase.ir.name, nodes, edges, columnsOf(makeDef(testCase.ir)));
        const persistedGroup = roundTripped.nodes.find((irNode) => irNode.id === testCase.id);
        const persistedTemplate = persistedGroup?.config?.template as { edges?: { from: string; to: string }[] } | undefined;
        expect(roundTripped.edges.some((edge) => edge.from.includes("::") || edge.to.includes("::")), testCase.name).toBe(false);
        expect(persistedTemplate?.edges?.some((edge) => edge.from === testCase.id || edge.to === testCase.id), testCase.name).toBe(false);
      }
    }

    assertRunDoesNotOverlap("coding consecutive fallback", irToFlow(makeDef(BUILTIN_CODING_WORKFLOW_IR)).nodes, [
      "execute",
      "browser-verification",
      "code-review",
      "review",
    ]);
    assertRunDoesNotOverlap("stepwise consecutive fallback", irToFlow(makeDef(BUILTIN_STEPWISE_CODING_WORKFLOW_IR)).nodes, [
      "steps",
      "browser-verification",
      "code-review",
      // FNXC:WorkflowReviewGates 2026-06-29-23:46: The stepwise built-in no longer has a separate final `review` seam; keep the optional-group overlap guard aligned with the post-code-review completion summary suffix while still proving adjacent optional containers do not visually collide.
      "completion-summary",
    ]);

    const consecutiveMixedContainers: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "mixed-containers",
      columns: BUILTIN_CODING_WORKFLOW_IR.columns,
      nodes: [
        { id: "start", kind: "start", column: "todo" },
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
    const mixedFlow = irToFlow(makeDef(consecutiveMixedContainers));
    assertRunDoesNotOverlap("mixed consecutive containers", mixedFlow.nodes, ["optional", "foreach", "loop", "end"]);

    const staleBuiltInLayout: WorkflowDefinition["layout"] = {
      start: { x: 60, y: 160 },
      execute: { x: 230, y: 160 },
      review: { x: 400, y: 160 },
      end: { x: 1420, y: 160 },
    };
    const { nodes: staleNodes, edges: staleEdges } = irToFlow(makeDef(BUILTIN_CODING_WORKFLOW_IR, staleBuiltInLayout));
    const staleById = new Map(staleNodes.map((node) => [node.id, node] as const));
    for (const edge of staleEdges.filter((candidate) => candidate.source === "browser-verification" || candidate.target === "browser-verification")) {
      const source = staleById.get(edge.source)!;
      const target = staleById.get(edge.target)!;
      const sourceRight = source.position.x + nodeWidth(source);
      const targetRight = target.position.x + nodeWidth(target);
      if (source.position.x <= target.position.x) {
        expect(sourceRight, `stale layout ${edge.source}->${edge.target} should not overlap`).toBeLessThanOrEqual(target.position.x);
      } else {
        expect(targetRight, `stale layout ${edge.source}->${edge.target} should not overlap`).toBeLessThanOrEqual(source.position.x);
      }
    }

    const completeButStaleLayout = Object.fromEntries(
      BUILTIN_CODING_WORKFLOW_IR.nodes.map((node, index) => [node.id, { x: 60 + index * 170, y: 160 }]),
    );
    const { nodes: completeStaleNodes } = irToFlow(makeDef(BUILTIN_CODING_WORKFLOW_IR, completeButStaleLayout));
    const completeStaleById = new Map(completeStaleNodes.map((node) => [node.id, node] as const));
    expect(completeStaleById.get("browser-verification")?.position.x).not.toBe(completeButStaleLayout["browser-verification"].x);
    assertRunDoesNotOverlap("complete stale coding layout", completeStaleNodes, [
      "execute",
      "browser-verification",
      "code-review",
      "review",
    ], WF_FALLBACK_NODE_GAP);

    const compactManualIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "compact-manual-containers",
      columns: BUILTIN_CODING_WORKFLOW_IR.columns,
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "optional", kind: "optional-group", column: "in-progress", config: { template: { nodes: [], edges: [] } } },
        { id: "review", kind: "prompt", column: "in-progress", config: { prompt: "review" } },
        { id: "vertical", kind: "optional-group", column: "in-progress", config: { template: { nodes: [], edges: [] } } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "optional", condition: "success" },
        { from: "optional", to: "review", condition: "success" },
        { from: "review", to: "vertical", condition: "success" },
        { from: "vertical", to: "end", condition: "success" },
      ],
    };
    const compactManualLayout: WorkflowDefinition["layout"] = {
      start: { x: 40, y: 160 },
      optional: { x: 280, y: 160 },
      review: { x: 850, y: 160 },
      vertical: { x: 850, y: 460 },
      end: { x: 1420, y: 460 },
    };
    const { nodes: compactManualNodes } = irToFlow(makeDef(compactManualIr, compactManualLayout));
    const compactManualById = new Map(compactManualNodes.map((node) => [node.id, node] as const));
    expect(compactManualById.get("optional")?.position).toEqual(compactManualLayout.optional);
    expect(compactManualById.get("review")?.position).toEqual(compactManualLayout.review);
    expect(compactManualById.get("vertical")?.position).toEqual(compactManualLayout.vertical);
  });

  // FNXC:WorkflowOptionalGroup 2026-06-21-11:30: Deleting an optional-group must
  // cascade its parentId children (no orphans) — same rule foreach/loop follow.
  it("cascade-deletes an optional-group's template children", () => {
    const optionalIr: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "optional-del",
      columns: ir.columns,
      nodes: [
        { id: "start", kind: "start", column: "plan" },
        {
          id: "opt",
          kind: "optional-group",
          column: "in-progress",
          config: {
            defaultOn: false,
            template: {
              nodes: [{ id: "verify", kind: "prompt", config: { prompt: "verify" } }],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
      ],
    };
    const { nodes, edges } = irToFlow(makeDef(optionalIr));
    expect(nodes.some((n) => n.parentId === "opt")).toBe(true);
    const result = cascadeDelete(nodes, edges, ["opt"]);
    expect(result.nodes.some((n) => n.id === "opt")).toBe(false);
    expect(result.nodes.some((n) => n.parentId === "opt")).toBe(false);
  });

  it("inserts loop fragments with their template children intact", () => {
    const fragment: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "fragment",
      columns: ir.columns,
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "retry",
          kind: "loop",
          config: {
            maxIterations: 2,
            exitWhen: { type: "output-contains", value: "DONE" },
            template: {
              nodes: [{ id: "try", kind: "prompt", config: { prompt: "again" } }],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "retry" },
        { from: "retry", to: "end" },
      ],
    };
    const inserted = insertFragment([], [], parseWorkflowIr(fragment), { x: 10, y: 20 }, {
      [foreachChildFlowId("retry", "try")]: { x: 86, y: 132 },
    });
    const group = inserted.nodes.find((n) => n.data.kind === "loop");
    const child = inserted.nodes.find((n) => n.parentId === group?.id);

    expect(group).toBeTruthy();
    expect(group?.type).toBe("loop");
    expect(child?.position).toEqual({ x: 86, y: 132 });
    expect(inserted.nodes.filter((n) => n.parentId === group?.id)).toHaveLength(1);
    expect(inserted.edges.filter((edge) => !isVisualOnlyWorkflowEdge(edge))).toHaveLength(0);
    expect(inserted.edges.filter((edge) => isVisualOnlyWorkflowEdge(edge)).map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      `${group?.id}->${child?.id}`,
      `${child?.id}->${group?.id}`,
    ]);
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

describe("card dimension constants (U1)", () => {
  it("card max width is at least the nominal card width", () => {
    expect(WF_CARD_MAX_WIDTH).toBeGreaterThanOrEqual(WF_CARD_WIDTH);
  });

  it("a child card fits inside the foreach group with padding", () => {
    // Child offset + card max dimensions must stay inside the group box so a
    // card never overflows or gets clamped by extent:"parent".
    expect(FOREACH_CHILD_X + WF_CARD_MAX_WIDTH).toBeLessThanOrEqual(FOREACH_GROUP_WIDTH);
    expect(FOREACH_CHILD_Y + WF_CARD_HEIGHT).toBeLessThanOrEqual(FOREACH_GROUP_HEIGHT);
  });
});

describe("edge-condition authoring (U2)", () => {
  it("round-trips a failure condition through flowToIr → irToFlow with class + label", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { prompt: "do" } },
        { id: "ok", kind: "prompt", config: { prompt: "ok" } },
        { id: "bad", kind: "prompt", config: { prompt: "bad" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1", condition: "success" },
        { from: "n1", to: "ok", condition: "success" },
        { from: "n1", to: "bad", condition: "failure" },
        { from: "ok", to: "end", condition: "success" },
        { from: "bad", to: "end", condition: "success" },
      ],
    };
    const { nodes, edges } = irToFlow(makeDef(ir));
    const failFlow = edges.find((e) => e.source === "n1" && e.target === "bad")!;
    expect(failFlow.data?.condition).toBe("failure");
    expect(failFlow.label).toBe("failure");
    expect(failFlow.className).toBe("wf-edge-failure");

    const { ir: out } = flowToIr("wf", nodes, edges);
    const irFail = out.edges.find((e) => e.from === "n1" && e.to === "bad");
    expect(irFail?.condition).toBe("failure");
  });

  it("preserves parallel success+failure edges between the same pair through the round-trip", () => {
    const flowNodes: FlowNode<WorkflowFlowNodeData>[] = [
      { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { kind: "prompt", label: "a" } },
      { id: "b", type: "prompt", position: { x: 100, y: 0 }, data: { kind: "prompt", label: "b" } },
    ];
    const flowEdges = [
      { id: "e-1", source: "a", target: "b", data: { condition: "success" } },
      { id: "e-2", source: "a", target: "b", data: { condition: "failure" } },
    ];
    const { ir } = flowToIr("wf", flowNodes, flowEdges);
    expect(ir.edges).toHaveLength(2);
    expect(ir.edges.map((e) => e.condition).sort()).toEqual(["failure", "success"]);

    const { edges: reFlow } = irToFlow(makeDef(ir));
    expect(reFlow).toHaveLength(2);
    const ids = new Set(reFlow.map((e) => e.id));
    expect(ids.size).toBe(2);
  });

  it("edgeClassName: failure → wf-edge-failure, rework precedence, success → undefined", () => {
    expect(edgeClassName("failure", false)).toBe("wf-edge-failure");
    expect(edgeClassName("success", false)).toBeUndefined();
    expect(edgeClassName("failure", true)).toBe("wf-edge-rework");
  });

  it("edgeConditionEditability gates by source kind (KTD-2)", () => {
    expect(edgeConditionEditability("step-review")).toBe("verdicts");
    expect(edgeConditionEditability("prompt")).toBe("conditions");
    expect(edgeConditionEditability("script")).toBe("conditions");
    expect(edgeConditionEditability("gate")).toBe("conditions");
    expect(edgeConditionEditability("code")).toBe("conditions");
    expect(edgeConditionEditability("foreach")).toBe("conditions");
    expect(edgeConditionEditability("split")).toBe("readonly");
    expect(edgeConditionEditability("parse-steps")).toBe("readonly");
    expect(edgeConditionEditability("start")).toBe("readonly");
    expect(edgeConditionEditability(undefined)).toBe("readonly");
  });

  it("wouldCreateCycle detects back-edges and ignores forward + rework edges", () => {
    const chain = [
      { id: "1", source: "a", target: "b", data: { condition: "success" } },
      { id: "2", source: "b", target: "c", data: { condition: "success" } },
    ];
    // c → a closes the loop a→b→c→a.
    expect(wouldCreateCycle(chain, "c", "a")).toBe(true);
    // a → c is forward, no cycle.
    expect(wouldCreateCycle(chain, "a", "c")).toBe(false);
    // self-loop.
    expect(wouldCreateCycle(chain, "a", "a")).toBe(true);

    // rework edges are excluded from the reachability walk.
    const withRework = [
      { id: "1", source: "a", target: "b", data: { condition: "success" } },
      { id: "2", source: "b", target: "c", data: { condition: "success", kind: "rework" } },
    ];
    // c only reachable from b via a rework edge, so c→a is NOT a (non-rework) cycle.
    expect(wouldCreateCycle(withRework, "c", "a")).toBe(false);
  });

  it("buildConnectionEdge: builds a success edge, rejects missing endpoints, duplicates, cycles", () => {
    const nodes: FlowNode<WorkflowFlowNodeData>[] = [
      { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { kind: "prompt", label: "a" } },
      { id: "b", type: "prompt", position: { x: 100, y: 0 }, data: { kind: "prompt", label: "b" } },
      { id: "c", type: "prompt", position: { x: 200, y: 0 }, data: { kind: "prompt", label: "c" } },
    ];
    const edges = [
      { id: "1", source: "a", target: "b", data: { condition: "success" } },
      { id: "2", source: "b", target: "c", data: { condition: "success" } },
    ];

    // happy path: new success edge with a unique id + interactionWidth.
    const ok = buildConnectionEdge({ source: "a", target: "c" }, edges, nodes);
    expect("edge" in ok).toBe(true);
    if ("edge" in ok) {
      expect(ok.edge.data?.condition).toBe("success");
      expect(ok.edge.label).toBe("success");
      expect(ok.edge.interactionWidth).toBeGreaterThan(0);
      expect(typeof ok.edge.id).toBe("string");
    }

    // missing endpoint.
    expect(buildConnectionEdge({ source: "a", target: null }, edges, nodes)).toEqual({
      error: "missing-endpoint",
    });

    // visual-only optional-group boundary handles are reserved for generated guide edges.
    expect(buildConnectionEdge({ source: "a", sourceHandle: "template-boundary-entry", target: "b" }, edges, nodes)).toEqual({
      error: "reserved-handle",
    });
    expect(buildConnectionEdge({ source: "a", target: "b", targetHandle: "template-boundary-exit" }, edges, nodes)).toEqual({
      error: "reserved-handle",
    });

    // second connect of an existing success pair (prompt source supports
    // conditions) → births the parallel failure edge rather than rejecting.
    const failureBirth = buildConnectionEdge({ source: "a", target: "b" }, edges, nodes);
    expect("edge" in failureBirth).toBe(true);
    if ("edge" in failureBirth) {
      expect(failureBirth.edge.data?.condition).toBe("failure");
    }

    // once BOTH success and failure exist, a third connect is a duplicate.
    const bothConditions = [
      ...edges,
      { id: "3", source: "a", target: "b", data: { condition: "failure" } },
    ];
    expect(buildConnectionEdge({ source: "a", target: "b" }, bothConditions, nodes)).toEqual({
      error: "duplicate",
    });

    // a source kind that does NOT support conditions stays a hard duplicate.
    const readonlyNodes: FlowNode<WorkflowFlowNodeData>[] = [
      { id: "a", type: "start", position: { x: 0, y: 0 }, data: { kind: "start", label: "a" } },
      { id: "b", type: "prompt", position: { x: 100, y: 0 }, data: { kind: "prompt", label: "b" } },
    ];
    expect(
      buildConnectionEdge(
        { source: "a", target: "b" },
        [{ id: "1", source: "a", target: "b", data: { condition: "success" } }],
        readonlyNodes,
      ),
    ).toEqual({ error: "duplicate" });

    // cycle: c→a closes a→b→c→a.
    expect(buildConnectionEdge({ source: "c", target: "a" }, edges, nodes)).toEqual({
      error: "cycle",
    });
  });

  it("buildConnectionEdge exempts intra-foreach-template connections from the cycle guard", () => {
    const nodes: FlowNode<WorkflowFlowNodeData>[] = [
      { id: "g", type: "foreach", position: { x: 0, y: 0 }, data: { kind: "foreach", label: "g" } },
      { id: "g::a", type: "prompt", position: { x: 0, y: 0 }, parentId: "g", data: { kind: "prompt", label: "a" } },
      { id: "g::b", type: "prompt", position: { x: 0, y: 0 }, parentId: "g", data: { kind: "prompt", label: "b" } },
    ];
    const edges = [{ id: "1", source: "g::a", target: "g::b", data: { condition: "success" } }];
    // b→a would be a cycle, but both are children of the same group → allowed.
    const res = buildConnectionEdge({ source: "g::b", target: "g::a" }, edges, nodes);
    expect("edge" in res).toBe(true);
  });
});

describe("cascadeDelete (U3, R6)", () => {
  // start → a → b → c → end (a/b/c are prompt nodes), so deleting a mid-chain
  // node must drop its two incident edges with no bridge created.
  const chainDef = (): WorkflowDefinition =>
    makeDef({
      version: "v1",
      name: "chain",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt", config: { prompt: "a" } },
        { id: "b", kind: "prompt", config: { prompt: "b" } },
        { id: "c", kind: "prompt", config: { prompt: "c" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a", condition: "success" },
        { from: "a", to: "b", condition: "success" },
        { from: "b", to: "c", condition: "success" },
        { from: "c", to: "end", condition: "success" },
      ],
    });

  it("deletes a mid-chain node + both incident edges, with NO bridge edge", () => {
    const { nodes, edges } = irToFlow(chainDef());
    const bEdge = edges.find((e) => e.source === "a" && e.target === "b")!;
    const result = cascadeDelete(nodes, edges, [/* node */ "b"]);
    expect(result.nodes.find((n) => n.id === "b")).toBeUndefined();
    // Both incident edges (a→b and b→c) are gone.
    expect(result.edges.find((e) => e.source === "a" && e.target === "b")).toBeUndefined();
    expect(result.edges.find((e) => e.source === "b" && e.target === "c")).toBeUndefined();
    // No auto-bridge a→c.
    expect(result.edges.find((e) => e.source === "a" && e.target === "c")).toBeUndefined();
    // Untouched edges survive.
    expect(result.edges.find((e) => e.source === "start" && e.target === "a")).toBeTruthy();
    expect(result.edges.find((e) => e.source === "c" && e.target === "end")).toBeTruthy();
    void bEdge;
  });

  // A foreach group with two template children (exec → review, review → exec
  // rework), plus top-level edges parse→loop→end.
  const foreachDef = (): WorkflowDefinition =>
    makeDef({
      version: "v1",
      name: "loopwf",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "loop",
          kind: "foreach",
          config: {
            source: "task-steps",
            template: {
              nodes: [
                { id: "exec", kind: "prompt", config: { seam: "step-execute", prompt: "do" } },
                { id: "review", kind: "step-review", config: { type: "code" } },
              ],
              edges: [
                { from: "exec", to: "review", condition: "success" },
                { from: "review", to: "exec", condition: "outcome:revise", kind: "rework" },
              ],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "loop", condition: "success" },
        { from: "loop", to: "end", condition: "success" },
      ],
    });

  it("deleting a foreach group removes the group + children + template edges + incident edges", () => {
    const { nodes, edges } = irToFlow(foreachDef());
    const execId = foreachChildFlowId("loop", "exec");
    const reviewId = foreachChildFlowId("loop", "review");
    // Sanity: children + their template edges exist before delete.
    expect(nodes.find((n) => n.id === execId)).toBeTruthy();
    expect(edges.some((e) => e.source === execId && e.target === reviewId)).toBe(true);

    const result = cascadeDelete(nodes, edges, ["loop"]);
    // Group + both children gone.
    expect(result.nodes.find((n) => n.id === "loop")).toBeUndefined();
    expect(result.nodes.find((n) => n.id === execId)).toBeUndefined();
    expect(result.nodes.find((n) => n.id === reviewId)).toBeUndefined();
    // Intra-template edges gone.
    expect(result.edges.some((e) => e.source === execId || e.target === execId)).toBe(false);
    expect(result.edges.some((e) => e.source === reviewId || e.target === reviewId)).toBe(false);
    // The group's own incident edges (start→loop, loop→end) gone.
    expect(result.edges.some((e) => e.source === "loop" || e.target === "loop")).toBe(false);
    // start and end nodes survive.
    expect(result.nodes.find((n) => n.id === "start")).toBeTruthy();
    expect(result.nodes.find((n) => n.id === "end")).toBeTruthy();
  });

  it("deleting only a template child removes the child + its edges, leaving the group", () => {
    const { nodes, edges } = irToFlow(foreachDef());
    const execId = foreachChildFlowId("loop", "exec");
    const reviewId = foreachChildFlowId("loop", "review");

    const result = cascadeDelete(nodes, edges, [execId]);
    // The exec child is gone; the group + sibling remain.
    expect(result.nodes.find((n) => n.id === execId)).toBeUndefined();
    expect(result.nodes.find((n) => n.id === "loop")).toBeTruthy();
    expect(result.nodes.find((n) => n.id === reviewId)).toBeTruthy();
    // Edges touching exec (both directions) are gone.
    expect(result.edges.some((e) => e.source === execId || e.target === execId)).toBe(false);
  });

  it("never deletes start/end nodes (and preserves their edges)", () => {
    const { nodes, edges } = irToFlow(chainDef());
    const result = cascadeDelete(nodes, edges, ["start", "end"]);
    expect(result.nodes.find((n) => n.id === "start")).toBeTruthy();
    expect(result.nodes.find((n) => n.id === "end")).toBeTruthy();
    // Their incident edges survive too (start→a, c→end).
    expect(result.edges.some((e) => e.source === "start")).toBe(true);
    expect(result.edges.some((e) => e.target === "end")).toBe(true);
    // Nothing was removed at all.
    expect(result.nodes).toHaveLength(nodes.length);
    expect(result.edges).toHaveLength(edges.length);
  });

  it("never deletes column band nodes", () => {
    const v2: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "wf",
      columns: [{ id: "col1", name: "Col 1", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "col1" },
        { id: "end", kind: "end", column: "col1" },
      ],
      edges: [{ from: "start", to: "end", condition: "success" }],
    };
    const { nodes, edges } = irToFlow(makeDef(v2));
    const bandId = nodes.find((n) => isColumnBandNode(n.id))!.id;
    const result = cascadeDelete(nodes, edges, [bandId]);
    expect(result.nodes.find((n) => n.id === bandId)).toBeTruthy();
  });

  it("deletes an edge id directly, removing just that edge", () => {
    const { nodes, edges } = irToFlow(chainDef());
    const target = edges.find((e) => e.source === "b" && e.target === "c")!;
    const result = cascadeDelete(nodes, edges, [target.id]);
    expect(result.edges.find((e) => e.id === target.id)).toBeUndefined();
    // No nodes removed, all other edges intact.
    expect(result.nodes).toHaveLength(nodes.length);
    expect(result.edges).toHaveLength(edges.length - 1);
  });
});

// ── Fragment insertion + graph copy (U8, R7/R8) ──────────────────────────────

/** start → a → b → c → end (top-level scope, reused by the U8 suites). */
const u8ChainDef = (): WorkflowDefinition =>
  makeDef({
    version: "v1",
    name: "chain",
    nodes: [
      { id: "start", kind: "start" },
      { id: "a", kind: "prompt", config: { prompt: "a" } },
      { id: "b", kind: "prompt", config: { prompt: "b" } },
      { id: "c", kind: "prompt", config: { prompt: "c" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "a", condition: "success" },
      { from: "a", to: "b", condition: "success" },
      { from: "b", to: "c", condition: "success" },
      { from: "c", to: "end", condition: "success" },
    ],
  });

/** A small fragment IR: start → a → b → end, b carries a merge seam + name. */
function fragmentIr(): WorkflowDefinition["ir"] {
  return {
    version: "v1",
    name: "frag",
    nodes: [
      { id: "start", kind: "start" },
      { id: "a", kind: "prompt", config: { prompt: "do a", name: "Step A" } },
      { id: "b", kind: "prompt", config: { seam: "merge", name: "Merge" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "a", condition: "success" },
      { from: "a", to: "b", condition: "failure" },
      { from: "b", to: "end", condition: "success" },
    ],
  };
}

describe("insertFragment", () => {
  it("strips start/end, remaps every node id, preserves internal edges/config/conditions", () => {
    const existing = irToFlow(u8ChainDef());
    const before = new Set(existing.nodes.map((n) => n.id));
    const { nodes, edges, insertedNodeIds } = insertFragment(
      existing.nodes,
      existing.edges,
      fragmentIr(),
      { x: 500, y: 200 },
    );

    // Two body nodes inserted (start/end stripped).
    expect(insertedNodeIds).toHaveLength(2);
    expect(nodes).toHaveLength(existing.nodes.length + 2);

    // Inserted ids are fresh (disjoint from existing) and not the fragment's.
    for (const id of insertedNodeIds) {
      expect(before.has(id)).toBe(false);
      expect(["start", "a", "b", "end"]).not.toContain(id);
    }

    const inserted = nodes.filter((n) => insertedNodeIds.includes(n.id));
    // No start/end among inserted nodes.
    expect(inserted.some((n) => n.data.kind === "start" || n.data.kind === "end")).toBe(false);
    // Config preserved: the merge node keeps its seam; the prompt keeps its prompt.
    const merge = inserted.find((n) => n.data.kind === "merge")!;
    expect(merge.data.config?.seam).toBe("merge");
    const promptNode = inserted.find((n) => n.data.config?.prompt === "do a")!;
    expect(promptNode).toBeTruthy();

    // Only the single internal a→b edge survives (start→a, b→end stripped).
    const newEdges = edges.slice(existing.edges.length);
    expect(newEdges).toHaveLength(1);
    const e = newEdges[0];
    expect(insertedNodeIds).toContain(e.source);
    expect(insertedNodeIds).toContain(e.target);
    // Edge condition preserved.
    expect(e.data?.condition).toBe("failure");

    // Inputs not mutated.
    expect(existing.nodes).toHaveLength(before.size);
  });

  it("positions inserted nodes near the requested position", () => {
    const existing = irToFlow(u8ChainDef());
    const { nodes, insertedNodeIds } = insertFragment(
      existing.nodes,
      existing.edges,
      fragmentIr(),
      { x: 500, y: 200 },
    );
    const inserted = nodes.filter((n) => insertedNodeIds.includes(n.id));
    for (const n of inserted) {
      expect(n.position.x).toBeGreaterThanOrEqual(500);
      expect(n.position.y).toBeGreaterThanOrEqual(200);
      expect(n.position.y).toBeLessThan(500);
    }
  });

  it("double-insert of the same fragment yields two disjoint id sets", () => {
    const existing = irToFlow(u8ChainDef());
    const first = insertFragment(existing.nodes, existing.edges, fragmentIr(), { x: 500, y: 200 });
    const second = insertFragment(first.nodes, first.edges, fragmentIr(), { x: 800, y: 200 });
    const setA = new Set(first.insertedNodeIds);
    for (const id of second.insertedNodeIds) expect(setA.has(id)).toBe(false);
    // All ids across the graph are unique.
    const allIds = second.nodes.map((n) => n.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("expands a foreach fragment's template so flowToIr round-trips the full template", () => {
    // Fragment: start → loop(foreach with a 2-node template) → end.
    const foreachFragment: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "frag",
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "loop",
          kind: "foreach",
          config: {
            source: "task-steps",
            template: {
              nodes: [
                { id: "t1", kind: "prompt", config: { prompt: "inner1" } },
                { id: "t2", kind: "prompt", config: { prompt: "inner2" } },
              ],
              edges: [{ from: "t1", to: "t2", condition: "success" }],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "loop", condition: "success" },
        { from: "loop", to: "end", condition: "success" },
      ],
    };

    const existing = irToFlow(u8ChainDef());
    const { nodes, edges, insertedNodeIds } = insertFragment(
      existing.nodes,
      existing.edges,
      foreachFragment,
      { x: 400, y: 200 },
    );

    // The foreach group's template children were expanded as parented nodes.
    const groupId = insertedNodeIds[0];
    const children = nodes.filter((n) => n.parentId === groupId);
    expect(children).toHaveLength(2);

    // Round-trip the live canvas back to IR — the inserted foreach must carry its
    // full template (not an empty one) with both inner nodes and the inner edge.
    const { ir: out } = flowToIr("wf", nodes, edges);
    const loop = out.nodes.find((n) => n.kind === "foreach")!;
    expect(loop).toBeTruthy();
    const template = (loop.config as { template?: { nodes: unknown[]; edges: unknown[] } })
      .template;
    expect(template?.nodes).toHaveLength(2);
    expect(template?.edges).toHaveLength(1);
  });

  // FNXC:WorkflowOptionalGroup 2026-06-21-14:55: optionalGroupFragmentIr wraps a
  // projected add-on node in an optional-group; insertFragment must expand its
  // template child and round-trip it via flowToIr, and two inserts must not collide.
  it("wraps an add-on node in an optional-group fragment that round-trips with defaultOn", () => {
    const fragmentIr = optionalGroupFragmentIr(
      { kind: "prompt", config: { name: "Security Audit", prompt: "audit it" } },
      { name: "Security Audit", defaultOn: true },
    );

    const existing = irToFlow(u8ChainDef());
    const first = insertFragment(existing.nodes, existing.edges, fragmentIr, { x: 400, y: 200 });
    const second = insertFragment(first.nodes, first.edges, fragmentIr, { x: 700, y: 200 });

    // Two optional-group containers, each with its template child expanded and its
    // visual-only boundary wiring present immediately on insertion (before save/reload).
    const groups = second.nodes.filter((n) => n.data.kind === "optional-group");
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      const child = second.nodes.find((n) => n.parentId === g.id);
      expect(child).toBeTruthy();
      expect(child?.data.optionalGroupBoundary).toEqual({ entry: true, exit: true });
      expect(
        second.edges.some(
          (edge) => isVisualOnlyWorkflowEdge(edge) && edge.source === g.id && edge.target === child?.id,
        ),
      ).toBe(true);
      expect(
        second.edges.some(
          (edge) => isVisualOnlyWorkflowEdge(edge) && edge.source === child?.id && edge.target === g.id,
        ),
      ).toBe(true);
    }
    // All ids disjoint across both inserts.
    const allIds = second.nodes.map((n) => n.id);
    expect(new Set(allIds).size).toBe(allIds.length);

    // Round-trip: BOTH inserted groups carry defaultOn + a single-node template,
    // so a regression that breaks the second insert can't pass on the first.
    const { ir: out } = flowToIr("wf", second.nodes, second.edges);
    // An optional-group is a v2-only kind: its presence forces v2 serialization
    // even with no columns/fields/settings, or it would serialize as v1 and fail
    // parse. (Code review: CodeRabbit.)
    expect(out.version).toBe("v2");
    const ogs = out.nodes.filter((n) => n.kind === "optional-group");
    expect(ogs).toHaveLength(2);
    for (const og of ogs) {
      expect(og.config?.defaultOn).toBe(true);
      const template = (og.config as { template?: { nodes: { config?: Record<string, unknown> }[]; edges?: unknown[] } }).template;
      expect(template?.nodes).toHaveLength(1);
      expect(template?.nodes[0].config?.name).toBe("Security Audit");
      expect(template?.nodes[0].config?.optionalGroupBoundary).toBeUndefined();
      expect(template?.edges).toEqual([]);
    }
  });

  it("expands inserted multi-node optional groups with boundary metadata without dropping internal edges", () => {
    const fragment: WorkflowDefinition["ir"] = {
      version: "v2",
      name: "insert optional chain",
      columns: [],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "opt",
          kind: "optional-group",
          config: {
            template: {
              nodes: [
                { id: "prepare", kind: "prompt", config: { prompt: "prepare" } },
                { id: "approve", kind: "gate", config: { prompt: "approve" } },
              ],
              edges: [{ from: "prepare", to: "approve", condition: "success" }],
            },
          },
        },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "opt", condition: "success" },
        { from: "opt", to: "end", condition: "success" },
      ],
    };

    const inserted = insertFragment([], [], fragment, { x: 100, y: 200 });
    const group = inserted.nodes.find((node) => node.data.kind === "optional-group")!;
    const prepare = inserted.nodes.find((node) => node.parentId === group.id && node.id.endsWith("::prepare"))!;
    const approve = inserted.nodes.find((node) => node.parentId === group.id && node.id.endsWith("::approve"))!;

    expect(prepare.data.optionalGroupBoundary).toEqual({ entry: true, exit: false });
    expect(approve.data.optionalGroupBoundary).toEqual({ entry: false, exit: true });
    expect(inserted.edges.some((edge) => edge.source === prepare.id && edge.target === approve.id)).toBe(true);
    expect(inserted.edges.filter((edge) => isVisualOnlyWorkflowEdge(edge)).map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      `${group.id}->${prepare.id}`,
      `${approve.id}->${group.id}`,
    ]);

    const { ir: out } = flowToIr("insert optional chain", inserted.nodes, inserted.edges);
    const opt = out.nodes.find((node) => node.kind === "optional-group")!;
    const template = (opt.config as { template?: { nodes?: Array<{ config?: Record<string, unknown> }>; edges?: unknown[] } }).template;
    expect(template?.nodes?.map((node) => node.config?.optionalGroupBoundary)).toEqual([undefined, undefined]);
    expect(template?.edges).toEqual([{ from: "prepare", to: "approve", condition: "success" }]);
    expect(out.edges).toEqual([]);
  });
});

describe("fragmentSeamConflicts", () => {
  it("flags a merge seam present in both fragment and canvas", () => {
    // Canvas containing a merge node.
    const canvas = irToFlow(
      makeDef({
        version: "v1",
        name: "wf",
        nodes: [
          { id: "start", kind: "start" },
          { id: "m", kind: "prompt", config: { seam: "merge" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "m", condition: "success" },
          { from: "m", to: "end", condition: "success" },
        ],
      }),
    );
    expect(fragmentSeamConflicts(fragmentIr(), canvas.nodes)).toEqual(["merge"]);
  });

  it("returns [] when the canvas has no overlapping seam", () => {
    const canvas = irToFlow(u8ChainDef());
    expect(fragmentSeamConflicts(fragmentIr(), canvas.nodes)).toEqual([]);
  });

  it("treats the editor 'merge' node kind as the merge seam on the canvas", () => {
    // Canvas node has no config.seam but is rendered as a merge node.
    const canvas: FlowNode<WorkflowFlowNodeData>[] = [
      {
        id: "x",
        type: "merge",
        position: { x: 0, y: 0 },
        data: { kind: "merge", label: "Merge boundary" },
      },
    ];
    expect(fragmentSeamConflicts(fragmentIr(), canvas)).toEqual(["merge"]);
  });
});

describe("copyIrWithFreshIds", () => {
  function v2WithForeach(): WorkflowDefinition["ir"] {
    return {
      version: "v2",
      name: "wf",
      columns: [{ id: "in-progress", name: "In Progress", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "in-progress" },
        {
          id: "loop",
          kind: "foreach",
          column: "in-progress",
          config: {
            source: "task-steps",
            template: {
              nodes: [
                { id: "t1", kind: "prompt", config: { prompt: "inner" } },
                { id: "t2", kind: "prompt", config: { prompt: "inner2" } },
              ],
              edges: [{ from: "t1", to: "t2", condition: "success" }],
            },
          },
        },
        { id: "end", kind: "end", column: "in-progress" },
      ],
      edges: [
        { from: "start", to: "loop", condition: "success" },
        { from: "loop", to: "end", condition: "success" },
      ],
    };
  }

  it("preserves structure but remaps all node ids; layout keys remapped consistently", () => {
    const ir = u8ChainDef().ir;
    const layout = { start: { x: 0, y: 0 }, a: { x: 100, y: 0 }, b: { x: 200, y: 0 }, c: { x: 300, y: 0 }, end: { x: 400, y: 0 } };
    const result = copyIrWithFreshIds(ir, layout);

    // Same counts + kinds.
    expect(result.ir.nodes).toHaveLength(ir.nodes.length);
    expect(result.ir.edges).toHaveLength(ir.edges.length);
    expect(result.ir.nodes.map((n) => n.kind)).toEqual(ir.nodes.map((n) => n.kind));

    // All new ids, disjoint from originals.
    const origIds = new Set(ir.nodes.map((n) => n.id));
    for (const n of result.ir.nodes) expect(origIds.has(n.id)).toBe(false);

    // Edges reference only new ids.
    const newIds = new Set(result.ir.nodes.map((n) => n.id));
    for (const e of result.ir.edges) {
      expect(newIds.has(e.from)).toBe(true);
      expect(newIds.has(e.to)).toBe(true);
    }

    // Layout keys remapped consistently: same value set, all keys are new ids.
    expect(Object.keys(result.layout)).toHaveLength(Object.keys(layout).length);
    for (const key of Object.keys(result.layout)) expect(newIds.has(key)).toBe(true);

    // Original inputs untouched.
    expect(ir.nodes[0].id).toBe("start");
    expect(layout.start).toEqual({ x: 0, y: 0 });

    // The copy is a valid IR (value import works under the test-runner alias).
    const parsed = parseWorkflowIr(result.ir);
    expect(parsed.nodes).toHaveLength(ir.nodes.length);
  });

  it("remaps foreach template node ids + edges, preserving columns", () => {
    const ir = v2WithForeach();
    const result = copyIrWithFreshIds(ir, {});
    const loop = result.ir.nodes.find((n) => n.kind === "foreach")!;
    const template = (loop.config as { template: { nodes: { id: string; kind: string }[]; edges: { from: string; to: string }[] } }).template;

    // Template node ids are remapped (not the originals t1/t2).
    expect(template.nodes.map((n) => n.id)).not.toEqual(["t1", "t2"]);
    expect(template.nodes.map((n) => n.kind)).toEqual(["prompt", "prompt"]);

    // Template edges reference the remapped template ids.
    const tIds = new Set(template.nodes.map((n) => n.id));
    expect(template.edges).toHaveLength(1);
    expect(tIds.has(template.edges[0].from)).toBe(true);
    expect(tIds.has(template.edges[0].to)).toBe(true);

    // Columns preserved untouched.
    expect(result.ir.version).toBe("v2");
    if (result.ir.version === "v2") {
      expect(result.ir.columns).toEqual(ir.columns);
      // Node columns carried through.
      expect(result.ir.nodes.every((n) => n.column === "in-progress")).toBe(true);
    }
  });

  it("remaps namespaced foreach child layout keys consistently with the template ids", () => {
    const ir = v2WithForeach();
    const layout = {
      start: { x: 0, y: 0 },
      loop: { x: 100, y: 0 },
      "loop::t1": { x: 10, y: 20 },
      "loop::t2": { x: 270, y: 20 },
      end: { x: 400, y: 0 },
    };
    const result = copyIrWithFreshIds(ir, layout);

    const loop = result.ir.nodes.find((n) => n.kind === "foreach")!;
    const template = (loop.config as { template: { nodes: { id: string }[] } }).template;
    const newGroupId = loop.id;
    const childKeys = Object.keys(result.layout).filter((k) => k.includes("::"));

    // Both namespaced child keys survive (count preserved).
    expect(childKeys).toHaveLength(2);
    // Each child key is `${newGroupId}::${newTemplateId}` for a real template id.
    const newInnerIds = new Set(template.nodes.map((n) => n.id));
    for (const k of childKeys) {
      const [g, inner] = k.split("::");
      expect(g).toBe(newGroupId);
      expect(newInnerIds.has(inner)).toBe(true);
      // No stale original ids leak through.
      expect(g).not.toBe("loop");
      expect(["t1", "t2"]).not.toContain(inner);
    }
    // Values preserved by position (t1's offset stays with the remapped t1 key).
    const t1NewId = result.layout[`${newGroupId}::${template.nodes[0].id}`];
    expect(t1NewId).toEqual({ x: 10, y: 20 });
  });
});

// FNXC:WorkflowOptionalGroup 2026-06-21-18:00:
// The legacy optional-step DECLARATION authoring surface is retired: `optionalStepsOf`
// is removed and `flowToIr` no longer accepts/emits an `optionalSteps` array. Optional
// steps are graph-native `optional-group` nodes carried by the normal node/edge mapping.
describe("optionalSteps declaration authoring removed (U7)", () => {
  it("flowToIr never emits a legacy optionalSteps key", () => {
    const { ir: out } = flowToIr(
      "opt-only",
      [
        { id: "start", type: "workflowNode", position: { x: 0, y: 0 }, data: { kind: "start" } },
        { id: "end", type: "workflowNode", position: { x: 0, y: 200 }, data: { kind: "end" } },
      ] as unknown as FlowNode<WorkflowFlowNodeData>[],
      [{ id: "e1", source: "start", target: "end" }],
      [],
      [],
      [],
    );
    expect("optionalSteps" in out).toBe(false);
  });
});

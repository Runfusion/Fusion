import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import type { WorkflowFlowNodeData, WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";
import { layerNodes } from "./workflow-auto-layout";
import {
  isColumnBandNode,
  isVisualOnlyWorkflowEdge,
  foreachChildFlowId,
  newNodeId,
  refreshTemplateContainerVisualBoundaries,
  shortConditionLabel,
  edgeClassName,
  WF_EDGE_INTERACTION_WIDTH,
  FOREACH_GROUP_WIDTH,
  FOREACH_GROUP_HEIGHT,
  FOREACH_CHILD_X,
  FOREACH_CHILD_Y,
} from "./workflow-flow-mapping";

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
The simplified workflow view renders the SAME node/edge state as the advanced
canvas but with a derived, display-only vertical layout: users of the simple
view never drag nodes, so readable structure must come from topology alone.
Positions computed here are NOT written back into editor state — the persisted
WorkflowDefinition.layout (advanced-canvas manual positions) stays untouched
when someone merely views a workflow in simple mode, so toggling views never
dirties a workflow.

FNXC:WorkflowSimpleView 2026-07-10-12:00:
Node insertion in the simple view happens on edges ("+" between two steps)
because the simple canvas has no drag-to-connect and no free placement. The
insert helper rewires source→new→target while PRESERVING the original edge's
condition on the inbound edge (so outcome/failure routing authored upstream
survives) and creating a default success edge out of the new node. The new
node's REAL (advanced-canvas) position is placed at the source node's y so a
v2 column-banded workflow keeps the node inside the source's column band and
the save-time unplaced-node gate does not fire for simple-view authors who
cannot drag nodes into bands.
*/

type LayoutNode = FlowNode<WorkflowFlowNodeData>;

/** Card footprint of a simple-view step node (kept in sync with
 *  WorkflowSimpleCanvas.css `.wf-simple-node` sizing). */
export const SIMPLE_NODE_WIDTH = 260;
export const SIMPLE_NODE_HEIGHT = 84;

/** Vertical gap between layers — roomy enough for the edge "+" affordance. */
export const SIMPLE_LAYER_GAP_Y = 72;

/** Horizontal gap between siblings within one layer. */
export const SIMPLE_SIBLING_GAP_X = 48;

function isSimpleLayoutable(node: LayoutNode): boolean {
  if (isColumnBandNode(node.id)) return false;
  if (node.parentId) return false;
  return true;
}

/** Estimated rendered width of the start/end terminal pills (they render as
 *  compact pills, not full cards — see .wf-simple-terminal). Keeping the
 *  layout estimate close to the real footprint keeps pills centered over
 *  their neighbors so vertical edges run straight. */
export const SIMPLE_TERMINAL_WIDTH = 110;

function nodeWidth(node: LayoutNode): number {
  const width = node.style?.width;
  if (typeof width === "number") return width;
  if (node.data.kind === "start" || node.data.kind === "end") return SIMPLE_TERMINAL_WIDTH;
  return SIMPLE_NODE_WIDTH;
}

function nodeHeight(node: LayoutNode): number {
  const height = node.style?.height;
  return typeof height === "number" ? height : SIMPLE_NODE_HEIGHT;
}

export type SimpleLayoutPositions = Map<string, { x: number; y: number }>;

/**
 * Compute display positions for a top-to-bottom simplified rendering of the
 * graph. Layering reuses the canvas auto-layout's longest-path algorithm;
 * within a layer siblings are centered horizontally around x=0, ordered by
 * their advanced-canvas x (then id) so the simple view's branch order stays
 * stable and familiar. Container groups (foreach/loop/optional-group) keep
 * their own width/height and their template children keep parent-relative
 * positions (untouched here — children are excluded like auto-layout does).
 */
export function simpleVerticalLayout(nodes: LayoutNode[], edges: FlowEdge[]): SimpleLayoutPositions {
  const layoutables = nodes.filter(isSimpleLayoutable);
  const ids = layoutables.map((n) => n.id);
  const byId = new Map(layoutables.map((n) => [n.id, n]));
  const layer = layerNodes(ids, edges);

  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    const arr = layers.get(l);
    if (arr) arr.push(id);
    else layers.set(l, [id]);
  }

  const positions: SimpleLayoutPositions = new Map();
  const sortedLayerIndexes = [...layers.keys()].sort((a, b) => a - b);
  let y = 0;
  for (const layerIndex of sortedLayerIndexes) {
    const layerIds = [...(layers.get(layerIndex) ?? [])].sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      if (na.position.x !== nb.position.x) return na.position.x - nb.position.x;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    const totalWidth =
      layerIds.reduce((sum, id) => sum + nodeWidth(byId.get(id)!), 0) +
      SIMPLE_SIBLING_GAP_X * Math.max(0, layerIds.length - 1);
    let x = -totalWidth / 2;
    let layerHeight = 0;
    for (const id of layerIds) {
      const node = byId.get(id)!;
      positions.set(id, { x, y });
      x += nodeWidth(node) + SIMPLE_SIBLING_GAP_X;
      layerHeight = Math.max(layerHeight, nodeHeight(node));
    }
    y += layerHeight + SIMPLE_LAYER_GAP_Y;
  }
  return positions;
}

/** True when the simple view should offer a "+" insert affordance on this
 *  edge: a real (non-chrome) forward edge between existing nodes. Rework
 *  edges are excluded — inserting "between" a rework loop-back has no clear
 *  semantics and is an advanced-canvas job. */
export function edgeSupportsSimpleInsert(edge: FlowEdge): boolean {
  if (isVisualOnlyWorkflowEdge(edge)) return false;
  if ((edge.data?.kind as string | undefined) === "rework") return false;
  return true;
}

export interface SimpleInsertSpec {
  kind: WorkflowEditorNodeKind;
  label: string;
  presetConfig?: Record<string, unknown>;
  /** Localized label for the seeded template child of container kinds. */
  containerChildLabel?: string;
}

export interface SimpleInsertResult {
  nodes: LayoutNode[];
  edges: FlowEdge[];
  newNodeId: string;
}

const CONTAINER_KINDS: ReadonlySet<WorkflowEditorNodeKind> = new Set([
  "foreach",
  "loop",
  "optional-group",
]);

function uniqueEdgeId(): string {
  // newNodeId() is already globally unique per session; prefix keeps edge ids
  // visually distinct from node ids in devtools/tests.
  return `e-${newNodeId()}`;
}

/**
 * Insert a new node "on" an existing edge: source→target becomes
 * source→new→target. Returns null when the edge cannot host an insert
 * (chrome/rework edge, missing endpoints, or a container kind dropped inside
 * another container). The caller owns read-only gating (built-ins).
 */
export function insertNodeOnEdge(
  nodes: LayoutNode[],
  edges: FlowEdge[],
  edgeId: string,
  spec: SimpleInsertSpec,
): SimpleInsertResult | null {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge || !edgeSupportsSimpleInsert(edge)) return null;
  const source = nodes.find((n) => n.id === edge.source);
  const target = nodes.find((n) => n.id === edge.target);
  if (!source || !target) return null;

  // Template-child edge (both endpoints inside the same container): insert a
  // sibling child. Containers cannot nest.
  const insideContainer = !!source.parentId && source.parentId === target.parentId;
  if (CONTAINER_KINDS.has(spec.kind) && insideContainer) return null;

  const id = newNodeId();
  const baseConfig: Record<string, unknown> = spec.kind === "gate" ? { gateMode: "gate" } : {};
  const config = spec.presetConfig ? { ...baseConfig, ...spec.presetConfig } : baseConfig;

  // FNXC:WorkflowSimpleView 2026-07-10-12:00:
  // Real position: midpoint x (staggered so repeat inserts don't stack), but
  // the SOURCE node's y — same column band as the source in v2 workflows, so
  // the node is never born "unplaced" for authors who can't drag it.
  const position = insideContainer
    ? {
        x: (source.position.x + target.position.x) / 2 + 12,
        y: (source.position.y + target.position.y) / 2 + 12,
      }
    : {
        x: (source.position.x + target.position.x) / 2 + 24,
        y: source.position.y + 8,
      };

  const newNodes: LayoutNode[] = [];
  if (CONTAINER_KINDS.has(spec.kind)) {
    // Mirror the palette addNode container seeding: group + one seeded child.
    const childId = foreachChildFlowId(id, newNodeId());
    const childConfig = spec.kind === "foreach" ? { seam: "step-execute" } : { prompt: "" };
    newNodes.push(
      {
        id,
        type: spec.kind,
        position,
        data: { kind: spec.kind, label: spec.label, config, templateEmpty: false },
        style: { width: FOREACH_GROUP_WIDTH, height: FOREACH_GROUP_HEIGHT },
        deletable: true,
      },
      {
        id: childId,
        type: "prompt",
        position: { x: FOREACH_CHILD_X, y: FOREACH_CHILD_Y },
        parentId: id,
        extent: "parent",
        data: {
          kind: "prompt",
          label: spec.containerChildLabel ?? "Step",
          config: childConfig,
        },
        deletable: true,
      },
    );
  } else {
    newNodes.push({
      id,
      type: spec.kind,
      position,
      ...(insideContainer ? { parentId: source.parentId, extent: "parent" as const } : {}),
      data: { kind: spec.kind, label: spec.label, config },
      deletable: true,
    });
  }

  const inboundCondition = (edge.data?.condition as string | undefined) ?? "success";
  const inbound: FlowEdge = {
    id: uniqueEdgeId(),
    source: edge.source,
    target: id,
    label: shortConditionLabel(inboundCondition),
    data: { condition: inboundCondition, kind: undefined },
    className: edgeClassName(inboundCondition, false),
    interactionWidth: WF_EDGE_INTERACTION_WIDTH,
  };
  const outbound: FlowEdge = {
    id: uniqueEdgeId(),
    source: id,
    target: edge.target,
    label: shortConditionLabel("success"),
    data: { condition: "success", kind: undefined },
    className: edgeClassName("success", false),
    interactionWidth: WF_EDGE_INTERACTION_WIDTH,
  };

  const nextNodes = [...nodes, ...newNodes];
  const nextEdges = [...edges.filter((e) => e.id !== edgeId), inbound, outbound];
  const refreshed = refreshTemplateContainerVisualBoundaries(nextNodes, nextEdges);
  return { nodes: refreshed.nodes, edges: refreshed.edges, newNodeId: id };
}

/*
FNXC:WorkflowSimpleView 2026-07-12-10:30:
PR #2006 review: fragment and "insert as optional group" picks from an
edge-targeted add-step dialog previously fell through to the advanced
fixed-position insertFragment path, leaving the "+" edge untouched and the
inserted subgraph disconnected. This splice helper wires an ALREADY-inserted
subgraph into the targeted edge: source→(subgraph entries) preserving the
original routing condition, (subgraph exits)→target as success, original edge
removed, and the subgraph translated next to the source node's y so v2
column banding stays valid for simple-view authors who cannot drag.
*/

/**
 * Wire an inserted subgraph (from insertFragment) into an existing edge.
 * Entries/exits derive from in/out degree over the subgraph's internal
 * non-rework edges (mirroring template boundary semantics). Returns null when
 * the edge is gone/ineligible or the subgraph has no top-level nodes — the
 * caller keeps the plain fixed-position insert in that case.
 */
export function spliceInsertedSubgraphOnEdge(
  nodes: LayoutNode[],
  edges: FlowEdge[],
  edgeId: string,
  insertedNodeIds: readonly string[],
): { nodes: LayoutNode[]; edges: FlowEdge[] } | null {
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge || !edgeSupportsSimpleInsert(edge)) return null;
  const source = nodes.find((n) => n.id === edge.source);
  const target = nodes.find((n) => n.id === edge.target);
  if (!source || !target) return null;

  const insertedSet = new Set(insertedNodeIds);
  const insertedTop = nodes.filter(
    (n) => insertedSet.has(n.id) && !n.parentId && !isColumnBandNode(n.id),
  );
  if (insertedTop.length === 0) return null;
  const topIds = new Set(insertedTop.map((n) => n.id));

  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();
  for (const id of topIds) {
    indegree.set(id, 0);
    outdegree.set(id, 0);
  }
  for (const e of edges) {
    if (isVisualOnlyWorkflowEdge(e)) continue;
    if ((e.data?.kind as string | undefined) === "rework") continue;
    if (!topIds.has(e.source) || !topIds.has(e.target)) continue;
    outdegree.set(e.source, (outdegree.get(e.source) ?? 0) + 1);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const entries = insertedTop.filter((n) => (indegree.get(n.id) ?? 0) === 0);
  const exits = insertedTop.filter((n) => (outdegree.get(n.id) ?? 0) === 0);
  const entryNodes = entries.length > 0 ? entries : insertedTop;
  const exitNodes = exits.length > 0 ? exits : insertedTop;

  // Translate the subgraph beside the wiring point: same y band as the source
  // (column validity), x around the source/target midpoint. Relative layout
  // inside the subgraph is preserved.
  const minX = Math.min(...insertedTop.map((n) => n.position.x));
  const minY = Math.min(...insertedTop.map((n) => n.position.y));
  const deltaX = (source.position.x + target.position.x) / 2 + 24 - minX;
  const deltaY = source.position.y + 8 - minY;
  const nextNodes = nodes.map((n) =>
    topIds.has(n.id)
      ? { ...n, position: { x: n.position.x + deltaX, y: n.position.y + deltaY } }
      : n,
  );

  const inboundCondition = (edge.data?.condition as string | undefined) ?? "success";
  const newEdges: FlowEdge[] = [
    ...entryNodes.map((entry) => ({
      id: `e-${newNodeId()}`,
      source: edge.source,
      target: entry.id,
      label: shortConditionLabel(inboundCondition),
      data: { condition: inboundCondition, kind: undefined },
      className: edgeClassName(inboundCondition, false),
      interactionWidth: WF_EDGE_INTERACTION_WIDTH,
    })),
    ...exitNodes.map((exit) => ({
      id: `e-${newNodeId()}`,
      source: exit.id,
      target: edge.target,
      label: shortConditionLabel("success"),
      data: { condition: "success", kind: undefined },
      className: edgeClassName("success", false),
      interactionWidth: WF_EDGE_INTERACTION_WIDTH,
    })),
  ];

  const nextEdges = [...edges.filter((e) => e.id !== edgeId), ...newEdges];
  return refreshTemplateContainerVisualBoundaries(nextNodes, nextEdges);
}

/**
 * The simple view's "+ Add step" (no specific edge): insert before the `end`
 * node when a single wiring point is unambiguous, otherwise signal the caller
 * to fall back to a free-floating addNode. Returns the edge id to insert on,
 * or null when no suitable edge exists.
 */
export function findAppendEdgeId(nodes: LayoutNode[], edges: FlowEdge[]): string | null {
  const intoEnd = edges.filter(
    (e) => e.target === "end" && edgeSupportsSimpleInsert(e) && nodes.some((n) => n.id === e.source),
  );
  if (intoEnd.length === 1) return intoEnd[0].id;
  return null;
}

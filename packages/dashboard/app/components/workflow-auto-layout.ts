import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import type { WorkflowIrColumn } from "@fusion/core";
import type { WorkflowFlowNodeData } from "./nodes/WorkflowNodeTypes";
import {
  WF_CARD_MAX_WIDTH,
  WF_CARD_HEIGHT,
  COLUMN_BAND_HEIGHT,
  bandTop,
  strictColumnForY,
  isColumnBandNode,
} from "./workflow-flow-mapping";

// ── One-click auto-layout (U5, R8) ───────────────────────────────────────────
//
// Pure left-to-right "tidy" that NEVER re-columns or unplaces a node. Layering
// derives x from graph topology (longest-path from the start node, ignoring
// rework edges and tolerating cycles); y is constrained per-node to the band of
// the column the node already belongs to (v2) or assigned by within-layer index
// (v1). When same-layer/same-band nodes exceed a band's vertical capacity,
// overflow staggers horizontally (extra x offset) rather than escaping the band
// — preserving the test-enforced invariant strictColumnForY(newY) === original
// column for every node. Foreach group nodes move as units; their parentId
// template children are positioned parent-relative and are left untouched.

/** Horizontal gap between layer columns (added to the card max-width to derive
 *  the per-layer x spacing). Exported so U5's tests and any future tuning share
 *  the single source of truth rather than duplicating the number. */
export const WF_AUTO_LAYOUT_GAP_X = 80;

/** Vertical gap between stacked same-layer/same-band cards. */
export const WF_AUTO_LAYOUT_GAP_Y = 24;

/** Padding inside a band before the first card / after the last card row. */
export const WF_AUTO_LAYOUT_BAND_PADDING = 16;

/** Per-layer horizontal spacing: a full card-width plus the gap. */
export const WF_AUTO_LAYOUT_SPACING = WF_CARD_MAX_WIDTH + WF_AUTO_LAYOUT_GAP_X;

/** Left/top origin for the laid-out graph. */
const ORIGIN_X = 0;
const ORIGIN_Y = 0;

/** Row height for a stacked card (card + vertical gap). */
const ROW_HEIGHT = WF_CARD_HEIGHT + WF_AUTO_LAYOUT_GAP_Y;

type LayoutNode = FlowNode<WorkflowFlowNodeData>;

/** A node is layoutable by auto-layout when it is a top-level step node: not a
 *  column band group and not a foreach template child (parentId set). Foreach
 *  GROUP nodes ARE layoutable (they move as a unit). */
function isLayoutable(node: LayoutNode): boolean {
  if (isColumnBandNode(node.id)) return false;
  if (node.parentId) return false;
  return true;
}

function layoutNodeWidth(node: LayoutNode): number {
  const width = node.style?.width;
  return typeof width === "number" ? width : WF_CARD_MAX_WIDTH;
}

/**
 * Assign each layoutable node a layer index via longest-path layering from the
 * start node. Rework edges (data.kind === "rework") are ignored for layering.
 * Cycle-safe: a per-node depth cap plus a visited guard bounds the relaxation so
 * non-rework cycles (should not occur, but be defensive) cannot loop forever.
 * Nodes unreachable from start land in a trailing layer (max + 1).
 *
 * FNXC:WorkflowSimpleView 2026-07-10-12:00:
 * Exported so the simplified graph view's vertical display layout
 * (workflow-simple-layout.ts) shares the exact same layering semantics as the
 * canvas auto-layout instead of re-deriving a drifting copy.
 */
export function layerNodes(nodeIds: string[], edges: FlowEdge[]): Map<string, number> {
  const idSet = new Set(nodeIds);
  // Adjacency over non-rework edges whose endpoints are both layoutable.
  const adj = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, 0);
  for (const e of edges) {
    if ((e.data?.kind as string | undefined) === "rework") continue;
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    if (e.source === e.target) continue;
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }

  // Roots: explicit start node(s), plus any node with no incoming layering edge
  // (so isolated graphs without a "start" still get laid out).
  const startIds = nodeIds.filter((id) => id === "start");
  const roots = startIds.length
    ? startIds
    : nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);

  const layer = new Map<string, number>();
  // BFS longest-path relaxation. The cap bounds work in the presence of any
  // accidental non-rework cycle: a node can be relaxed at most nodeIds.length
  // times before its layer would exceed the maximum possible acyclic depth.
  const cap = nodeIds.length + 1;
  const queue: string[] = [];
  for (const r of roots) {
    layer.set(r, 0);
    queue.push(r);
  }
  let guard = nodeIds.length * nodeIds.length + nodeIds.length + 1;
  while (queue.length && guard-- > 0) {
    const cur = queue.shift()!;
    const curLayer = layer.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      const candidate = curLayer + 1;
      const existing = layer.get(next);
      if ((existing === undefined || candidate > existing) && candidate <= cap) {
        layer.set(next, candidate);
        queue.push(next);
      }
    }
  }

  // Unreachable nodes → a trailing layer after the deepest reached layer.
  let maxLayer = 0;
  for (const v of layer.values()) if (v > maxLayer) maxLayer = v;
  const trailing = layer.size ? maxLayer + 1 : 0;
  for (const id of nodeIds) {
    if (!layer.has(id)) layer.set(id, trailing);
  }
  return layer;
}

/** Result: nodeId → new absolute position. Only positions change. */
export type AutoLayoutPositions = Map<string, { x: number; y: number }>;

/**
 * Compute new positions for the layoutable nodes. Returns a Map keyed by node
 * id; nodes not in the map (band groups, foreach children) keep their current
 * positions. The caller applies the map via setNodes (positions only).
 *
 * @param nodes   current flow nodes (bands + steps + foreach children)
 * @param edges   current flow edges
 * @param columns the authored v2 columns (empty array ⇒ v1 free placement)
 */
export function autoLayout(
  nodes: LayoutNode[],
  edges: FlowEdge[],
  columns: WorkflowIrColumn[],
): AutoLayoutPositions {
  const layoutables = nodes.filter(isLayoutable);
  const ids = layoutables.map((n) => n.id);
  const layer = layerNodes(ids, edges);

  // Stable sort within a layer: current y, then id. Deterministic across calls.
  const byId = new Map(layoutables.map((n) => [n.id, n]));
  const positions: AutoLayoutPositions = new Map();

  // Group node ids by layer.
  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    (layers.get(l) ?? layers.set(l, []).get(l)!).push(id);
  }

  const v2 = columns.length > 0;

  /*
   * FNXC:WorkflowContainerEdges 2026-06-26-08:05:
   * Auto-layout must space graph layers by the widest rendered node in each prior layer. Container nodes render wider than cards, so fixed card-width layer spacing can place the next optional-group/foreach/loop on top of the previous container's source handle.
   *
   * FNXC:WorkflowContainerEdges 2026-06-27-22:16:
   * The invariant is run-length based, not single-container based: every layer in a consecutive optional-group/foreach/loop sequence must advance by that layer's rendered width so N adjacent containers keep visible target/source edge handles.
   */
  const layerMaxWidths = new Map<number, number>();
  for (const [layerIndex, layerIds] of layers) {
    layerMaxWidths.set(
      layerIndex,
      Math.max(...layerIds.map((id) => layoutNodeWidth(byId.get(id)!)), WF_CARD_MAX_WIDTH),
    );
  }
  const sortedLayerIndexes = [...layers.keys()].sort((a, b) => a - b);
  const layerXByIndex = new Map<number, number>();
  let nextLayerX = ORIGIN_X;
  for (const layerIndex of sortedLayerIndexes) {
    layerXByIndex.set(layerIndex, nextLayerX);
    nextLayerX += (layerMaxWidths.get(layerIndex) ?? WF_CARD_MAX_WIDTH) + WF_AUTO_LAYOUT_GAP_X;
  }

  for (const [layerIndex, layerIds] of layers) {
    const sorted = [...layerIds].sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      if (na.position.y !== nb.position.y) return na.position.y - nb.position.y;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    const layerX = layerXByIndex.get(layerIndex) ?? ORIGIN_X;

    if (!v2) {
      // v1: free placement — within-layer index × row height.
      sorted.forEach((id, withinIdx) => {
        positions.set(id, { x: layerX, y: ORIGIN_Y + withinIdx * ROW_HEIGHT });
      });
      continue;
    }

    // v2: each node KEEPS its column. Track the next free row per column so
    // same-layer/same-band nodes stack downward; overflow staggers x.
    // Per (column, stagger-bucket) we track how many rows are filled.
    const rowsPerColumn = new Map<string, number>();
    for (const id of sorted) {
      const node = byId.get(id)!;
      // Resolve the node's column WITHOUT clamping: an explicit column id, or a
      // strict band hit-test. A node with neither (parked outside every band and
      // carrying no column) is "unplaced" and must stay that way — auto-layout
      // never silently re-columns it into the nearest band. We give it the new
      // layer x (so the tidy still flows it left-to-right) but preserve its y so
      // strictColumnForY(newY) remains undefined.
      const colId =
        node.data.column ??
        (strictColumnForY(node.position.y, columns) ? strictColumnForY(node.position.y, columns) : undefined);
      if (!colId) {
        positions.set(id, { x: layerX, y: node.position.y });
        continue;
      }
      const colIndex = columns.findIndex((c) => c.id === colId);
      const safeColIndex = colIndex >= 0 ? colIndex : 0;

      const top = bandTop(safeColIndex);
      const firstY = top + WF_AUTO_LAYOUT_BAND_PADDING;
      // Last y at which a card still fits fully inside the band.
      const maxY = top + COLUMN_BAND_HEIGHT - WF_CARD_HEIGHT - WF_AUTO_LAYOUT_BAND_PADDING;
      const capacity = Math.max(1, Math.floor((maxY - firstY) / ROW_HEIGHT) + 1);

      const used = rowsPerColumn.get(colId ?? `__idx${safeColIndex}`) ?? 0;
      const rowInBucket = used % capacity;
      const staggerBucket = Math.floor(used / capacity);

      const y = firstY + rowInBucket * ROW_HEIGHT;
      // Stagger x by half-spacing per overflow bucket so wrapped rows don't
      // collide with the un-staggered column while staying in the same band.
      const x = layerX + staggerBucket * ((layerMaxWidths.get(layerIndex) ?? WF_CARD_MAX_WIDTH) + WF_AUTO_LAYOUT_GAP_X) / 2;

      positions.set(id, { x, y });
      rowsPerColumn.set(colId ?? `__idx${safeColIndex}`, used + 1);
    }
  }

  return positions;
}

/** Apply auto-layout positions to a node list, returning a new array. Only
 *  positions of mapped nodes change; everything else is preserved by reference
 *  shape. Convenience for setNodes in the editor. */
export function applyAutoLayout(
  nodes: LayoutNode[],
  positions: AutoLayoutPositions,
): LayoutNode[] {
  return nodes.map((n) => {
    const pos = positions.get(n.id);
    return pos ? { ...n, position: pos } : n;
  });
}

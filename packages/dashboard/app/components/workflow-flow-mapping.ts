import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import type {
  WorkflowIr,
  WorkflowIrV2,
  WorkflowIrColumn,
  WorkflowIrNode,
  WorkflowIrEdge,
  WorkflowIrNodeKind,
  WorkflowDefinition,
  WorkflowFieldDefinition,
  WorkflowSettingDefinition,
} from "@fusion/core";
import type { WorkflowFlowNodeData, WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";

/** Local mirror of @fusion/core's WorkflowForeachConfig (KTD-3). The core index
 *  barrel does not re-export it, and the dashboard build aliases @fusion/core to
 *  a types-only entry, so we describe just the shape this mapping needs. */
interface WorkflowForeachConfig {
  source: "task-steps";
  maxReworkCycles?: number;
  mode?: "sequential" | "parallel";
  concurrency?: number;
  isolation?: "shared" | "worktree";
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] };
}

interface WorkflowLoopConfig {
  maxIterations?: number;
  timeoutMs?: number;
  exitWhen?: {
    type: "output-contains" | "output-matches";
    nodeId?: string;
    value?: string;
    pattern?: string;
    flags?: string;
  };
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] };
}

// WorkflowFieldDefinition is imported from @fusion/core above (KTD-13/14).
// Re-exported so existing importers that reference WorkflowFieldDefinitionShape
// can migrate; callers should prefer WorkflowFieldDefinition directly.
export type { WorkflowFieldDefinition as WorkflowFieldDefinitionShape };

// ── foreach template region (KTD-3, U8) ──────────────────────────────────────
//
// A `foreach` node is authored inline as a React Flow group node whose template
// subgraph nodes are children with `parentId` set to the group id. To keep child
// flow-node ids globally unique while preserving the *template-local* ids that
// the IR's `config.template` stores, child flow ids are namespaced as
// `<groupId>::<templateNodeId>`; flowToIr strips the prefix back out when it
// reassembles the template. Geometry for the group + auto-layout for template
// nodes lacking persisted layout data.
// ── Card-style node dimensions (U1) ─────────────────────────────────────────
//
// Cards are larger than the old icon+label pills: a header row plus a config
// summary line. These constants are the single source of truth for card sizing
// — the CSS sizes cards to WF_CARD_WIDTH (with WF_CARD_MAX_WIDTH as the hard
// ceiling so long labels/summaries truncate rather than grow the canvas), and
// U5's auto-layout imports WF_CARD_WIDTH for column spacing rather than
// duplicating the number.
export const WF_CARD_WIDTH = 200;
export const WF_CARD_MAX_WIDTH = 240;
export const WF_CARD_HEIGHT = 64;

export const FOREACH_GROUP_WIDTH = 560;
export const FOREACH_GROUP_HEIGHT = 220;
export const FOREACH_CHILD_X = 30;
export const FOREACH_CHILD_Y = 56;
export const FOREACH_CHILD_STEP_X = 260;

const FOREACH_CHILD_SEP = "::";
/** Compose a globally-unique flow-node id for a template child. */
export function foreachChildFlowId(groupId: string, templateNodeId: string): string {
  return `${groupId}${FOREACH_CHILD_SEP}${templateNodeId}`;
}
/** Recover the template-local node id from a namespaced child flow id. */
export function templateNodeIdFromChild(groupId: string, childFlowId: string): string {
  const prefix = `${groupId}${FOREACH_CHILD_SEP}`;
  return childFlowId.startsWith(prefix) ? childFlowId.slice(prefix.length) : childFlowId;
}

/** Layout geometry for column swimlane bands. Bands stack vertically; each band
 *  is full-width and a node's `column` is derived by hit-testing the node's y
 *  against the band rows (position-based, so the editor's existing absolute
 *  layout persistence carries over unchanged — see flowToIr). */
export const COLUMN_BAND_HEIGHT = 220;
export const COLUMN_BAND_WIDTH = 5000;
export const COLUMN_BAND_X = -40;
export const COLUMN_BAND_TOP = 0;
/** Layering: swimlane/template groups sit below routed edges; step cards sit above. */
const WF_BACKGROUND_GROUP_Z_INDEX = 0;
const WF_EDGE_Z_INDEX = 1;
const WF_STEP_NODE_Z_INDEX = 2;
/** React Flow node id for a column band group node. */
export const columnBandNodeId = (columnId: string): string => `__col__:${columnId}`;
export const isColumnBandNode = (id: string): boolean => id.startsWith("__col__:");
export const columnIdFromBandNode = (id: string): string => id.slice("__col__:".length);

/**
 * FNXC:WorkflowEditor 2026-06-16-23:15:
 * Re-adding a workflow column creates a fresh generated id, so every authored node column reference must be reconciled against the current column set. Clear stale references, especially on the structural start node, before save-time IR validation can reject with `references undefined column`.
 */
export function reconcileNodeColumns(
  nodes: FlowNode<WorkflowFlowNodeData>[],
  columns: WorkflowIrColumn[],
): FlowNode<WorkflowFlowNodeData>[] {
  if (columns.length === 0) {
    let changed = false;
    const next = nodes.map((node) => {
      if (isColumnBandNode(node.id) || node.type === "group" || node.data.column === undefined) return node;
      changed = true;
      return { ...node, data: { ...node.data, column: undefined } };
    });
    return changed ? next : nodes;
  }

  const columnIds = new Set(columns.map((column) => column.id));
  let changed = false;
  const next = nodes.map((node) => {
    const column = node.data.column;
    if (isColumnBandNode(node.id) || node.type === "group" || column === undefined || columnIds.has(column)) return node;
    changed = true;
    return { ...node, data: { ...node.data, column: undefined } };
  });

  return changed ? next : nodes;
}

/** The y-origin of the band for the column at `index`. */
export function bandTop(index: number): number {
  return COLUMN_BAND_TOP + index * COLUMN_BAND_HEIGHT;
}

/** Hit-test a y coordinate against the ordered column bands, returning the
 *  column id whose band contains it (clamped to the first/last band). Returns
 *  undefined when there are no columns. Use for drag placement (a dropped node
 *  always snaps to the nearest band). */
export function columnForY(y: number, columns: WorkflowIrColumn[]): string | undefined {
  if (columns.length === 0) return undefined;
  const idx = Math.floor((y - COLUMN_BAND_TOP) / COLUMN_BAND_HEIGHT);
  const clamped = Math.max(0, Math.min(columns.length - 1, idx));
  return columns[clamped]?.id;
}

/** Strict (non-clamping) hit test: returns the column id whose band vertically
 *  contains `y`, or undefined when `y` falls outside every band. Use for
 *  unplaced-node detection (a node parked above/below all bands is unplaced). */
export function strictColumnForY(y: number, columns: WorkflowIrColumn[]): string | undefined {
  if (columns.length === 0) return undefined;
  const idx = Math.floor((y - COLUMN_BAND_TOP) / COLUMN_BAND_HEIGHT);
  if (idx < 0 || idx >= columns.length) return undefined;
  return columns[idx]?.id;
}

/** True when the IR is v2 (has columns). */
function isV2(ir: WorkflowIr): ir is WorkflowIrV2 {
  return ir.version === "v2";
}

const SAME_KIND_EDITOR_NODE_KINDS = new Set<WorkflowIrNodeKind>([
  "start",
  "prompt",
  "script",
  "gate",
  "end",
  "hold",
  "split",
  "join",
  "foreach",
  "loop",
  "step-review",
  "parse-steps",
  "code",
  "notify",
]);

const GRAPH_ONLY_EDITOR_KIND: Partial<Record<WorkflowIrNodeKind, WorkflowEditorNodeKind>> = {
  "merge-gate": "gate",
  "merge-attempt": "merge",
  "manual-merge-hold": "hold",
  "retry-backoff": "hold",
  "recovery-router": "gate",
  "branch-group-member-integration": "merge",
  "branch-group-promotion": "merge",
  "pr-merge": "merge",
  "pr-create": "prompt",
  "pr-respond": "prompt",
};

function isSameKindEditorNodeKind(
  kind: WorkflowIrNodeKind,
): kind is Extract<WorkflowEditorNodeKind, WorkflowIrNodeKind> {
  return SAME_KIND_EDITOR_NODE_KINDS.has(kind);
}

/**
 * Resolve the editor node "type" for an IR node. Graph-only IR policy nodes map
 * to the closest existing editor shape: merge/recovery gates render as gate,
 * merge/branch actions render as merge, passive waits render as hold, and PR
 * nodes reuse merge/prompt until dedicated renderers exist.
 */
function editorKind(node: WorkflowIr["nodes"][number]): WorkflowEditorNodeKind {
  const seam = node.config?.seam;
  if (seam === "merge") return "merge";
  const mapped = GRAPH_ONLY_EDITOR_KIND[node.kind];
  if (mapped) return mapped;

  if (isSameKindEditorNodeKind(node.kind)) return node.kind;

  return "prompt";
}

function nodeLabel(node: WorkflowIr["nodes"][number]): string {
  const name = node.config?.name;
  if (typeof name === "string" && name.trim()) return name;
  if (node.config?.seam === "merge") return "Merge boundary";
  return node.id;
}

function dataIrKind(node: WorkflowIrNode, editorNodeKind: WorkflowEditorNodeKind): Partial<WorkflowFlowNodeData> {
  return node.kind === editorNodeKind ? {} : { irKind: node.kind };
}

function preservedIrKind(data: WorkflowFlowNodeData): WorkflowIrNode["kind"] | undefined {
  return typeof data.irKind === "string" ? (data.irKind as WorkflowIrNode["kind"]) : undefined;
}

/** Build React Flow swimlane band group nodes from the workflow's columns. */
export function columnsToBandNodes(columns: WorkflowIrColumn[]): FlowNode<WorkflowFlowNodeData>[] {
  return columns.map((col, index): FlowNode<WorkflowFlowNodeData> => ({
    id: columnBandNodeId(col.id),
    type: "group",
    position: { x: COLUMN_BAND_X, y: bandTop(index) },
    data: { kind: "start", label: col.name, column: col.id } as unknown as WorkflowFlowNodeData,
    draggable: false,
    selectable: false,
    deletable: false,
    // Bands sit behind routed edges and step nodes so built-in topology stays visible.
    zIndex: WF_BACKGROUND_GROUP_Z_INDEX,
    style: {
      width: COLUMN_BAND_WIDTH,
      height: COLUMN_BAND_HEIGHT,
    },
    className: "wf-column-band",
  }));
}

/** Read a node's foreach template config, or undefined when it is not a foreach
 *  node carrying a template. */
function foreachConfigOf(node: WorkflowIrNode): WorkflowForeachConfig | undefined {
  if (node.kind !== "foreach") return undefined;
  const cfg = node.config as Partial<WorkflowForeachConfig> | undefined;
  if (!cfg || !cfg.template) return undefined;
  return cfg as WorkflowForeachConfig;
}

function loopConfigOf(node: WorkflowIrNode): WorkflowLoopConfig | undefined {
  if (node.kind !== "loop" && node.kind !== "retry-backoff") return undefined;
  const cfg = node.config as Partial<WorkflowLoopConfig> | undefined;
  if (!cfg || !cfg.template) return undefined;
  return cfg as WorkflowLoopConfig;
}

function groupTemplateConfigOf(
  node: WorkflowIrNode,
): WorkflowForeachConfig | WorkflowLoopConfig | undefined {
  return foreachConfigOf(node) ?? loopConfigOf(node);
}

/** CSS class for an edge given its condition + rework kind. Rework takes
 *  precedence; failure edges get the distinct failure styling; success and other
 *  conditions get no class (default styling). R2's two-channel rule (label always
 *  rendered + dash pattern) plus color is enforced by the CSS for these classes. */
export function edgeClassName(condition: string, isRework: boolean): string | undefined {
  if (isRework) return "wf-edge-rework";
  if (condition === "failure") return "wf-edge-failure";
  return undefined;
}

/** Build a React Flow edge from an IR edge. Rework edges (KTD-5) carry kind so
 *  the editor renders them dashed in the accent color. Failure edges (R2) carry
 *  the wf-edge-failure class for a distinct dash + error-token stroke. */
function irEdgeToFlow(edge: WorkflowIrEdge, index: number, idScope = ""): FlowEdge {
  const condition = edge.condition ?? "success";
  const isRework = edge.kind === "rework";
  return {
    id: `e-${idScope}${edge.from}-${edge.to}-${index}`,
    source: idScope ? `${idScope}${edge.from}` : edge.from,
    target: idScope ? `${idScope}${edge.to}` : edge.to,
    label: isRework ? `${shortConditionLabel(condition)} (rework)` : shortConditionLabel(condition),
    data: { condition, kind: isRework ? "rework" : undefined },
    type: isRework ? "step" : undefined,
    animated: isRework,
    className: edgeClassName(condition, isRework),
    interactionWidth: WF_EDGE_INTERACTION_WIDTH,
    markerEnd: undefined,
    zIndex: WF_EDGE_Z_INDEX,
  };
}

/** Default edge hit-target width (px) so edges are clickable/tappable even when
 *  visually thin. Applied per-edge (defaultEdgeOptions only seeds new edges). */
export const WF_EDGE_INTERACTION_WIDTH = 24;

/** Short display label for an edge condition. `outcome:<verdict>` conditions
 *  render as the verdict alone (KTD-4); everything else verbatim. */
export function shortConditionLabel(condition: string): string {
  if (condition.startsWith("outcome:")) return condition.slice("outcome:".length);
  return condition;
}

/** Build React Flow nodes/edges from a stored workflow definition. v2 columns
 *  render as swimlane band group nodes; step nodes carry their `column`. A
 *  `foreach` node renders as a group whose template subgraph nodes are children
 *  (parentId = the group id). */
export function irToFlow(def: WorkflowDefinition): {
  nodes: FlowNode<WorkflowFlowNodeData>[];
  edges: FlowEdge[];
} {
  const columns = isV2(def.ir) ? def.ir.columns : [];
  const bandNodes = columnsToBandNodes(columns);
  const childNodes: FlowNode<WorkflowFlowNodeData>[] = [];
  const childEdges: FlowEdge[] = [];

  const stepNodes = def.ir.nodes.map((node, index): FlowNode<WorkflowFlowNodeData> => {
    const pos = def.layout?.[node.id];
    const kind = editorKind(node);
    const column = isV2(def.ir) ? node.column : undefined;
    const colIndex = column ? columns.findIndex((c) => c.id === column) : -1;
    // Default placement seeds the node inside its column band when no persisted
    // layout exists; otherwise we honor the saved absolute position.
    const fallbackY = colIndex >= 0 ? bandTop(colIndex) + 70 : 120;

    const groupCfg = groupTemplateConfigOf(node);
    if (groupCfg) {
      const template = groupCfg.template;
      // Render template nodes as children of this group (parentId = group id).
      template.nodes.forEach((inner, innerIdx) => {
        const childFlowId = foreachChildFlowId(node.id, inner.id);
        // Template layout lives under namespaced keys; auto-layout otherwise.
        const childPos =
          def.layout?.[childFlowId] ?? {
            x: FOREACH_CHILD_X + innerIdx * FOREACH_CHILD_STEP_X,
            y: FOREACH_CHILD_Y,
          };
        const innerKind = editorKind(inner);
        childNodes.push({
          id: childFlowId,
          type: innerKind,
          position: childPos,
          parentId: node.id,
          extent: "parent",
          data: { kind: innerKind, ...dataIrKind(inner, innerKind), label: nodeLabel(inner), config: { ...(inner.config ?? {}) } },
          deletable: true,
          zIndex: WF_STEP_NODE_Z_INDEX,
        });
      });
      template.edges.forEach((edge, eIdx) => {
        childEdges.push(irEdgeToFlow(edge, eIdx, `${node.id}${FOREACH_CHILD_SEP}`));
      });
      // Strip the template off the group node's own config (children carry it).
      const { template: _t, ...restCfg } = (node.config ?? {}) as Record<string, unknown>;
      return {
        id: node.id,
        type: kind,
        position: pos ?? { x: 80 + index * 180, y: fallbackY },
        data: {
          kind,
          ...dataIrKind(node, kind),
          label: nodeLabel(node),
          config: { ...restCfg },
          column,
          templateEmpty: template.nodes.length === 0,
        },
        style: { width: FOREACH_GROUP_WIDTH, height: FOREACH_GROUP_HEIGHT },
        deletable: true,
        zIndex: WF_BACKGROUND_GROUP_Z_INDEX,
      };
    }

    return {
      id: node.id,
      type: kind,
      position: pos ?? { x: 80 + index * 180, y: fallbackY },
      data: {
        kind,
        ...dataIrKind(node, kind),
        label: nodeLabel(node),
        config: { ...(node.config ?? {}) },
        column,
      },
      deletable: node.kind !== "start" && node.kind !== "end",
      zIndex: WF_STEP_NODE_Z_INDEX,
    };
  });

  const edges = def.ir.edges.map((edge, index): FlowEdge => irEdgeToFlow(edge, index));

  // Group nodes must precede their children in the array for React Flow.
  return { nodes: [...bandNodes, ...stepNodes, ...childNodes], edges: [...edges, ...childEdges] };
}

/** Sanitize a node config, applying the v1 round-trip name rules. */
function nodeConfig(node: FlowNode<WorkflowFlowNodeData>): Record<string, unknown> | undefined {
  const data = node.data;
  const config: Record<string, unknown> = { ...(data.config ?? {}) };
  const fallbackLabel = data.kind === "merge"
    ? "Merge boundary"
    : node.parentId
      ? templateNodeIdFromChild(node.parentId, node.id)
      : node.id;
  if (data.kind !== "start" && data.kind !== "end" && data.label && data.label !== fallbackLabel) {
    config.name = data.label;
  } else {
    delete config.name;
  }
  return config;
}

/**
 * Project React Flow nodes/edges back into a WorkflowIr plus a layout map.
 *
 * When `columns` is provided (the editor manages columns via WorkflowColumnPanel)
 * the result is a **v2** IR: column bands are dropped, each step node's `column`
 * is derived by hit-testing its y against the ordered bands, and split/join/hold
 * config is preserved verbatim. With no columns the result is a v1 IR (legacy
 * round-trip, byte-compatible with the pre-U10 mapping).
 */
export function flowToIr(
  name: string,
  nodes: FlowNode<WorkflowFlowNodeData>[],
  edges: FlowEdge[],
  columns?: WorkflowIrColumn[],
  fields?: WorkflowFieldDefinition[],
  settings?: WorkflowSettingDefinition[],
): { ir: WorkflowIr; layout: Record<string, { x: number; y: number }> } {
  const realNodes = nodes.filter((n) => !isColumnBandNode(n.id));
  // Partition by parentId: foreach group children reassemble into that group's
  // config.template; everything else (no parentId) is top-level. (Column band
  // group nodes are already excluded above.)
  const topNodes = realNodes.filter((n) => !n.parentId);
  const childrenByGroup = new Map<string, FlowNode<WorkflowFlowNodeData>[]>();
  for (const n of realNodes) {
    if (n.parentId) {
      const arr = childrenByGroup.get(n.parentId) ?? [];
      arr.push(n);
      childrenByGroup.set(n.parentId, arr);
    }
  }
  const groupIds = new Set(
    topNodes.filter((n) => n.data.kind === "foreach" || n.data.kind === "loop").map((n) => n.id),
  );
  const hasFields = Array.isArray(fields) && fields.length > 0;
  const hasSettings = Array.isArray(settings) && settings.length > 0;
  // Fields and settings are v2-only declarations: a workflow with either but no
  // custom columns still serializes as v2 (with the synthesized default columns).
  const v2 = (Array.isArray(columns) && columns.length > 0) || hasFields || hasSettings;
  const layout: Record<string, { x: number; y: number }> = {};

  /** Project one flow node (top-level or template child) into an IR node. */
  function toIrNode(node: FlowNode<WorkflowFlowNodeData>, localId: string): WorkflowIrNode {
    const data = node.data;
    const config = nodeConfig(node);
    const originalKind = preservedIrKind(data);
    if (data.kind === "merge") {
      if (originalKind) {
        return { id: localId, kind: originalKind, config: config && Object.keys(config).length ? config : undefined };
      }
      return { id: localId, kind: "prompt", config: { ...(config ?? {}), seam: "merge" } };
    }
    if (data.kind === "foreach" || data.kind === "loop" || originalKind === "retry-backoff") {
      if (originalKind && originalKind !== "foreach" && originalKind !== "loop" && originalKind !== "retry-backoff") {
        return { id: localId, kind: originalKind, config: config && Object.keys(config).length ? config : undefined };
      }
      // Reassemble the template from this group's children.
      const children = childrenByGroup.get(node.id) ?? [];
      const templateNodes: WorkflowIrNode[] = children.map((c) => {
        const innerId = templateNodeIdFromChild(node.id, c.id);
        layout[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
        return toIrNode(c, innerId);
      });
      const childIdSet = new Set(children.map((c) => c.id));
      const templateEdges: WorkflowIrEdge[] = edges
        .filter((e) => childIdSet.has(e.source) && childIdSet.has(e.target))
        .map((e) => flowEdgeToIr(e, node.id));
      const baseCfg = (config ?? {}) as Record<string, unknown>;
      return {
        id: localId,
        kind: originalKind ?? data.kind,
        config: { ...baseCfg, template: { nodes: templateNodes, edges: templateEdges } },
      };
    }
    return {
      id: localId,
      kind: originalKind ?? (data.kind as WorkflowIrNode["kind"]),
      config: config && Object.keys(config).length ? config : undefined,
    };
  }

  const hasColumns = Array.isArray(columns) && columns.length > 0;
  const irNodes: WorkflowIr["nodes"] = topNodes.map((node) => {
    const column = hasColumns ? node.data.column ?? columnForY(node.position.y, columns!) : undefined;
    const base = toIrNode(node, node.id);
    layout[node.id] = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
    return column ? { ...base, column } : base;
  });

  // Top-level edges: exclude any edge that lives entirely inside a foreach
  // template (both endpoints are children of the same group) — those are folded
  // into the group's template above.
  const childIdToGroup = new Map<string, string>();
  for (const [gid, kids] of childrenByGroup) for (const k of kids) childIdToGroup.set(k.id, gid);
  const irEdges: WorkflowIr["edges"] = edges
    .filter((e) => {
      const sg = childIdToGroup.get(e.source);
      const tg = childIdToGroup.get(e.target);
      return !(sg && tg && sg === tg);
    })
    .map((e) => flowEdgeToIr(e));

  void groupIds;

  if (v2) {
    const ir: WorkflowIrV2 = {
      version: "v2",
      name,
      // Preserve the optional column-agent binding through the editor round-trip
      // (column-agent plan U6). Omit the `agent` key entirely when unset so
      // legacy/default workflows stay byte-identical (R9) — never emit
      // `agent: undefined`/`agent: null`.
      columns: hasColumns
        ? columns!.map((c) => ({
            id: c.id,
            name: c.name,
            traits: c.traits,
            ...(c.agent ? { agent: c.agent } : {}),
          }))
        : [],
      nodes: irNodes,
      edges: irEdges,
    };
    if (hasFields) {
      // The IR's `fields` is typed against @fusion/core's concrete
      // WorkflowFieldDefinition; the editor carries the array through opaquely
      // and the server validator is the source of truth, so assign via unknown.
      (ir as { fields?: unknown }).fields = fields!.map((f) => ({ ...f }));
    }
    if (hasSettings) {
      // Setting DECLARATIONS round-trip through the editor opaquely (server
      // validator is the source of truth, same as fields). Values live in the
      // workflow_settings table, NOT in the IR (KTD-2).
      (ir as { settings?: unknown }).settings = settings!.map((s) => ({
        ...s,
        options: s.options ? s.options.map((o) => ({ ...o })) : undefined,
        render: s.render ? { ...s.render } : undefined,
      }));
    }
    return { ir, layout };
  }

  return { ir: { version: "v1", name, nodes: irNodes, edges: irEdges }, layout };
}

/** Project a React Flow edge into an IR edge. Rework edges carry `kind`. When
 *  `groupId` is given the endpoints are de-namespaced back to template-local
 *  ids. */
function flowEdgeToIr(edge: FlowEdge, groupId?: string): WorkflowIrEdge {
  const condition = (edge.data?.condition as string | undefined) ?? "success";
  const isRework = (edge.data?.kind as string | undefined) === "rework";
  const from = groupId ? templateNodeIdFromChild(groupId, edge.source) : edge.source;
  const to = groupId ? templateNodeIdFromChild(groupId, edge.target) : edge.target;
  return { from, to, condition, ...(isRework ? { kind: "rework" as const } : {}) };
}

// ── Deletion with cascade semantics (U3, R6) ─────────────────────────────────
//
// Pure node/edge transformation for deleting nodes and/or edges. React Flow's
// built-in deletion removes incident edges but does NOT cascade group children
// (deleting a foreach group leaves its `parentId` children orphaned), so the
// editor routes all deletions through this helper for explicit, testable
// behavior.

/** Node kinds that may never be deleted (start/end are structural). */
const PROTECTED_NODE_KINDS = new Set<string>(["start", "end"]);

/** True when a flow node is protected from deletion: start/end kinds and column
 *  band group nodes are never removable, regardless of the requested ids. */
function isProtectedFromDelete(node: FlowNode<WorkflowFlowNodeData>): boolean {
  return isColumnBandNode(node.id) || PROTECTED_NODE_KINDS.has(node.data.kind);
}

/**
 * Delete the requested node and/or edge ids from the flow graph, applying R6's
 * cascade rules:
 *   - Deleting a node removes ALL edges incident to it (no auto-bridging).
 *   - Deleting a `foreach`/`loop` group node also deletes its template children
 *     (nodes with `parentId === groupId`) and every edge incident to those
 *     children (React Flow does not cascade parents — handled explicitly).
 *   - `start`/`end` nodes and column band nodes are never deleted: they are
 *     filtered out of the requested ids up front (and their incident edges are
 *     therefore preserved).
 *   - Edge ids in `ids` are removed directly.
 *
 * Pure and order-independent: the same `ids` set always yields the same result.
 */
export function cascadeDelete(
  nodes: FlowNode<WorkflowFlowNodeData>[],
  edges: FlowEdge[],
  ids: Iterable<string>,
): { nodes: FlowNode<WorkflowFlowNodeData>[]; edges: FlowEdge[] } {
  const requested = new Set(ids);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Resolve which node ids are actually deletable, expanding template groups to
  // their template children. Protected nodes are dropped from the request.
  const deleteNodeIds = new Set<string>();
  for (const id of requested) {
    const node = nodeById.get(id);
    if (!node || isProtectedFromDelete(node)) continue;
    deleteNodeIds.add(id);
    if (node.data.kind === "foreach" || node.data.kind === "loop") {
      for (const child of nodes) {
        if (child.parentId === id) deleteNodeIds.add(child.id);
      }
    }
  }

  // Edge ids requested directly (only ones that exist as edges).
  const deleteEdgeIds = new Set<string>();
  for (const e of edges) {
    if (requested.has(e.id)) deleteEdgeIds.add(e.id);
  }

  const nextNodes = nodes.filter((n) => !deleteNodeIds.has(n.id));
  const nextEdges = edges.filter(
    (e) =>
      !deleteEdgeIds.has(e.id) &&
      !deleteNodeIds.has(e.source) &&
      !deleteNodeIds.has(e.target),
  );
  return { nodes: nextNodes, edges: nextEdges };
}

// ── Edge-condition authoring (U2) ────────────────────────────────────────────

/** Editor node kinds whose edges expose a success/failure condition select
 *  (KTD-2). step-review uses verdict controls; all other kinds are read-only. */
const CONDITION_EDITABLE_KINDS = new Set<string>(["prompt", "script", "gate", "code", "foreach", "loop"]);

/** Decide what the edge inspector renders for an edge sourced from `sourceKind`:
 *  - "verdicts": step-review verdict select + rework checkbox (existing);
 *  - "conditions": success/failure native select (KTD-2);
 *  - "readonly": a read-only condition note. Pure so the gating is unit-testable
 *  without rendering edges (jsdom can't). */
export function edgeConditionEditability(
  sourceKind: string | undefined,
): "verdicts" | "conditions" | "readonly" {
  if (sourceKind === "step-review") return "verdicts";
  if (sourceKind && CONDITION_EDITABLE_KINDS.has(sourceKind)) return "conditions";
  return "readonly";
}

/** True when adding an edge source→target would create a cycle, i.e. `target`
 *  can already reach `source` by walking existing non-rework edges (rework edges
 *  are the only legal cycles and are excluded from the reachability walk, per
 *  KTD-9). Pure + exported so the connect-time guard is testable at the mapping
 *  layer. */
export function wouldCreateCycle(edges: FlowEdge[], source: string, target: string): boolean {
  if (source === target) return true;
  // Build adjacency over non-rework edges only.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if ((e.data?.kind as string | undefined) === "rework") continue;
    const arr = adj.get(e.source) ?? [];
    arr.push(e.target);
    adj.set(e.source, arr);
  }
  // Can `target` reach `source`? If so, the new source→target edge closes a loop.
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return false;
}

let edgeSeq = 0;
/** Allocate a globally-unique edge id (mirrors the editor's newNodeId pattern).
 *  Used by buildConnectionEdge so parallel success+failure edges between the same
 *  pair don't collide (KTD-3). */
export function newEdgeId(): string {
  edgeSeq += 1;
  return `e-${Date.now().toString(36)}-${edgeSeq}`;
}

let nodeSeq = 0;
/** Allocate a globally-unique node id (mirrors the editor's local newNodeId). The
 *  fragment-insert / graph-copy helpers (U8) remap every node id through this so
 *  inserted/copied subgraphs never collide with existing ids. */
export function newNodeId(): string {
  nodeSeq += 1;
  return `n-${Date.now().toString(36)}-${nodeSeq}`;
}

/** Result of attempting to build an edge from a React Flow connection. */
export type BuildConnectionResult =
  | { edge: FlowEdge }
  | { error: "missing-endpoint" | "duplicate" | "cycle" };

/** Construct a new success edge for a React Flow connection, reimplementing the
 *  sanity guards React Flow's addEdge provided (KTD-3) plus the author-time cycle
 *  guard (KTD-9). Returns an error tag instead of an edge when the connection is
 *  rejected so the caller can surface a toast:
 *    - missing-endpoint: source or target absent;
 *    - duplicate: an edge with the same source+target+condition already exists
 *      (parallel edges of a DIFFERENT condition between the same pair ARE allowed);
 *    - cycle: the connection would close a non-rework loop, and the endpoints are
 *      not both children of the same foreach template (intra-template rework
 *      cycles are authored separately and exempt).
 */
export function buildConnectionEdge(
  connection: { source?: string | null; target?: string | null },
  edges: FlowEdge[],
  nodes: FlowNode<WorkflowFlowNodeData>[],
): BuildConnectionResult {
  const source = connection.source ?? undefined;
  const target = connection.target ?? undefined;
  if (!source || !target) return { error: "missing-endpoint" };

  const srcNode = nodes.find((n) => n.id === source);
  const tgtNode = nodes.find((n) => n.id === target);

  // Existing conditions already authored between this exact pair.
  const existingConditions = new Set(
    edges
      .filter((e) => e.source === source && e.target === target)
      .map((e) => (e.data?.condition as string | undefined) ?? "success"),
  );

  // New edges are normally born "success". But a second connect gesture between a
  // pair that already has a success edge should author the *parallel* "failure"
  // edge (rather than being rejected as a duplicate), so users can build a
  // success/failure split with two connect gestures — but only when the source
  // kind actually exposes a condition select. Block only when both conditions
  // already exist (or the only available condition is already taken).
  const supportsConditions = edgeConditionEditability(srcNode?.data.kind) === "conditions";
  let condition = "success";
  if (existingConditions.has("success")) {
    if (supportsConditions && !existingConditions.has("failure")) {
      condition = "failure";
    } else {
      return { error: "duplicate" };
    }
  } else if (existingConditions.has(condition)) {
    return { error: "duplicate" };
  }

  // Cycle guard (KTD-9). Exempt connections where both endpoints are children of
  // the same foreach template — those may legitimately be rework cycles authored
  // separately; the simplest correct rule applies the guard only to non-template
  // connections.
  const bothTemplateChildren =
    !!srcNode?.parentId && srcNode.parentId === tgtNode?.parentId;
  if (!bothTemplateChildren && wouldCreateCycle(edges, source, target)) {
    return { error: "cycle" };
  }

  return {
    edge: {
      id: newEdgeId(),
      source,
      target,
      label: shortConditionLabel(condition),
      data: { condition, kind: undefined },
      className: edgeClassName(condition, false),
      interactionWidth: WF_EDGE_INTERACTION_WIDTH,
    },
  };
}

// ── Client-side validation (U10) ─────────────────────────────────────────────
//
// The server's parseWorkflowIr (run on PATCH) is the authority for structural
// errors (undefined-column references, seam-in-branch, duplicate column ids).
// These two helpers run client-side so the editor can render precise inline
// badges and block the save before a round-trip:
//   - composition violations attributed to the offending column band;
//   - unplaced-node errors attributed to the offending step node.
// They mirror @fusion/core's validateColumnTraits rules using the catalog flags
// (the catalog endpoint ships the same flags the registry validates against).

import type { TraitViolation } from "@fusion/core";
import type { TraitCatalogEntry } from "../api";

type CatalogFlags = TraitCatalogEntry["flags"];

function mergedFlags(
  traits: WorkflowIrColumn["traits"],
  catalog: Map<string, TraitCatalogEntry>,
): { flags: CatalogFlags; capacityTraitIds: string[]; unknown: string[] } {
  const flags: CatalogFlags = {};
  const capacityTraitIds: string[] = [];
  const unknown: string[] = [];
  for (const ct of traits) {
    const def = catalog.get(ct.trait);
    if (!def) {
      unknown.push(ct.trait);
      continue;
    }
    for (const [k, v] of Object.entries(def.flags)) {
      if (v) (flags as Record<string, boolean>)[k] = true;
    }
    if (def.flags.countsTowardWip) capacityTraitIds.push(def.id);
  }
  return { flags, capacityTraitIds, unknown };
}

/*
FNXC:CustomWorkflows 2026-06-16-22:30:
The workflow editor's client-side trait validator mirrors the server validator, including traitIds used to identify the exact composed traits behind blocking save errors.
*/
function traitIdsWithFlags(
  traits: WorkflowIrColumn["traits"],
  catalog: Map<string, TraitCatalogEntry>,
  names: Array<keyof CatalogFlags>,
): string[] {
  return traits
    .map((ct) => catalog.get(ct.trait))
    .filter((def): def is TraitCatalogEntry => !!def && names.some((name) => !!def.flags[name]))
    .map((def) => def.id);
}

/** Client mirror of core's validateColumnTraits, driven by the trait catalog. */
export function validateColumnsClient(
  columns: WorkflowIrColumn[],
  catalog: TraitCatalogEntry[],
): TraitViolation[] {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const violations: TraitViolation[] = [];
  let intakeCount = 0;

  for (const col of columns) {
    const { flags, capacityTraitIds, unknown } = mergedFlags(col.traits, byId);
    for (const u of unknown) {
      violations.push({
        code: "unknown-trait",
        severity: "error",
        columnId: col.id,
        traitIds: [u],
        message: `Column '${col.id}' references unknown trait '${u}'`,
      });
    }
    if (flags.complete && flags.countsTowardWip) {
      violations.push({
        code: "complete-with-wip",
        severity: "error",
        columnId: col.id,
        traitIds: traitIdsWithFlags(col.traits, byId, ["complete", "countsTowardWip"]),
        message: `Column '${col.name || col.id}' is both a completion column and counts toward WIP`,
      });
    }
    if (capacityTraitIds.length > 1) {
      violations.push({
        code: "two-capacity-traits",
        severity: "error",
        columnId: col.id,
        traitIds: capacityTraitIds,
        message: `Column '${col.name || col.id}' has more than one capacity (WIP) trait`,
      });
    }
    if (flags.complete && flags.intake) {
      violations.push({
        code: "complete-with-intake",
        severity: "error",
        columnId: col.id,
        traitIds: traitIdsWithFlags(col.traits, byId, ["complete", "intake"]),
        message: `Column '${col.name || col.id}' is both a completion column and an intake column`,
      });
    }
    if (flags.archived && flags.countsTowardWip) {
      violations.push({
        code: "archived-with-wip",
        severity: "error",
        columnId: col.id,
        traitIds: traitIdsWithFlags(col.traits, byId, ["archived", "countsTowardWip"]),
        message: `Column '${col.name || col.id}' is archived but counts toward WIP`,
      });
    }
    if (flags.intake) intakeCount += 1;
  }

  if (intakeCount > 1) {
    violations.push({
      code: "multiple-intake-columns",
      severity: "error",
      columnId: null,
      traitIds: [],
      message: `Workflow has ${intakeCount} intake columns; exactly one is allowed`,
    });
  }

  return violations;
}

/** Step node ids that are not placed in any column (v2 only). Bands and
 *  start/end are exempt — start/end are structural and need no column. */
export function unplacedNodeIds(
  nodes: FlowNode<WorkflowFlowNodeData>[],
  columns: WorkflowIrColumn[],
): string[] {
  if (columns.length === 0) return [];
  const ids: string[] = [];
  for (const node of nodes) {
    if (isColumnBandNode(node.id) || node.type === "group") continue;
    // foreach template children are placed by their parent group, not a column.
    if (node.parentId) continue;
    if (node.data.kind === "start" || node.data.kind === "end") continue;
    // A node is placed if it carries a valid column id, or if its y falls
    // strictly within a band's extent. A node parked outside every band with
    // no explicit column is unplaced (blocks save with an inline badge).
    const explicit = node.data.column;
    if (explicit && columns.some((c) => c.id === explicit)) continue;
    if (explicit && !columns.some((c) => c.id === explicit)) {
      ids.push(node.id);
      continue;
    }
    const byPosition = strictColumnForY(node.position.y, columns);
    if (!byPosition) ids.push(node.id);
  }
  return ids;
}

/** Extract the editor's working column list from a definition (v2 → its
 *  columns; v1 → empty, meaning "no custom columns authored yet"). */
export function columnsOf(def: WorkflowDefinition): WorkflowIrColumn[] {
  return isV2(def.ir) ? def.ir.columns.map((c) => ({ ...c, traits: [...c.traits] })) : [];
}

/** Extract the editor's working custom-field list from a definition (KTD-13).
 *  v2 with `fields` → a deep-ish copy; v1 or no fields → empty. */
export function fieldsOf(def: WorkflowDefinition): WorkflowFieldDefinition[] {
  const ir = def.ir as { fields?: WorkflowFieldDefinition[] };
  if (!isV2(def.ir) || !Array.isArray(ir.fields)) return [];
  return ir.fields.map((f) => ({
    ...f,
    options: f.options ? f.options.map((o) => ({ ...o })) : undefined,
    render: f.render ? { ...f.render } : undefined,
  }));
}

/** Extract the editor's working setting-declaration list from a definition (U6,
 *  KTD-1). v2 with `settings` → a deep-ish copy; v1 or no settings → empty.
 *  Setting VALUES are not carried here — they live per-`(workflowId, projectId)`
 *  in the workflow_settings table and are fetched separately (KTD-2). */
export function settingsOf(def: WorkflowDefinition): WorkflowSettingDefinition[] {
  const ir = def.ir as { settings?: WorkflowSettingDefinition[] };
  if (!isV2(def.ir) || !Array.isArray(ir.settings)) return [];
  return ir.settings.map((s) => ({
    ...s,
    options: s.options ? s.options.map((o) => ({ ...o })) : undefined,
    render: s.render ? { ...s.render } : undefined,
  }));
}

/** Seed graph for a brand-new workflow: start → end with room to insert steps. */
export function emptyWorkflowIr(name: string): WorkflowIr {
  return {
    version: "v1",
    name,
    nodes: [
      { id: "start", kind: "start" },
      { id: "end", kind: "end" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" }],
  };
}

export function emptyWorkflowLayout(): Record<string, { x: number; y: number }> {
  return { start: { x: 80, y: 140 }, end: { x: 460, y: 140 } };
}

// ── Fragment insertion + graph copy (U8, R7/R8) ──────────────────────────────
//
// Pure primitives for the template library: inserting a fragment subgraph into
// the live canvas (palette Templates section, U9) and copying a whole workflow
// graph with fresh ids (create-from-template picker, U4/R7). All three return
// new arrays/objects and never mutate their inputs.

/** Seam markers that participate in the duplicate-seam pre-validation. A canvas
 *  may host at most one node per seam, so inserting a fragment that carries a
 *  seam already present on the canvas is rejected. The editor maps the "merge"
 *  seam to its dedicated "merge" node kind, so a merge node counts as the merge
 *  seam even without an explicit config.seam. */
const SEAM_NAMES = new Set<string>(["execute", "review", "merge"]);

/** Read the seam marker a flow node represents, if any: an explicit
 *  config.seam, or the "merge" editor kind (which is the merge seam). */
function flowNodeSeam(node: FlowNode<WorkflowFlowNodeData>): string | undefined {
  if (node.data?.kind === "merge") return "merge";
  const seam = node.data?.config?.seam;
  return typeof seam === "string" ? seam : undefined;
}

/** Read the seam marker an IR node carries via its config.seam. */
function irNodeSeam(node: WorkflowIrNode): string | undefined {
  if ((node.kind as string) === "merge") return "merge";
  const seam = node.config?.seam;
  return typeof seam === "string" ? seam : undefined;
}

/**
 * Seam names (execute/review/merge) present in BOTH the fragment and the existing
 * canvas — i.e. seams that would be duplicated by inserting the fragment. An
 * empty result means the fragment is safe to insert. Other seam values
 * (planning, step-execute, …) are not pre-validated here (only the tracked
 * execute/review/merge seams are single-instance on the canvas).
 *
 * FNXC:WorkflowNodeEditor 2026-06-19-18:09:
 * Fragment insertion guards must not depend only on React Flow nodes, because the palette can render before the loaded workflow graph fully materializes under components-b shard load.
 * Union the transient canvas nodes with the authoritative active workflow IR so duplicate seam conflicts surface on desktop and mobile even during cold ReactFlow render timing.
 */
export function fragmentSeamConflicts(
  fragmentIr: WorkflowIr,
  nodes: FlowNode<WorkflowFlowNodeData>[],
  existingIr?: WorkflowIr,
): string[] {
  const canvasSeams = new Set<string>();
  for (const node of existingIr?.nodes ?? []) {
    const seam = irNodeSeam(node);
    if (seam && SEAM_NAMES.has(seam)) canvasSeams.add(seam);
  }
  for (const n of nodes) {
    const seam = flowNodeSeam(n);
    if (seam && SEAM_NAMES.has(seam)) canvasSeams.add(seam);
  }
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const node of fragmentIr.nodes) {
    const seam = irNodeSeam(node);
    if (seam && SEAM_NAMES.has(seam) && canvasSeams.has(seam) && !seen.has(seam)) {
      seen.add(seam);
      conflicts.push(seam);
    }
  }
  return conflicts;
}

/** Build a React Flow node from a single IR node at an absolute position — the
 *  same mapping irToFlow applies (kind→type via editorKind, data {kind,label,
 *  config}, deletable). Template group bodies are remapped by the caller; this
 *  carries config (including any template) through verbatim. */
function irNodeToFlowNode(
  node: WorkflowIrNode,
  id: string,
  position: { x: number; y: number },
): FlowNode<WorkflowFlowNodeData> {
  const kind = editorKind(node);
  return {
    id,
    type: kind,
    position,
    data: { kind, ...dataIrKind(node, kind), label: nodeLabel(node), config: { ...(node.config ?? {}) } },
    deletable: node.kind !== "start" && node.kind !== "end",
    zIndex: WF_STEP_NODE_Z_INDEX,
  };
}

/**
 * Insert a fragment subgraph into a flow graph near `position`.
 *
 * The fragment's `start`/`end` nodes (and every edge incident to them) are
 * stripped; each remaining fragment node id is remapped to a fresh newNodeId()
 * and the fragment's internal edges are rewired to those ids with fresh edge
 * ids, preserving condition/kind. Node config and kind are preserved. Inserted
 * nodes are laid out relative to `position` using the fragment's persisted
 * layout when present, else simple horizontal x-spacing.
 *
 * Returns NEW arrays plus the ids of the inserted (remapped) nodes; inputs are
 * never mutated.
 */
export function insertFragment(
  nodes: FlowNode<WorkflowFlowNodeData>[],
  edges: FlowEdge[],
  fragmentIr: WorkflowIr,
  position: { x: number; y: number },
  layout?: Record<string, { x: number; y: number }>,
): {
  nodes: FlowNode<WorkflowFlowNodeData>[];
  edges: FlowEdge[];
  insertedNodeIds: string[];
} {
  // Drop structural start/end; everything else is a real fragment node.
  const bodyNodes = fragmentIr.nodes.filter((n) => n.kind !== "start" && n.kind !== "end");
  const droppedIds = new Set(
    fragmentIr.nodes.filter((n) => n.kind === "start" || n.kind === "end").map((n) => n.id),
  );

  // Remap every surviving fragment id to a fresh id.
  const idMap = new Map<string, string>();
  for (const n of bodyNodes) idMap.set(n.id, newNodeId());

  // Anchor the fragment's layout origin so nodes land near `position`. When the
  // fragment ships layout, preserve relative offsets; otherwise space the nodes
  // horizontally.
  const placed = bodyNodes.map((node) => layout?.[node.id]).filter((p): p is { x: number; y: number } => !!p);
  const minX = placed.length ? Math.min(...placed.map((p) => p.x)) : 0;
  const minY = placed.length ? Math.min(...placed.map((p) => p.y)) : 0;

  const insertedNodeIds: string[] = [];
  // Template group children are expanded into parented child flow nodes (the
  // same way irToFlow does), so an inserted group round-trips its full template
  // through flowToIr instead of dropping config.template (which flowToIr would
  // otherwise rebuild as an empty template from the absent children).
  const childNodes: FlowNode<WorkflowFlowNodeData>[] = [];
  const childEdges: FlowEdge[] = [];
  const newNodes = bodyNodes.map((node, index): FlowNode<WorkflowFlowNodeData> => {
    const id = idMap.get(node.id)!;
    insertedNodeIds.push(id);
    const fromLayout = layout?.[node.id];
    const pos = fromLayout
      ? { x: position.x + (fromLayout.x - minX), y: position.y + (fromLayout.y - minY) }
      : { x: position.x + index * 180, y: position.y };
    const groupCfg = groupTemplateConfigOf(node);
    if (groupCfg) {
      const template = groupCfg.template;
      const groupKind = editorKind(node);
      template.nodes.forEach((inner, innerIdx) => {
        const innerKind = editorKind(inner);
        const childPos =
          layout?.[foreachChildFlowId(node.id, inner.id)] ?? {
            x: FOREACH_CHILD_X + innerIdx * FOREACH_CHILD_STEP_X,
            y: FOREACH_CHILD_Y,
          };
        childNodes.push({
          id: foreachChildFlowId(id, inner.id),
          type: innerKind,
          position: childPos,
          parentId: id,
          extent: "parent",
          data: { kind: innerKind, ...dataIrKind(inner, innerKind), label: nodeLabel(inner), config: { ...(inner.config ?? {}) } },
          deletable: true,
          zIndex: WF_STEP_NODE_Z_INDEX,
        });
      });
      template.edges.forEach((edge, eIdx) => {
        childEdges.push(irEdgeToFlow(edge, eIdx, `${id}${FOREACH_CHILD_SEP}`));
      });
      // The group node keeps everything except the template (children carry it).
      const { template: _t, ...restCfg } = (node.config ?? {}) as Record<string, unknown>;
      return {
        id,
        type: groupKind,
        position: pos,
        data: {
          kind: groupKind,
          ...dataIrKind(node, groupKind),
          label: nodeLabel(node),
          config: { ...restCfg },
          templateEmpty: template.nodes.length === 0,
        },
        style: { width: FOREACH_GROUP_WIDTH, height: FOREACH_GROUP_HEIGHT },
        deletable: true,
        zIndex: WF_BACKGROUND_GROUP_Z_INDEX,
      };
    }
    return irNodeToFlowNode(node, id, pos);
  });

  // Rewire only the fragment's INTERNAL edges (both endpoints survived). Edges
  // touching a stripped start/end node are dropped.
  const newEdges: FlowEdge[] = fragmentIr.edges
    .filter((e) => !droppedIds.has(e.from) && !droppedIds.has(e.to))
    .filter((e) => idMap.has(e.from) && idMap.has(e.to))
    .map((edge, index) => {
      const flow = irEdgeToFlow(edge, index);
      return {
        ...flow,
        id: newEdgeId(),
        source: idMap.get(edge.from)!,
        target: idMap.get(edge.to)!,
      };
    });

  return {
    // Group nodes (in newNodes) must precede their children (childNodes).
    nodes: [...nodes, ...newNodes, ...childNodes],
    edges: [...edges, ...newEdges, ...childEdges],
    insertedNodeIds,
  };
}

/** Remap a template group's internal node ids + edges to fresh ids. Returns a
 *  new template object; the original is untouched. Template-local ids are scoped
 *  to the template, so a fresh local id space suffices (and keeps config compact
 *  rather than reusing global ids). */
function copyGroupTemplate(
  template: { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] },
  innerMap: Map<string, string>,
): { nodes: WorkflowIrNode[]; edges: WorkflowIrEdge[] } {
  for (const n of template.nodes) innerMap.set(n.id, newNodeId());
  const nodes = template.nodes.map((n) => copyIrNode(n, innerMap.get(n.id)!));
  const edges = template.edges.map((e) => ({
    ...e,
    from: innerMap.get(e.from) ?? e.from,
    to: innerMap.get(e.to) ?? e.to,
  }));
  return { nodes, edges };
}

/** Deep-ish copy of an IR node under a new id, recursing into a template group
 *  template's internal node references so they remain self-consistent. When the
 *  node is a template group, its template-local id remap is recorded in `templateMaps`
 *  keyed by the node's ORIGINAL id, so the caller can remap namespaced
 *  `${groupId}::${templateNodeId}` layout keys consistently. */
function copyIrNode(
  node: WorkflowIrNode,
  newId: string,
  templateMaps?: Map<string, Map<string, string>>,
): WorkflowIrNode {
  const config = node.config ? { ...node.config } : undefined;
  const group = groupTemplateConfigOf(node);
  if (group && config) {
    const innerMap = new Map<string, string>();
    config.template = copyGroupTemplate(group.template, innerMap);
    templateMaps?.set(node.id, innerMap);
  }
  const copy: WorkflowIrNode = { id: newId, kind: node.kind };
  if (node.column !== undefined) copy.column = node.column;
  if (config) copy.config = config;
  return copy;
}

/**
 * Full-graph copy with fresh ids (R7): every top-level node id is remapped to a
 * fresh id, edges are rewired, and the layout map's keys are remapped to match.
 * v2 columns/fields/artifacts are preserved untouched (they hold no node id
 * references). Template group bodies have their internal node ids + edges
 * remapped consistently too. Returns a NEW ir + layout; inputs are not mutated.
 */
export function copyIrWithFreshIds(
  ir: WorkflowIr,
  layout: Record<string, { x: number; y: number }>,
): { ir: WorkflowIr; layout: Record<string, { x: number; y: number }> } {
  const idMap = new Map<string, string>();
  for (const n of ir.nodes) idMap.set(n.id, newNodeId());

  // Per template group (by ORIGINAL group id): its template-local id remap, so
  // namespaced layout keys `${groupId}::${templateNodeId}` can be remapped to
  // `${newGroupId}::${newTemplateNodeId}` consistently.
  const templateMaps = new Map<string, Map<string, string>>();
  const nodes = ir.nodes.map((n) => copyIrNode(n, idMap.get(n.id)!, templateMaps));
  const edges = ir.edges.map((e) => ({
    ...e,
    from: idMap.get(e.from) ?? e.from,
    to: idMap.get(e.to) ?? e.to,
  }));

  // Remap layout keys. Top-level node keys remap via idMap; namespaced foreach
  // child keys remap via the owning group's idMap entry + its inner map; any
  // unrelated keys pass through unchanged.
  const newLayout: Record<string, { x: number; y: number }> = {};
  for (const [key, pos] of Object.entries(layout)) {
    const sepIdx = key.indexOf(FOREACH_CHILD_SEP);
    if (sepIdx >= 0) {
      const groupId = key.slice(0, sepIdx);
      const innerId = key.slice(sepIdx + FOREACH_CHILD_SEP.length);
      const newGroupId = idMap.get(groupId);
      const innerMap = templateMaps.get(groupId);
      const newInnerId = innerMap?.get(innerId);
      if (newGroupId && newInnerId) {
        newLayout[foreachChildFlowId(newGroupId, newInnerId)] = { ...pos };
        continue;
      }
    }
    const mapped = idMap.get(key);
    newLayout[mapped ?? key] = { ...pos };
  }

  let copied: WorkflowIr;
  if (isV2(ir)) {
    const v2: WorkflowIrV2 = {
      ...ir,
      nodes,
      edges,
      columns: ir.columns.map((c) => ({ ...c, traits: c.traits.map((t) => ({ ...t })) })),
    };
    copied = v2;
  } else {
    copied = { ...ir, nodes, edges };
  }
  return { ir: copied, layout: newLayout };
}

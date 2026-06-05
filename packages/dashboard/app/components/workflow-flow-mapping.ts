import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import type {
  WorkflowIr,
  WorkflowIrV2,
  WorkflowIrColumn,
  WorkflowIrNode,
  WorkflowIrEdge,
  WorkflowDefinition,
  WorkflowFieldDefinition,
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
export const FOREACH_GROUP_WIDTH = 520;
export const FOREACH_GROUP_HEIGHT = 200;
export const FOREACH_CHILD_X = 30;
export const FOREACH_CHILD_Y = 56;
export const FOREACH_CHILD_STEP_X = 170;

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
/** React Flow node id for a column band group node. */
export const columnBandNodeId = (columnId: string): string => `__col__:${columnId}`;
export const isColumnBandNode = (id: string): boolean => id.startsWith("__col__:");
export const columnIdFromBandNode = (id: string): string => id.slice("__col__:".length);

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

/** Resolve the editor node "type" for an IR node (merge seam → "merge"). */
function editorKind(node: WorkflowIr["nodes"][number]): WorkflowEditorNodeKind {
  const seam = node.config?.seam;
  if (seam === "merge") return "merge";
  return node.kind;
}

function nodeLabel(node: WorkflowIr["nodes"][number]): string {
  const name = node.config?.name;
  if (typeof name === "string" && name.trim()) return name;
  if (node.config?.seam === "merge") return "Merge boundary";
  return node.id;
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
    // Bands sit behind step nodes so steps remain clickable/draggable.
    zIndex: -1,
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

/** Build a React Flow edge from an IR edge. Rework edges (KTD-5) carry kind so
 *  the editor renders them dashed in the accent color. */
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
    className: isRework ? "wf-edge-rework" : undefined,
    markerEnd: undefined,
  };
}

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

    const foreachCfg = foreachConfigOf(node);
    if (foreachCfg) {
      const template = foreachCfg.template;
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
          data: { kind: innerKind, label: nodeLabel(inner), config: { ...(inner.config ?? {}) } },
          deletable: true,
        });
      });
      template.edges.forEach((edge, eIdx) => {
        childEdges.push(irEdgeToFlow(edge, eIdx, `${node.id}${FOREACH_CHILD_SEP}`));
      });
      // Strip the template off the group node's own config (children carry it).
      const { template: _t, ...restCfg } = (node.config ?? {}) as Record<string, unknown>;
      return {
        id: node.id,
        type: "foreach",
        position: pos ?? { x: 80 + index * 180, y: fallbackY },
        data: {
          kind: "foreach",
          label: nodeLabel(node),
          config: { ...restCfg },
          column,
          templateEmpty: template.nodes.length === 0,
        },
        style: { width: FOREACH_GROUP_WIDTH, height: FOREACH_GROUP_HEIGHT },
        deletable: true,
      };
    }

    return {
      id: node.id,
      type: kind,
      position: pos ?? { x: 80 + index * 180, y: fallbackY },
      data: {
        kind,
        label: nodeLabel(node),
        config: { ...(node.config ?? {}) },
        column,
      },
      deletable: node.kind !== "start" && node.kind !== "end",
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
  const fallbackLabel = data.kind === "merge" ? "Merge boundary" : node.id;
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
  const groupIds = new Set(topNodes.filter((n) => n.data.kind === "foreach").map((n) => n.id));
  const hasFields = Array.isArray(fields) && fields.length > 0;
  // Fields are a v2-only declaration: a workflow with fields but no custom
  // columns still serializes as v2 (with the synthesized default columns).
  const v2 = (Array.isArray(columns) && columns.length > 0) || hasFields;
  const layout: Record<string, { x: number; y: number }> = {};

  /** Project one flow node (top-level or template child) into an IR node. */
  function toIrNode(node: FlowNode<WorkflowFlowNodeData>, localId: string): WorkflowIrNode {
    const data = node.data;
    const config = nodeConfig(node);
    if (data.kind === "merge") {
      return { id: localId, kind: "prompt", config: { ...(config ?? {}), seam: "merge" } };
    }
    if (data.kind === "foreach") {
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
        kind: "foreach",
        config: { ...baseCfg, template: { nodes: templateNodes, edges: templateEdges } },
      };
    }
    return {
      id: localId,
      kind: data.kind as WorkflowIrNode["kind"],
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
      columns: hasColumns ? columns!.map((c) => ({ id: c.id, name: c.name, traits: c.traits })) : [],
      nodes: irNodes,
      edges: irEdges,
    };
    if (hasFields) {
      // The IR's `fields` is typed against @fusion/core's concrete
      // WorkflowFieldDefinition; the editor carries the array through opaquely
      // and the server validator is the source of truth, so assign via unknown.
      (ir as { fields?: unknown }).fields = fields!.map((f) => ({ ...f }));
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
        traitIds: capacityTraitIds,
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
        traitIds: [],
        message: `Column '${col.name || col.id}' is both a completion column and an intake column`,
      });
    }
    if (flags.archived && flags.countsTowardWip) {
      violations.push({
        code: "archived-with-wip",
        severity: "error",
        columnId: col.id,
        traitIds: [],
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

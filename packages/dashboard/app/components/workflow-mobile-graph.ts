import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { WorkflowIrColumn } from "@fusion/core";
import type { WorkflowFlowNodeData } from "./nodes/WorkflowNodeTypes";
import {
  columnIdFromBandNode,
  isColumnBandNode,
  templateNodeIdFromChild,
} from "./workflow-flow-mapping";
import { nodeConfigSummary, type NodeSummaryCatalogs, type SummaryTranslate } from "./nodes/node-summary";

export interface MobileWorkflowEdgeSummary {
  id: string;
  source: string;
  target: string;
  targetLabel: string;
  label: string;
  kind?: string;
}

export interface MobileWorkflowConnectionTarget {
  id: string;
  label: string;
  kind: WorkflowFlowNodeData["kind"];
}

export interface MobileWorkflowNodeSummary {
  id: string;
  label: string;
  kind: WorkflowFlowNodeData["kind"];
  summary: string;
  columnName?: string;
  editable: boolean;
  parentId?: string;
  templateLocalId?: string;
  outgoing: MobileWorkflowEdgeSummary[];
  connectionTargets?: MobileWorkflowConnectionTarget[];
  children: MobileWorkflowNodeSummary[];
}

function edgeLabel(edge: FlowEdge): string {
  if (typeof edge.label === "string" && edge.label.trim()) return edge.label;
  return String(edge.data?.condition ?? "success");
}

function nodeDisplayLabel(node: FlowNode<WorkflowFlowNodeData>): string {
  return node.data.label || node.id;
}

function compareNodePosition(
  a: FlowNode<WorkflowFlowNodeData>,
  b: FlowNode<WorkflowFlowNodeData>,
): number {
  const ay = Math.round(a.position.y);
  const by = Math.round(b.position.y);
  if (ay !== by) return ay - by;
  return Math.round(a.position.x) - Math.round(b.position.x);
}

function isEditableWorkflowNode(node: FlowNode<WorkflowFlowNodeData>): boolean {
  return node.data.kind !== "start" && node.data.kind !== "end" && !isColumnBandNode(node.id);
}

function isSameReorderGroup(
  target: FlowNode<WorkflowFlowNodeData>,
  candidate: FlowNode<WorkflowFlowNodeData>,
): boolean {
  if (isColumnBandNode(candidate.id)) return false;
  if (target.parentId || candidate.parentId) return target.parentId === candidate.parentId;
  return target.data.column === candidate.data.column;
}

export type WorkflowNodeReorderDirection = "up" | "down";

/**
 * FNXC:WorkflowSimpleEditor 2026-06-17-02:55:
 * Simple-editor order is derived from React Flow positions through compareNodePosition, so move controls must swap sibling positions instead of inventing a second ordering field. Keep moves inside the same column group for top-level nodes and inside the same parent group for template children so the re-derived outline and persisted IR stay consistent with canvas placement.
 */
export function reorderWorkflowNode(
  nodes: FlowNode<WorkflowFlowNodeData>[],
  nodeId: string,
  direction: WorkflowNodeReorderDirection,
): FlowNode<WorkflowFlowNodeData>[] {
  const target = nodes.find((node) => node.id === nodeId);
  if (!target || !isEditableWorkflowNode(target)) return nodes;

  const siblings = nodes
    .filter((node) => isSameReorderGroup(target, node))
    .sort(compareNodePosition);
  const targetIndex = siblings.findIndex((node) => node.id === nodeId);
  const neighbor = siblings[targetIndex + (direction === "up" ? -1 : 1)];
  if (!neighbor || !isEditableWorkflowNode(neighbor)) return nodes;

  return nodes.map((node) => {
    if (node.id === target.id) return { ...node, position: { ...neighbor.position } };
    if (node.id === neighbor.id) return { ...node, position: { ...target.position } };
    return node;
  });
}

function buildColumnNameMap(columns: WorkflowIrColumn[], nodes: FlowNode<WorkflowFlowNodeData>[]) {
  const names = new Map(columns.map((column) => [column.id, column.name || column.id]));
  for (const node of nodes) {
    if (!isColumnBandNode(node.id)) continue;
    const id = columnIdFromBandNode(node.id);
    if (!names.has(id)) names.set(id, node.data.label || id);
  }
  return names;
}

export function buildMobileWorkflowGraph(
  nodes: FlowNode<WorkflowFlowNodeData>[],
  edges: FlowEdge[],
  columns: WorkflowIrColumn[] = [],
  catalogs: NodeSummaryCatalogs = {},
  t?: SummaryTranslate,
): MobileWorkflowNodeSummary[] {
  const columnNames = buildColumnNameMap(columns, nodes);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childNodesByParent = new Map<string, FlowNode<WorkflowFlowNodeData>[]>();
  const edgesBySource = new Map<string, FlowEdge[]>();

  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = childNodesByParent.get(node.parentId) ?? [];
    list.push(node);
    childNodesByParent.set(node.parentId, list);
  }

  for (const list of childNodesByParent.values()) {
    list.sort(compareNodePosition);
  }

  for (const edge of edges) {
    const list = edgesBySource.get(edge.source) ?? [];
    list.push(edge);
    edgesBySource.set(edge.source, list);
  }

  const summarizeEdge = (edge: FlowEdge): MobileWorkflowEdgeSummary => {
    const target = nodesById.get(edge.target);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      targetLabel: target ? nodeDisplayLabel(target) : edge.target,
      label: edgeLabel(edge),
      kind: typeof edge.data?.kind === "string" ? edge.data.kind : undefined,
    };
  };

  const summarizeNode = (node: FlowNode<WorkflowFlowNodeData>): MobileWorkflowNodeSummary => {
    const children = (childNodesByParent.get(node.id) ?? []).map(summarizeNode);
    const columnId = node.data.column;
    return {
      id: node.id,
      label: nodeDisplayLabel(node),
      kind: node.data.kind,
      summary: nodeConfigSummary(node.data, catalogs, t),
      columnName: columnId ? columnNames.get(columnId) ?? columnId : undefined,
      editable: node.data.kind !== "start" && node.data.kind !== "end" && !isColumnBandNode(node.id),
      parentId: node.parentId,
      templateLocalId: node.parentId ? templateNodeIdFromChild(node.parentId, node.id) : undefined,
      outgoing: (edgesBySource.get(node.id) ?? []).map(summarizeEdge),
      children,
    };
  };

  const topLevelNodes = nodes
    .filter((node) => !node.parentId && !isColumnBandNode(node.id))
    .sort(compareNodePosition);

  return topLevelNodes.map(summarizeNode);
}

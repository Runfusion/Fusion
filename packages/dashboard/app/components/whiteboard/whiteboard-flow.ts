import type { Edge, Node } from "@xyflow/react";
import type { WhiteboardDocument } from "@fusion/core";
export interface WhiteboardFlowData extends Record<string, unknown> { kind: "frame" | "text" | "junction"; label?: string; role?: string }
export interface WhiteboardFlowProjection { nodes: Node<WhiteboardFlowData>[]; edges: Edge[] }
/* FNXC:WhiteboardProjection 2026-09-10-05:42: React Flow is a disposable projection of the canonical document. Frame children use local positions and parentId; a multi-target relation produces one persisted junction node, one trunk, and stable branch edges without duplicating the relation. */
export function projectWhiteboardToFlow(document: WhiteboardDocument): WhiteboardFlowProjection {
  const nodes: Node<WhiteboardFlowData>[] = [
    ...document.frames.map((frame) => ({ id: frame.id, type: "group", position: { x: frame.x, y: frame.y }, style: { width: frame.width, height: frame.height }, data: { kind: "frame" as const, label: frame.title ?? frame.type } })),
    ...document.texts.map((text) => ({ id: text.id, type: "default", position: { x: text.x, y: text.y }, ...(text.frameId ? { parentId: text.frameId, extent: "parent" as const } : {}), style: { ...(text.width ? { width: text.width } : {}), ...(text.height ? { height: text.height } : {}) }, data: { kind: "text" as const, label: text.text, role: text.role } })),
  ];
  const edges: Edge[] = [];
  for (const relation of document.relations) {
    const junctionId = `junction:${relation.id}`;
    if (relation.branches.length > 1) {
      const junction = relation.junction ?? { x: 0, y: 0 };
      nodes.push({ id: junctionId, type: "default", position: junction, data: { kind: "junction", label: relation.annotation } });
      edges.push({ id: `trunk:${relation.id}`, source: relation.sourceId, target: junctionId, label: relation.annotation, data: { relationId: relation.id, segment: "trunk" } });
      for (const branch of relation.branches) edges.push({ id: branch.id, source: junctionId, target: branch.targetId, label: branch.annotation, data: { relationId: relation.id, branchId: branch.id, segment: "branch" } });
    } else { const branch = relation.branches[0]!; edges.push({ id: branch.id, source: relation.sourceId, target: branch.targetId, label: branch.annotation ?? relation.annotation, data: { relationId: relation.id, branchId: branch.id, segment: "branch" } }); }
  }
  return { nodes, edges };
}

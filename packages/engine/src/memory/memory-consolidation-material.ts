import { fileNodeId, recallContentHash, type GraphNode, type RecallAppendInput } from "@fusion/core";

export type MemoryConsolidationMaterial = { contentHash: string; append: RecallAppendInput; graphNodeIds: string[] };

/*
FNXC:MemoryAgent 2026-08-11-09:41:
This pure transformer may use graph types and fileNodeId but no graph I/O, settings, filesystem, or
database APIs. FNXC rationale is the deterministic 4a source; council/research capture and LLM
summaries belong to 4b, while fileNodeId preserves the graph's normalized ownership identity.
*/
export function deriveRecallMaterial(nodes: readonly GraphNode[], agentId: string): MemoryConsolidationMaterial[] {
  return nodes.filter((node) => node.kind === "rationale").flatMap((node) => {
    const area = node.attributes.fnxcArea ?? node.name;
    const stamp = node.attributes.fnxcStamp ?? "";
    const text = (node.attributes.fnxcText ?? "").trim();
    if (!text) return [];
    const content = `FNXC decision\nArea: ${area}\nStamp: ${stamp}\n${text}`;
    const graphNodeIds = [...new Set([node.id, fileNodeId(node.ownerPath)])].sort();
    const append: RecallAppendInput = { kind: "decision", content, source: { origin: "other", agentId }, tags: [area], graphNodeIds };
    return [{ contentHash: recallContentHash("decision", content), append, graphNodeIds, nodeId: node.id }];
  }).sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(({ nodeId: _nodeId, ...material }) => material);
}

import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

export type KnowledgeGraphNode = { id: string; kind: "file" | "module" | "symbol" | "doc-concept" | "rationale"; name: string; owner: "file" | "derived"; ownerPath: string; source: { path: string; line: number; column: number }; attributes: Record<string, string> };
export type KnowledgeGraphEdge = { id: string; kind: "contains" | "imports" | "re-exports" | "relates-to" | "rationale-supports"; from: string; to: string; provenance: "extracted" | "inferred"; owner: "file" | "derived"; ownerPath: string; source: { path: string; line: number; column: number }; attributes: Record<string, string> };
export type KnowledgeGraphNeighbor = { node: KnowledgeGraphNode; distance: number; edges: KnowledgeGraphEdge[] };
export type KnowledgeGraphNodeQuery = { kinds?: string[]; pathPrefix?: string; idPrefix?: string; namePattern?: string; fnxcArea?: string; symbolKind?: string; owner?: string; limit?: number; offset?: number };
export type KnowledgeGraphStatus = { available: boolean; recoveryReason?: string | null; graphDir?: string; nodeCount?: number; edgeCount?: number; nodeKindCounts?: Record<string, number>; edgeKindCounts?: Record<string, number>; provenanceCounts?: Record<string, number>; ownerCounts?: Record<string, number>; fnxcAreas?: string[]; pathLimits: { defaultMaxHops: number; maxHops: number; maxExpansions: number } };
export type KnowledgeGraphPathResult =
  | { outcome: "found"; path: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }; hops: number; maxHops: number; expansions: number; truncated: false }
  | { outcome: "not-found"; path: null; maxHops: number; expansions: number; truncated: false }
  | { outcome: "limit-reached"; path: null; maxHops: number; expansions: number; truncated: true; limit: "max-hops" | "max-expansions" };

function query(params: Record<string, string | number | string[] | undefined>): string {
  const entries = Object.entries(params).flatMap(([key, value]) => Array.isArray(value) ? value.filter(Boolean).map(item => [key, item] as const) : value === undefined || value === "" ? [] : [[key, String(value)] as const]);
  return entries.length ? `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}` : "";
}
export function fetchKnowledgeGraphStatus(projectId?: string): Promise<KnowledgeGraphStatus> { return api(withProjectId("/knowledge/graph/status", projectId)); }
export function queryKnowledgeGraphNodes(projectId: string | undefined, filters: KnowledgeGraphNodeQuery = {}): Promise<{ nodes: KnowledgeGraphNode[]; total: number; limit: number; offset: number }> { return api(withProjectId(`/knowledge/graph/nodes${query(filters)}`, projectId)); }
export function fetchKnowledgeGraphNode(projectId: string | undefined, id: string): Promise<{ node: KnowledgeGraphNode; outgoing: KnowledgeGraphEdge[]; incoming: KnowledgeGraphEdge[]; outgoingTotal: number; incomingTotal: number }> { return api(withProjectId(`/knowledge/graph/node${query({ id })}`, projectId)); }
export function fetchKnowledgeGraphNeighbors(projectId: string | undefined, options: { nodeId: string; direction?: "out" | "in" | "both"; edgeKinds?: string[]; depth?: number; limit?: number }): Promise<{ neighbors: KnowledgeGraphNeighbor[]; total: number }> { return api(withProjectId(`/knowledge/graph/neighbors${query(options)}`, projectId)); }
export function fetchKnowledgeGraphPath(projectId: string | undefined, options: { fromId: string; toId: string; maxHops?: number }): Promise<KnowledgeGraphPathResult> { return api(withProjectId(`/knowledge/graph/path${query(options)}`, projectId)); }
export function buildKnowledgeGraphArtifacts(projectId?: string, force = false): Promise<{ changed: boolean; nodes: number; edges: number; stats: Record<string, unknown> }> { return api(withProjectId("/knowledge/graph/build", projectId), { method: "POST", body: JSON.stringify({ force }) }); }

import {
  KnowledgeGraphError,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type GraphOwner,
  type KnowledgeGraph,
  type SymbolKind,
} from "./graph-types.js";

export interface NodeFilter {
  kinds?: GraphNode["kind"][];
  pathPrefix?: string;
  idPrefix?: string;
  namePattern?: string | RegExp;
  fnxcArea?: string;
  symbolKind?: SymbolKind;
  owner?: GraphOwner;
  limit?: number;
}

export interface NeighborOptions {
  direction?: "out" | "in" | "both";
  edgeKinds?: EdgeKind[];
  depth?: number;
}

export interface NeighborResult {
  node: GraphNode;
  distance: number;
  /** Every connecting edge is retained so callers can inspect provenance and source anchors. */
  edges: GraphEdge[];
}

type Adjacency = { nodes: Map<string, GraphNode>; out: Map<string, GraphEdge[]>; in: Map<string, GraphEdge[]> };
const adjacencyCache = new WeakMap<KnowledgeGraph, Adjacency>();

/** Build the deterministic adjacency index once per graph rather than scanning all edges per hop. */
function adjacency(graph: KnowledgeGraph): Adjacency {
  const cached = adjacencyCache.get(graph);
  if (cached) return cached;
  const index: Adjacency = { nodes: new Map(graph.nodes.map(node => [node.id, node])), out: new Map(), in: new Map() };
  for (const edge of [...graph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    const out = index.out.get(edge.from) ?? [];
    out.push(edge);
    index.out.set(edge.from, out);
    const incoming = index.in.get(edge.to) ?? [];
    incoming.push(edge);
    index.in.set(edge.to, incoming);
  }
  adjacencyCache.set(graph, index);
  return index;
}

export function queryNodes(graph: KnowledgeGraph, filter: NodeFilter = {}): GraphNode[] {
  const pattern = typeof filter.namePattern === "string" ? new RegExp(filter.namePattern, "i") : filter.namePattern;
  return graph.nodes
    .filter(node => (!filter.kinds || filter.kinds.includes(node.kind))
      && (!filter.pathPrefix || node.ownerPath.startsWith(filter.pathPrefix))
      && (!filter.idPrefix || node.id.startsWith(filter.idPrefix))
      && (!pattern || (pattern.lastIndex = 0, pattern.test(node.name)))
      && (!filter.fnxcArea || node.attributes.fnxcArea === filter.fnxcArea)
      && (!filter.symbolKind || node.attributes.symbolKind === filter.symbolKind)
      && (!filter.owner || node.owner === filter.owner))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, filter.limit);
}

/**
 * FNXC:KnowledgeGraph 2026-08-10-10:53:
 * Query results expose complete edges so downstream recall and MCP layers can distinguish parser
 * extracted structure from the inferred provenance reserved for the memory agent.
 */
export function neighbors(graph: KnowledgeGraph, nodeId: string, options: NeighborOptions = {}): NeighborResult[] {
  const index = adjacency(graph);
  const direction = options.direction ?? "out";
  const maximumDepth = Math.max(0, options.depth ?? 1);
  const visited = new Set([nodeId]);
  const queue: Array<{ id: string; distance: number }> = [{ id: nodeId, distance: 0 }];
  const results = new Map<string, NeighborResult>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.distance >= maximumDepth) continue;
    const candidates = [
      ...(direction === "in" ? [] : index.out.get(current.id) ?? []),
      ...(direction === "out" ? [] : index.in.get(current.id) ?? []),
    ].filter(edge => !options.edgeKinds || options.edgeKinds.includes(edge.kind)).sort((left, right) => left.id.localeCompare(right.id));
    for (const edge of candidates) {
      const next = edge.from === current.id ? edge.to : edge.from;
      const node = index.nodes.get(next);
      if (!node) continue;
      const existing = results.get(next);
      if (existing && existing.distance === current.distance + 1) existing.edges.push(edge);
      if (visited.has(next)) continue;
      visited.add(next);
      results.set(next, { node, distance: current.distance + 1, edges: [edge] });
      queue.push({ id: next, distance: current.distance + 1 });
    }
  }
  return [...results.values()]
    .map(result => ({ ...result, edges: result.edges.sort((left, right) => left.id.localeCompare(right.id)) }))
    .sort((left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id));
}

export function shortestPath(graph: KnowledgeGraph, fromId: string, toId: string): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
  const index = adjacency(graph);
  if (!index.nodes.has(fromId) || !index.nodes.has(toId)) throw new KnowledgeGraphError("Unknown graph node");
  if (fromId === toId) return { nodes: [index.nodes.get(fromId)!], edges: [] };
  const queue: Array<{ id: string; nodes: string[]; edges: GraphEdge[] }> = [{ id: fromId, nodes: [fromId], edges: [] }];
  const visited = new Set([fromId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const candidates = [...(index.out.get(current.id) ?? []), ...(index.in.get(current.id) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    for (const edge of candidates) {
      const next = edge.from === current.id ? edge.to : edge.from;
      if (visited.has(next) || !index.nodes.has(next)) continue;
      const nodeIds = [...current.nodes, next];
      const edges = [...current.edges, edge];
      if (next === toId) return { nodes: nodeIds.map(id => index.nodes.get(id)!), edges };
      visited.add(next);
      queue.push({ id: next, nodes: nodeIds, edges });
    }
  }
  return null;
}

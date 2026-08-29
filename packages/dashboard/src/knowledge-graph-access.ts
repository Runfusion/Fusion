import { stat } from "node:fs/promises";
import {
  buildKnowledgeGraph,
  KnowledgeGraphError,
  loadArtifacts,
  resolveKnowledgeGraphDir,
  type ArtifactLoadResult,
  type GraphEdge,
  type GraphNode,
  type KnowledgeGraph,
  type TaskStore,
} from "@fusion/core";

export const KNOWLEDGE_GRAPH_PATH_MAX_HOPS = 10;
export const KNOWLEDGE_GRAPH_PATH_DEFAULT_HOPS = 6;
export const KNOWLEDGE_GRAPH_PATH_MAX_EXPANSIONS = 20_000;
const CACHE_SIZE = 4;

type CacheEntry = {
  result: ArtifactLoadResult;
  manifestMtimeMs: number | undefined;
  manifestSize: number | undefined;
};
const cache = new Map<string, CacheEntry>();
const rebuilds = new Map<string, Promise<RebuildKnowledgeGraphResult>>();

export type BoundedPathResult =
  | { outcome: "found"; path: { nodes: GraphNode[]; edges: GraphEdge[] }; hops: number; maxHops: number; expansions: number; truncated: false }
  | { outcome: "not-found"; path: null; maxHops: number; expansions: number; truncated: false }
  | { outcome: "limit-reached"; path: null; maxHops: number; expansions: number; truncated: true; limit: "max-hops" | "max-expansions" };

export type RebuildKnowledgeGraphResult = {
  changed: boolean;
  nodes: number;
  edges: number;
  stats: Awaited<ReturnType<typeof buildKnowledgeGraph>>["stats"];
};

async function manifestSignature(graphDir: string): Promise<{ manifestMtimeMs: number | undefined; manifestSize: number | undefined }> {
  try {
    const manifest = await stat(`${graphDir}/manifest.json`);
    return { manifestMtimeMs: manifest.mtimeMs, manifestSize: manifest.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { manifestMtimeMs: undefined, manifestSize: undefined };
    throw error;
  }
}

/** Resolve only inside the project root, honoring a project's graph-directory setting. */
export async function resolveProjectGraphDir(store: TaskStore): Promise<string> {
  const settings = await store.getSettings();
  return resolveKnowledgeGraphDir(store.getRootDir(), settings.knowledgeGraphDir);
}

/*
FNXC:KnowledgeGraphDashboard 2026-08-13-22:45:
Knowledge-graph artifacts can be multi-megabyte (including this repository's large edge set), so
read endpoints reuse a manifest-validated LRU cache and never rebuild on a read. Rebuilding remains
an explicit operator operation because it walks and parses the project.
*/
export async function loadProjectKnowledgeGraph(graphDir: string): Promise<ArtifactLoadResult> {
  const signature = await manifestSignature(graphDir);
  const existing = cache.get(graphDir);
  if (existing && existing.manifestMtimeMs === signature.manifestMtimeMs && existing.manifestSize === signature.manifestSize) {
    cache.delete(graphDir);
    cache.set(graphDir, existing);
    return existing.result;
  }
  const result = await loadArtifacts(graphDir);
  cache.set(graphDir, { result, ...signature });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return result;
}

export function invalidateKnowledgeGraphCache(graphDir?: string): void {
  if (graphDir) cache.delete(graphDir);
  else cache.clear();
}

export function __resetKnowledgeGraphCacheForTests(): void {
  cache.clear();
  rebuilds.clear();
}

export async function rebuildProjectKnowledgeGraph(store: TaskStore, options: { force?: boolean } = {}): Promise<RebuildKnowledgeGraphResult> {
  const graphDir = await resolveProjectGraphDir(store);
  const active = rebuilds.get(graphDir);
  if (active) return active;
  const rebuild = (async () => {
    const built = await buildKnowledgeGraph({ projectRoot: store.getRootDir(), graphDir, force: options.force });
    invalidateKnowledgeGraphCache(graphDir);
    return { changed: built.changed, nodes: built.graph.nodes.length, edges: built.graph.edges.length, stats: built.stats };
  })();
  rebuilds.set(graphDir, rebuild);
  try { return await rebuild; } finally { rebuilds.delete(graphDir); }
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : fallback;
}

/*
FNXC:KnowledgeGraphDashboard 2026-08-13-22:45:
The dashboard cannot use core shortestPath directly: unbounded BFS over a large edge set can walk a
whole disconnected component and make the response scale with graph diameter. This bounded search
uses back-pointers and reports limit-reached separately from not-found, so an incomplete search is
never presented as proof that no path exists.
*/
export function findBoundedShortestPath(
  graph: KnowledgeGraph,
  fromId: string,
  toId: string,
  options: { maxHops?: number; maxExpansions?: number } = {},
): BoundedPathResult {
  const maxHops = clampInteger(options.maxHops, KNOWLEDGE_GRAPH_PATH_DEFAULT_HOPS, 1, KNOWLEDGE_GRAPH_PATH_MAX_HOPS);
  const maxExpansions = clampInteger(options.maxExpansions, KNOWLEDGE_GRAPH_PATH_MAX_EXPANSIONS, 1, KNOWLEDGE_GRAPH_PATH_MAX_EXPANSIONS);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (!nodes.has(fromId) || !nodes.has(toId)) throw new KnowledgeGraphError("Unknown graph node");
  if (fromId === toId) return { outcome: "found", path: { nodes: [nodes.get(fromId)!], edges: [] }, hops: 0, maxHops, expansions: 0, truncated: false };

  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of [...graph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge]);
  }
  const queue: Array<{ id: string; depth: number }> = [{ id: fromId, depth: 0 }];
  const previous = new Map<string, { id: string; edge: GraphEdge }>();
  const visited = new Set([fromId]);
  let expansions = 0;
  let cursor = 0;
  while (cursor < queue.length) {
    if (expansions >= maxExpansions) return { outcome: "limit-reached", path: null, maxHops, expansions, truncated: true, limit: "max-expansions" };
    const current = queue[cursor++]!;
    expansions++;
    const candidates = adjacency.get(current.id) ?? [];
    let deferredByHops = false;
    for (const edge of candidates) {
      const next = edge.from === current.id ? edge.to : edge.from;
      if (visited.has(next) || !nodes.has(next)) continue;
      if (current.depth >= maxHops) { deferredByHops = true; continue; }
      previous.set(next, { id: current.id, edge });
      if (next === toId) {
        const pathNodes: GraphNode[] = [nodes.get(toId)!];
        const pathEdges: GraphEdge[] = [];
        let id = toId;
        while (id !== fromId) {
          const step = previous.get(id)!;
          pathEdges.unshift(step.edge);
          id = step.id;
          pathNodes.unshift(nodes.get(id)!);
        }
        return { outcome: "found", path: { nodes: pathNodes, edges: pathEdges }, hops: pathEdges.length, maxHops, expansions, truncated: false };
      }
      visited.add(next);
      queue.push({ id: next, depth: current.depth + 1 });
    }
    if (deferredByHops) return { outcome: "limit-reached", path: null, maxHops, expansions, truncated: true, limit: "max-hops" };
  }
  return { outcome: "not-found", path: null, maxHops, expansions, truncated: false };
}

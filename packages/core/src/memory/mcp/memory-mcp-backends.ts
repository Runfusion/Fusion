import { appendRecall, searchRecall, type RecallAppendInput } from "../recall/index.js";
import { loadArtifacts, resolveKnowledgeGraphDir } from "../../knowledge-graph/graph-store.js";
import { neighbors, queryNodes, shortestPath } from "../../knowledge-graph/graph-query.js";
import type { KnowledgeGraph } from "../../knowledge-graph/graph-types.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";

export interface MemoryMcpBackends {
  graphQuery(args: Record<string, unknown>): Promise<unknown[]>;
  graphNeighbors(args: Record<string, unknown>): Promise<unknown[]>;
  graphShortestPath(args: Record<string, unknown>): Promise<unknown[]>;
  recallSearch(args: Record<string, unknown>): Promise<unknown[]>;
  recallAppend(args: Record<string, unknown>): Promise<unknown[]>;
}

async function graphAt(projectRoot: string): Promise<KnowledgeGraph> {
  const loaded = await loadArtifacts(resolveKnowledgeGraphDir(projectRoot));
  if (!loaded.ok) throw new Error("Knowledge graph artifact is unavailable");
  return loaded.graph;
}

/** Thin adapter only: graph and recall persistence remain owned by their respective memory layers. */
export function createMemoryMcpBackends(projectRoot: string, layer: AsyncDataLayer | null): MemoryMcpBackends {
  return {
    async graphQuery(args) { return queryNodes(await graphAt(projectRoot), (args.filter as never) ?? {}); },
    async graphNeighbors(args) { return neighbors(await graphAt(projectRoot), String(args.nodeId), { direction: args.direction as never, edgeKinds: args.edgeKinds as never, depth: args.depth as number | undefined }); },
    async graphShortestPath(args) { const path = shortestPath(await graphAt(projectRoot), String(args.fromId), String(args.toId)); return path ? [path] : []; },
    async recallSearch(args) {
      if (!layer) throw new Error("Recall store is unavailable");
      const result = await searchRecall(layer, String(args.query), { kinds: args.kinds as never, tags: args.tags as never, limit: args.limit as number | undefined });
      return result.hits;
    },
    async recallAppend(args) {
      if (!layer) throw new Error("Recall store is unavailable");
      const result = await appendRecall(layer, { kind: args.kind as RecallAppendInput["kind"], content: String(args.content), source: args.source as RecallAppendInput["source"], tags: args.tags as string[] | undefined, graphNodeIds: args.graphNodeIds as string[] | undefined });
      if (result.status === "duplicate") throw new Error("Recall was rejected as a near duplicate");
      return [result.record];
    },
  };
}

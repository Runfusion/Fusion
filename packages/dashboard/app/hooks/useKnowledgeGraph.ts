import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildKnowledgeGraphArtifacts,
  fetchKnowledgeGraphNeighbors,
  fetchKnowledgeGraphNode,
  fetchKnowledgeGraphPath,
  fetchKnowledgeGraphStatus,
  queryKnowledgeGraphNodes,
  type KnowledgeGraphNodeQuery,
  type KnowledgeGraphPathResult,
} from "../api/system/knowledge-graph.js";

const EMPTY_FILTERS: KnowledgeGraphNodeQuery = { limit: 50, offset: 0 };
type NeighborOptions = { direction: "out" | "in" | "both"; edgeKinds?: string[]; depth: number };

/*
FNXC:KnowledgeGraphDashboard 2026-08-13-23:30:
Graph state is isolated and enabled only by the active tab, so Memory's existing tabs never parse or request the multi-megabyte graph artifacts. Request sequence fences retain the latest operator intent when debounced searches, node drills, or path requests resolve out of order.
*/
export function useKnowledgeGraph({ projectId, enabled }: { projectId?: string; enabled: boolean }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof fetchKnowledgeGraphStatus>> | null>(null);
  const [filters, setFilters] = useState<KnowledgeGraphNodeQuery>(EMPTY_FILTERS);
  const [nodes, setNodes] = useState<Awaited<ReturnType<typeof queryKnowledgeGraphNodes>> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchKnowledgeGraphNode>> | null>(null);
  const [neighborOptions, setNeighborOptions] = useState<NeighborOptions>({ direction: "both", depth: 1 });
  const [neighborResults, setNeighborResults] = useState<Awaited<ReturnType<typeof fetchKnowledgeGraphNeighbors>> | null>(null);
  const [pathInput, setPathInput] = useState({ fromId: "", toId: "", maxHops: 6 });
  const [pathResult, setPathResult] = useState<KnowledgeGraphPathResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSequence = useRef(0);
  const detailSequence = useRef(0);
  const pathSequence = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      const value = await fetchKnowledgeGraphStatus(projectId);
      setStatus(value);
      setPathInput((input) => ({ ...input, maxHops: value.pathLimits.defaultMaxHops }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [projectId]);

  useEffect(() => { if (enabled) void refreshStatus(); }, [enabled, refreshStatus]);
  useEffect(() => {
    if (!enabled || !status?.available) return;
    const current = ++searchSequence.current;
    setLoading(true);
    const timer = window.setTimeout(() => void queryKnowledgeGraphNodes(projectId, filters)
      .then((value) => { if (current === searchSequence.current) setNodes(value); })
      .catch((reason) => { if (current === searchSequence.current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (current === searchSequence.current) setLoading(false); }), 250);
    return () => window.clearTimeout(timer);
  }, [enabled, filters, projectId, status?.available]);

  const refreshNeighbors = useCallback(async (id = selectedId) => {
    if (!id) return;
    const current = ++detailSequence.current;
    try {
      const value = await fetchKnowledgeGraphNeighbors(projectId, { nodeId: id, ...neighborOptions });
      if (current === detailSequence.current) setNeighborResults(value);
    } catch (reason) { if (current === detailSequence.current) setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [neighborOptions, projectId, selectedId]);

  const selectNode = useCallback(async (id: string) => {
    const current = ++detailSequence.current;
    setSelectedId(id);
    try {
      const [node, neighborValue] = await Promise.all([
        fetchKnowledgeGraphNode(projectId, id),
        fetchKnowledgeGraphNeighbors(projectId, { nodeId: id, ...neighborOptions }),
      ]);
      if (current === detailSequence.current) { setDetail(node); setNeighborResults(neighborValue); }
    } catch (reason) { if (current === detailSequence.current) setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [neighborOptions, projectId]);

  const findPath = useCallback(async () => {
    const current = ++pathSequence.current;
    setPathResult(null); setError(null);
    try {
      const result = await fetchKnowledgeGraphPath(projectId, pathInput);
      if (current === pathSequence.current) setPathResult(result);
    } catch (reason) { if (current === pathSequence.current) setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [pathInput, projectId]);
  const rebuild = useCallback(async (force = false) => {
    setRebuilding(true);
    try { await buildKnowledgeGraphArtifacts(projectId, force); await refreshStatus(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRebuilding(false); }
  }, [projectId, refreshStatus]);

  return { status, filters, setFilters, nodes, loading, selectedId, detail, selectNode, neighborOptions, setNeighborOptions, neighborResults, refreshNeighbors, pathInput, setPathInput, pathResult, findPath, rebuild, rebuilding, refreshStatus, error, clearFilters: () => setFilters(EMPTY_FILTERS) };
}

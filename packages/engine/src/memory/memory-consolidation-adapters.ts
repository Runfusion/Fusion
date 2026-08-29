import { addInferredEdges, buildKnowledgeGraph, mergeRecallGraphNodeIds, appendRecall, resolveKnowledgeGraphDir, type KnowledgeGraph, type Settings } from "@fusion/core";
import { relative, resolve, sep } from "node:path";
import type { MemoryConsolidationPorts } from "./memory-consolidation.js";
import { runMemorySemanticsPass } from "./memory-semantics.js";

export type MemoryConsolidationUnavailableReason = "no-data-layer" | "no-project-id" | "no-root-dir" | "knowledge-graph-dir-unresolved";
export type MemoryConsolidationPortsResolution = { status: "ready"; projectId: string; ports: MemoryConsolidationPorts } | { status: "unavailable"; reason: MemoryConsolidationUnavailableReason };
type Deps = { taskStore: { getAsyncLayer?: () => unknown; getSettings?: () => Promise<Settings> }; rootDir: string; agentId: string; settings?: Settings };

/* FNXC:MemoryAgent 2026-08-11-09:41: This is the only memory module binding graph I/O and project configuration. Missing collaborators are successful skips, not heartbeat failures; a blank graph directory uses FN-8921's default, while .fusion is rejected because graph artifacts are committable. */
export async function resolveMemoryConsolidationPorts(deps: Deps): Promise<MemoryConsolidationPortsResolution> {
  if (!deps.rootDir) return { status: "unavailable", reason: "no-root-dir" };
  if (typeof deps.taskStore.getAsyncLayer !== "function") return { status: "unavailable", reason: "no-data-layer" };
  const layer = deps.taskStore.getAsyncLayer() as { projectId?: string } | null | undefined;
  if (!layer) return { status: "unavailable", reason: "no-data-layer" };
  if (!layer.projectId) return { status: "unavailable", reason: "no-project-id" };
  let settings = deps.settings;
  if (!settings && typeof deps.taskStore.getSettings === "function") { try { settings = await deps.taskStore.getSettings(); } catch { /* default directory remains valid */ } }
  let graphDir: string;
  try { graphDir = resolveKnowledgeGraphDir(deps.rootDir, settings?.knowledgeGraphDir); } catch { return { status: "unavailable", reason: "knowledge-graph-dir-unresolved" }; }
  const fusionDir = resolve(deps.rootDir, ".fusion"); const rel = relative(fusionDir, graphDir);
  /* FNXC:MemoryAgent 2026-08-11-10:17: Graph artifacts are committable, so the exact .fusion directory is forbidden alongside all of its children. */
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`${sep}..${sep}`))) return { status: "unavailable", reason: "knowledge-graph-dir-unresolved" };
  let latestGraph: KnowledgeGraph | undefined;
  return { status: "ready", projectId: layer.projectId, ports: {
    refreshGraph: async () => { const result = await buildKnowledgeGraph({ projectRoot: deps.rootDir, graphDir, force: false }); latestGraph = result.graph; return { rationaleNodes: result.graph.nodes.filter((node) => node.kind === "rationale"), nodeCount: result.graph.nodes.length, edgeCount: result.graph.edges.length, changed: result.changed, recoveryReason: result.stats.recoveryReason, stats: { parsedFiles: result.stats.parsedFiles, reusedFiles: result.stats.reusedFiles, prunedFiles: result.stats.prunedFiles } }; },
    runSemantics: async (graphChanged) => {
      if (!latestGraph) return { skipped: "graph-unavailable" };
      const result = await runMemorySemanticsPass({ graph: latestGraph, graphChanged, taskStore: deps.taskStore as never, agentId: deps.agentId, rootDir: deps.rootDir, write: async (proposals) => {
        const written = await addInferredEdges(graphDir, proposals);
        return {
          written: written.added,
          deduped: written.deduped,
          droppedUnresolved: written.droppedUnresolved,
        };
      } });
      return result;
    },
    appendRecall: (input) => appendRecall(layer as never, input),
    mergeRecallGraphNodeIds: (id, ids) => mergeRecallGraphNodeIds(layer as never, id, ids),
    clock: Date.now,
  } };
}

import { ApiError } from "../api-error.js";
import {
  queryKnowledgePagesAsync,
  countKnowledgePagesAsync,
  refreshKnowledgeForTask,
  KNOWLEDGE_QUERY_DEFAULT_LIMIT,
  KNOWLEDGE_QUERY_MAX_LIMIT,
  type KnowledgeSourceKind,
} from "../knowledge-index.js";
import type { ApiRouteRegistrar } from "./types.js";
import { requireAsyncLayer } from "../require-async-layer.js";
import { relative } from "node:path";
import {
  KnowledgeGraphError,
  neighbors,
  queryNodes,
  type EdgeKind,
  type GraphNodeKind,
  type GraphOwner,
  type SymbolKind,
} from "@fusion/core";
import {
  findBoundedShortestPath,
  KNOWLEDGE_GRAPH_PATH_DEFAULT_HOPS,
  KNOWLEDGE_GRAPH_PATH_MAX_EXPANSIONS,
  KNOWLEDGE_GRAPH_PATH_MAX_HOPS,
  loadProjectKnowledgeGraph,
  rebuildProjectKnowledgeGraph,
  resolveProjectGraphDir,
} from "../knowledge-graph-access.js";

/**
 * Persistent knowledge-index API (U14).
 *
 * Thin HTTP adapter over the keyword index in `knowledge-index.ts`. Downstream
 * agents call `GET /api/knowledge/query` to recall task/PR history.
 *
 * Security (same contract as U9 — `register-command-center-routes.ts`):
 *  - Every route inherits the dashboard's standard session/auth middleware via
 *    the {@link ApiRouteRegistrar} contract, so an unauthenticated request is
 *    rejected with 401 by the server-level auth middleware before reaching these
 *    handlers. No knowledge endpoint is unauthenticated.
 *  - Every endpoint resolves the database through `getScopedStore(req)` before
 *    reading/writing, so a project-A caller can never read project-B pages. The
 *    index holds sensitive repo/commit/PR content, so it is an information-
 *    disclosure surface, not an open endpoint.
 */

const VALID_SOURCE_KINDS: ReadonlySet<string> = new Set<KnowledgeSourceKind>(["task", "pr"]);
const KNOWLEDGE_GRAPH_NODE_PAGE_MAX = 200;
const KNOWLEDGE_GRAPH_EDGE_PAGE_MAX = 200;
const GRAPH_NODE_KINDS = new Set<GraphNodeKind>(["file", "module", "symbol", "doc-concept", "rationale"]);
const GRAPH_EDGE_KINDS = new Set<EdgeKind>(["contains", "imports", "re-exports", "relates-to", "rationale-supports"]);
const GRAPH_SYMBOL_KINDS = new Set<SymbolKind>(["function", "class", "interface", "type-alias", "enum", "variable", "namespace", "alias"]);
const GRAPH_OWNERS = new Set<GraphOwner>(["file", "derived"]);

function queryValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => typeof item === "string" ? item.split(",") : []).map(item => item.trim()).filter(Boolean);
}

function enumValues<T extends string>(value: unknown, allowed: ReadonlySet<T>, name: string): T[] | undefined {
  const values = queryValues(value);
  if (values.some(item => !allowed.has(item as T))) throw new ApiError(400, `Invalid ${name}`);
  return values.length ? values as T[] : undefined;
}

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

/** Missing graph artifacts are a recoverable operator state, not an empty query result. */
async function dashboardGraph(store: Parameters<typeof resolveProjectGraphDir>[0]) {
  const graphDir = await resolveProjectGraphDir(store);
  const loaded = await loadProjectKnowledgeGraph(graphDir);
  if (!loaded.ok) throw new ApiError(404, loaded.recoveryReason);
  return { graphDir, graph: loaded.graph };
}

function graphCounts<T extends { kind: string }>(values: readonly T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => ({ ...counts, [value.kind]: (counts[value.kind] ?? 0) + 1 }), {});
}

function resolveSourceKind(query: { sourceKind?: unknown }): KnowledgeSourceKind | undefined {
  const raw = typeof query.sourceKind === "string" ? query.sourceKind : undefined;
  return raw !== undefined && VALID_SOURCE_KINDS.has(raw)
    ? (raw as KnowledgeSourceKind)
    : undefined;
}

function resolveLimit(query: { limit?: unknown }): number {
  const raw = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : NaN;
  if (!Number.isFinite(raw)) return KNOWLEDGE_QUERY_DEFAULT_LIMIT;
  return Math.min(Math.max(1, raw), KNOWLEDGE_QUERY_MAX_LIMIT);
}

export const registerKnowledgeRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getScopedStore, rethrowAsApiError } = ctx;

  /**
   * GET /api/knowledge/query?q=<keywords>&sourceKind=task|pr&limit=N
   * Keyword search over the project-scoped knowledge index. Returns the matching
   * pages (most-recently-updated first) and the total index size.
   */
  router.get("/knowledge/query", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const options = { query: q, sourceKind: resolveSourceKind(req.query), limit: resolveLimit(req.query) };
      /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Knowledge queries require the bound PostgreSQL partition; missing runtime wiring must not fall through to SQLite. */
      const layer = requireAsyncLayer(store, "Knowledge query");
      const pages = await queryKnowledgePagesAsync(layer, options);
      res.json({
        query: q,
        pages,
        total: await countKnowledgePagesAsync(layer),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to query knowledge index");
    }
  });

  /*
  FNXC:KnowledgeGraphDashboard 2026-08-13-22:45:
  Graph HTTP responses are capped because edges.json can be tens of megabytes; graph ids contain
  slashes, #, @, and ~, so clients must send them as encoded query values rather than path segments.
  The path endpoint preserves found, not-found, and limit-reached as successful distinct outcomes.
  */
  router.get("/knowledge/graph/status", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const graphDir = await resolveProjectGraphDir(store);
      const loaded = await loadProjectKnowledgeGraph(graphDir);
      const pathLimits = { defaultMaxHops: KNOWLEDGE_GRAPH_PATH_DEFAULT_HOPS, maxHops: KNOWLEDGE_GRAPH_PATH_MAX_HOPS, maxExpansions: KNOWLEDGE_GRAPH_PATH_MAX_EXPANSIONS };
      if (!loaded.ok) return res.json({ available: false, recoveryReason: loaded.recoveryReason, pathLimits });
      const fnxcAreas = [...new Set(loaded.graph.nodes.map(node => node.attributes.fnxcArea).filter((area): area is string => Boolean(area)))].sort().slice(0, KNOWLEDGE_GRAPH_NODE_PAGE_MAX);
      return res.json({ available: true, recoveryReason: null, graphDir: relative(store.getRootDir(), graphDir), nodeCount: loaded.graph.nodes.length, edgeCount: loaded.graph.edges.length, nodeKindCounts: graphCounts(loaded.graph.nodes), edgeKindCounts: graphCounts(loaded.graph.edges), provenanceCounts: loaded.graph.edges.reduce((counts, edge) => ({ ...counts, [edge.provenance]: (counts[edge.provenance] ?? 0) + 1 }), { extracted: 0, inferred: 0 }), ownerCounts: loaded.graph.nodes.reduce((counts, node) => ({ ...counts, [node.owner]: (counts[node.owner] ?? 0) + 1 }), { file: 0, derived: 0 }), fnxcAreas, pathLimits });
    } catch (err) { if (err instanceof ApiError) throw err; rethrowAsApiError(err, "Failed to load knowledge graph status"); }
  });

  router.get("/knowledge/graph/nodes", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const { graph } = await dashboardGraph(store);
      const namePattern = stringValue(req.query.namePattern);
      if (namePattern) try { new RegExp(namePattern, "i"); } catch { throw new ApiError(400, "Invalid namePattern"); }
      const nodes = queryNodes(graph, { kinds: enumValues(req.query.kinds, GRAPH_NODE_KINDS, "kinds"), pathPrefix: stringValue(req.query.pathPrefix), idPrefix: stringValue(req.query.idPrefix), namePattern, fnxcArea: stringValue(req.query.fnxcArea), symbolKind: enumValues(req.query.symbolKind, GRAPH_SYMBOL_KINDS, "symbolKind")?.[0], owner: enumValues(req.query.owner, GRAPH_OWNERS, "owner")?.[0] });
      const limit = boundedNumber(req.query.limit, 50, 1, KNOWLEDGE_GRAPH_NODE_PAGE_MAX);
      const offset = boundedNumber(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      res.json({ nodes: nodes.slice(offset, offset + limit), total: nodes.length, limit, offset });
    } catch (err) { if (err instanceof ApiError) throw err; rethrowAsApiError(err, "Failed to query knowledge graph nodes"); }
  });

  router.get("/knowledge/graph/node", async (req, res) => {
    try {
      const store = await getScopedStore(req); const { graph } = await dashboardGraph(store);
      const id = stringValue(req.query.id); const node = id ? graph.nodes.find(item => item.id === id) : undefined;
      if (!node) throw new ApiError(404, "Unknown graph node");
      const outgoing = graph.edges.filter(edge => edge.from === id); const incoming = graph.edges.filter(edge => edge.to === id);
      res.json({ node, outgoing: outgoing.slice(0, KNOWLEDGE_GRAPH_EDGE_PAGE_MAX), incoming: incoming.slice(0, KNOWLEDGE_GRAPH_EDGE_PAGE_MAX), outgoingTotal: outgoing.length, incomingTotal: incoming.length });
    } catch (err) { if (err instanceof ApiError) throw err; rethrowAsApiError(err, "Failed to load knowledge graph node"); }
  });

  router.get("/knowledge/graph/neighbors", async (req, res) => {
    try {
      const store = await getScopedStore(req); const { graph } = await dashboardGraph(store);
      const nodeId = stringValue(req.query.nodeId); if (!nodeId || !graph.nodes.some(node => node.id === nodeId)) throw new ApiError(404, "Unknown graph node");
      const direction = stringValue(req.query.direction) ?? "out";
      if (!["out", "in", "both"].includes(direction)) throw new ApiError(400, "Invalid direction");
      const results = neighbors(graph, nodeId, { direction: direction as "out" | "in" | "both", edgeKinds: enumValues(req.query.edgeKinds, GRAPH_EDGE_KINDS, "edgeKinds"), depth: boundedNumber(req.query.depth, 1, 1, 3) });
      res.json({ neighbors: results.slice(0, boundedNumber(req.query.limit, 50, 1, KNOWLEDGE_GRAPH_NODE_PAGE_MAX)), total: results.length });
    } catch (err) { if (err instanceof ApiError) throw err; rethrowAsApiError(err, "Failed to load knowledge graph neighbors"); }
  });

  router.get("/knowledge/graph/path", async (req, res) => {
    try {
      const store = await getScopedStore(req); const { graph } = await dashboardGraph(store);
      const fromId = stringValue(req.query.fromId); const toId = stringValue(req.query.toId);
      if (!fromId || !toId) throw new ApiError(400, "fromId and toId are required");
      res.json(findBoundedShortestPath(graph, fromId, toId, { maxHops: boundedNumber(req.query.maxHops, KNOWLEDGE_GRAPH_PATH_DEFAULT_HOPS, 1, KNOWLEDGE_GRAPH_PATH_MAX_HOPS) }));
    } catch (err) { if (err instanceof ApiError) throw err; if (err instanceof KnowledgeGraphError && err.message === "Unknown graph node") throw new ApiError(404, err.message); rethrowAsApiError(err, "Failed to find knowledge graph path"); }
  });

  router.post("/knowledge/graph/build", async (req, res) => {
    try { const store = await getScopedStore(req); res.json(await rebuildProjectKnowledgeGraph(store, { force: req.body?.force === true })); }
    catch (err) { if (err instanceof ApiError) throw err; rethrowAsApiError(err, "Failed to rebuild knowledge graph"); }
  });

  /**
   * POST /api/knowledge/refresh  { taskId }
   * Incrementally re-index a single task as a knowledge page. Exposes the
   * task-completion refresh hook over HTTP so the completion path (or an
   * operator) can trigger an incremental refresh without a full re-index.
   */
  router.post("/knowledge/refresh", async (req, res) => {
    try {
      const store = await getScopedStore(req);
      const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
      if (!taskId) {
        throw new ApiError(400, "taskId is required");
      }
      const page = await refreshKnowledgeForTask(store, taskId);
      if (!page) {
        throw new ApiError(404, `Task not found or could not be indexed: ${taskId}`);
      }
      res.json({ page });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err, "Failed to refresh knowledge index");
    }
  });
};

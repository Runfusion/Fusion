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

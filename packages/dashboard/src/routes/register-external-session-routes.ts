import { ExternalSessionStore, ExternalSessionReader, ExternalSessionConflict, externalSessionIngestionSchema,
  externalSessionHeartbeatSchema, externalSessionListQuerySchema, externalSessionReadId,
  externalSessionCursorAfter, ExternalSessionFeedback, ExternalFeedbackConflict, feedbackClaimSchema, feedbackAckSchema } from "@fusion/core";
import { ApiError } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";
import { authenticateExternalSessionCollector, parseExternalSessionCollectorCredentials } from "./external-session-collector-auth.js";
import { registerRemoteAgentActions } from "./register-remote-agent-actions.js";

/**
 * FNXC:ExternalSessions 2026-09-17-04:00:
 * Off by default. Collector access is limited to two ingestion endpoints, even with --no-auth.
 * Host identity comes exclusively from the credential; the explicit query project must match it.
 * Strict bounded bodies cannot submit runtime handles, capabilities, task links, or control requests.
 */
export const registerExternalSessionRoutes: ApiRouteRegistrar = ctx => {
  registerRemoteAgentActions(ctx);
  // FNXC:RemoteAgents 2026-09-17-23:19: Dashboard authentication owns list/detail access; the two collector POST exemptions grant no read access.
  ctx.router.get("/external-sessions", async (req, res) => {
    const limit = typeof req.query.limit === "string" && /^\d+$/.test(req.query.limit) ? Number(req.query.limit) : req.query.limit;
    const query = externalSessionListQuerySchema.safeParse({
      ...(req.query.hostId !== undefined ? { hostId: req.query.hostId } : {}),
      ...(req.query.provider !== undefined ? { provider: req.query.provider } : {}),
      ...(req.query.cursor !== undefined ? { cursor: req.query.cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (!query.success) throw new ApiError(400, "Invalid external session list query");
    const { store, projectId } = await ctx.getProjectContext(req);
    if (!projectId) throw new ApiError(503, "External session project storage unavailable");
    try { externalSessionCursorAfter(projectId, query.data); }
    catch { throw new ApiError(400, "Invalid external session cursor"); }
    const layer = store.getAsyncLayer();
    if (!layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    res.json(await new ExternalSessionReader(layer, projectId).list(query.data));
  });
  ctx.router.get("/external-sessions/:id", async (req, res) => {
    const id = externalSessionReadId.safeParse(req.params.id);
    if (!id.success) throw new ApiError(400, "Invalid external session id");
    const { store, projectId } = await ctx.getProjectContext(req);
    const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    const session = await new ExternalSessionReader(layer, projectId).get(id.data);
    if (!session) throw new ApiError(404, "External session not found");
    res.json({ schemaVersion: 1, session });
  });
  const configured = ctx.options?.externalSessionCollectors ?? process.env.FUSION_EXTERNAL_SESSION_COLLECTORS;
  let value: unknown = configured;
  if (typeof configured === "string") {
    try { value = configured.length <= 131_072 ? JSON.parse(configured) : null; } catch { value = null; }
  }
  const credentials = configured === undefined ? undefined : parseExternalSessionCollectorCredentials(value);
  for (const operation of ["ingest", "heartbeat", "feedback-claim", "feedback-ack"] as const) {
    ctx.router.post(`/external-sessions/${operation}`, async (req, res) => {
      if (credentials === undefined) throw new ApiError(404, "External session ingestion is disabled");
      if (credentials === null) throw new ApiError(503, "Invalid external session collector configuration");
      if (req.headers.origin || req.headers["sec-fetch-site"]) throw new ApiError(403, "Collector requests must not originate in a browser");
      const principal = authenticateExternalSessionCollector(req.headers.authorization, credentials);
      if (!principal) throw new ApiError(401, "Valid collector bearer token required");
      if (req.query.projectId !== principal.projectId) throw new ApiError(403, "Collector project scope mismatch");
      const parsed = (operation === "ingest" ? externalSessionIngestionSchema : operation === "heartbeat" ? externalSessionHeartbeatSchema : operation === "feedback-claim" ? feedbackClaimSchema : feedbackAckSchema).safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, "Invalid external session envelope");
      const { store, projectId } = await ctx.getProjectContext(req);
      const layer = store.getAsyncLayer();
      if (!layer || projectId !== principal.projectId || layer.projectId !== principal.projectId) {
        throw new ApiError(503, "External session project storage unavailable");
      }
      const sessions = new ExternalSessionStore(layer, principal);
      try {
        if (operation === "heartbeat") {
          await sessions.heartbeat(parsed.data);
          res.json({ schemaVersion: 1, hostId: principal.hostId });
        } else if (operation === "ingest") {
          res.json(await sessions.ingest(parsed.data));
        } else {
          const feedback = new ExternalSessionFeedback(layer, principal.projectId);
          res.json(operation === "feedback-claim" ? await feedback.claim(principal.hostId, parsed.data) : await feedback.acknowledge(principal.hostId, parsed.data));
        }
      } catch (error) {
        if (error instanceof ExternalFeedbackConflict) throw new ApiError(409, error.message);
        if (error instanceof ExternalSessionConflict) {
          res.status(409).json({ error: error.code, ...(error.acknowledgedSequence !== undefined ? { acknowledgedSequence: error.acknowledgedSequence } : {}) });
          return;
        }
        throw error;
      }
    });
  }
};

import { ExternalSessionStore, ExternalSessionConflict, externalSessionIngestionSchema, externalSessionHeartbeatSchema } from "@fusion/core";
import { ApiError } from "../api-error.js";
import type { ApiRouteRegistrar } from "./types.js";
import { authenticateExternalSessionCollector, parseExternalSessionCollectorCredentials } from "./external-session-collector-auth.js";

/**
 * FNXC:ExternalSessions 2026-09-17-04:00:
 * Off by default. Collector access is limited to two ingestion endpoints, even with --no-auth.
 * Host identity comes exclusively from the credential; the explicit query project must match it.
 * Strict bounded bodies cannot submit runtime handles, capabilities, task links, or control requests.
 */
export const registerExternalSessionRoutes: ApiRouteRegistrar = ctx => {
  const configured = ctx.options?.externalSessionCollectors ?? process.env.FUSION_EXTERNAL_SESSION_COLLECTORS;
  let value: unknown = configured;
  if (typeof configured === "string") {
    try { value = configured.length <= 131_072 ? JSON.parse(configured) : null; } catch { value = null; }
  }
  const credentials = configured === undefined ? undefined : parseExternalSessionCollectorCredentials(value);
  for (const operation of ["ingest", "heartbeat"] as const) {
    ctx.router.post(`/external-sessions/${operation}`, async (req, res) => {
      if (credentials === undefined) throw new ApiError(404, "External session ingestion is disabled");
      if (credentials === null) throw new ApiError(503, "Invalid external session collector configuration");
      if (req.headers.origin || req.headers["sec-fetch-site"]) throw new ApiError(403, "Collector requests must not originate in a browser");
      const principal = authenticateExternalSessionCollector(req.headers.authorization, credentials);
      if (!principal) throw new ApiError(401, "Valid collector bearer token required");
      if (req.query.projectId !== principal.projectId) throw new ApiError(403, "Collector project scope mismatch");
      const parsed = operation === "ingest"
        ? externalSessionIngestionSchema.safeParse(req.body)
        : externalSessionHeartbeatSchema.safeParse(req.body);
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
        } else {
          res.json(await sessions.ingest(parsed.data));
        }
      } catch (error) {
        if (error instanceof ExternalSessionConflict) {
          res.status(409).json({ error: error.code, ...(error.acknowledgedSequence !== undefined ? { acknowledgedSequence: error.acknowledgedSequence } : {}) });
          return;
        }
        throw error;
      }
    });
  }
};

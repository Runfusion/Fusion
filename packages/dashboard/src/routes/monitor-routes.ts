import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { aggregateMonitorMetrics } from "@fusion/core";
import type { TaskStore } from "@fusion/core";
import { badRequest, unauthorized } from "../api-error.js";
import { isSafeExternalUrl } from "../signal-source.js";
import { recordDeployment, resolveIncident } from "../monitor-store.js";
import { runMonitorOnRegression } from "../monitor-trait.js";
import type { ApiRouteRegistrar } from "./types.js";
import { requireAsyncLayer } from "../require-async-layer.js";

/**
 * U13 — Monitor stage routes.
 *
 * Two ingestion endpoints (CI/Ship → deploys, U11 signals → incidents) plus a
 * read endpoint for MTTR / deploy / incident metrics.
 *
 *   POST /api/monitor/deployments   record a deployment (deploy frequency)
 *   POST /api/monitor/incidents     open / resolve / re-fire an incident
 *   GET  /api/monitor/metrics       MTTR + deploy/incident counts over a range
 *
 * ## Auth (mandatory — mirrors U11)
 *
 * The two POST ingestion endpoints require a shared secret / bearer token in the
 * `Authorization: Bearer <token>` header, compared in constant time against the
 * secret in `FUSION_MONITOR_INGEST_SECRET` (env / encrypted settings, never
 * source-controlled). A missing secret config OR a missing/invalid token →
 * **401, and nothing is recorded.** Payload URLs are SSRF-untrusted: a `link`
 * that is not a safe external URL is dropped (stored as data only, never
 * fetched). The GET metrics endpoint inherits the dashboard's standard
 * session/auth middleware + `getScopedStore(req)` scoping, like U9.
 */

/** Env var carrying the monitor ingestion bearer token. */
export const MONITOR_INGEST_SECRET_ENV = "FUSION_MONITOR_INGEST_SECRET";

/** Resolve the monitor ingestion secret (env / encrypted settings). */
export function resolveMonitorIngestSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[MONITOR_INGEST_SECRET_ENV];
  return value && value.length > 0 ? value : undefined;
}

function extractBearer(headers: Request["headers"]): string | undefined {
  const raw = headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Constant-time bearer check. Returns true ONLY when a secret is configured AND
 * the presented token matches it. No secret configured → always false (the
 * endpoint is never unauthenticated).
 */
export function isAuthorizedMonitorIngest(
  headers: Request["headers"],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const secret = resolveMonitorIngestSecret(env);
  if (!secret) return false;
  const token = extractBearer(headers);
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Drop a payload link that is not a safe external URL (SSRF-untrusted). */
function safeLink(link: unknown): string | undefined {
  return typeof link === "string" && isSafeExternalUrl(link) ? link : undefined;
}

export const registerMonitorRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, getScopedStore, rethrowAsApiError } = ctx;

  // ── Deployment ingestion (CI/Ship → deploy frequency) ─────────────────────
  router.post("/monitor/deployments", async (req: Request, res: Response) => {
    if (!isAuthorizedMonitorIngest(req.headers)) {
      throw unauthorized("Invalid or missing monitor ingestion token");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const store: TaskStore = await getScopedStore(req);
    try {
      const deployment = await recordDeployment(requireAsyncLayer(store, "Monitor deployment storage"), {
        deploymentId: typeof body.deploymentId === "string" ? body.deploymentId : undefined,
        service: typeof body.service === "string" ? body.service : undefined,
        environment: typeof body.environment === "string" ? body.environment : undefined,
        version: typeof body.version === "string" ? body.version : undefined,
        status: typeof body.status === "string" ? body.status : undefined,
        deployedAt: typeof body.deployedAt === "string" ? body.deployedAt : undefined,
        link: safeLink(body.link),
        meta: body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : undefined,
      });
      res.status(201).json({ ok: true, deploymentId: deployment.deploymentId });
    } catch (err) {
      rethrowAsApiError(err, "Failed to record deployment");
    }
  });

  // ── Incident ingestion (U11 signal → incident / fix task) ─────────────────
  router.post("/monitor/incidents", async (req: Request, res: Response) => {
    if (!isAuthorizedMonitorIngest(req.headers)) {
      throw unauthorized("Invalid or missing monitor ingestion token");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const groupingKey = typeof body.groupingKey === "string" ? body.groupingKey.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const action = body.action === "resolve" ? "resolve" : "open";

    if (!groupingKey) {
      throw badRequest("Missing required field: groupingKey");
    }

    const store: TaskStore = await getScopedStore(req);

    try {
      if (action === "resolve") {
        const incident = await resolveIncident(requireAsyncLayer(store, "Monitor incident storage"), groupingKey,
          typeof body.at === "string" ? body.at : undefined);
        res.status(200).json({
          ok: true,
          resolved: incident !== null,
          incidentId: incident?.incidentId,
        });
        return;
      }

      if (!title) {
        throw badRequest("Missing required field: title");
      }

      const outcome = await runMonitorOnRegression(
        {
          groupingKey,
          title,
          severity: typeof body.severity === "string" ? body.severity : undefined,
          source: typeof body.source === "string" ? body.source : undefined,
          link: safeLink(body.link),
          meta: body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : undefined,
          at: typeof body.at === "string" ? body.at : undefined,
        },
        { store },
      );
      res.status(outcome.kind === "fix-task-opened" ? 201 : 200).json({ ok: true, outcome });
    } catch (err) {
      if (err && typeof err === "object" && "status" in err) throw err;
      rethrowAsApiError(err, "Failed to ingest incident");
    }
  });

  // ── Metrics read (MTTR + deploy/incident counts) ──────────────────────────
  router.get("/monitor/metrics", async (req: Request, res: Response) => {
    const store: TaskStore = await getScopedStore(req);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    try {
      const metrics = await aggregateMonitorMetrics(requireAsyncLayer(store, "Monitor metrics"), { from, to });
      res.json(metrics);
    } catch (err) {
      rethrowAsApiError(err, "Failed to read monitor metrics");
    }
  });
};

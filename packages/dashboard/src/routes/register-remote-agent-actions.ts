import { ExternalSessionReader, ExternalSessionFeedback, ExternalFeedbackConflict, feedbackSubmitSchema, externalSessionReadId, ExternalSessionUsageIncrementReader } from "@fusion/core";
import { ApiError } from "../api-error.js";
import { summarizeSessionCost, summarizeIncrementCost, categoryCharges } from "../remote-agents/session-cost.js";
import type { ApiRouteRegistrar } from "./types.js";
import { parseExternalSessionCollectorCredentials } from "./external-session-collector-auth.js";

export const registerRemoteAgentActions: ApiRouteRegistrar = ctx => {
  ctx.router.get("/external-sessions/hosts", async (req, res) => {
    const { store, projectId } = await ctx.getProjectContext(req); const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "Remote agent storage unavailable");
    const observed = await new ExternalSessionReader(layer, projectId).hosts();
    let configured: unknown = ctx.options?.externalSessionCollectors ?? process.env.FUSION_EXTERNAL_SESSION_COLLECTORS;
    if (typeof configured === "string") { try { configured = configured.length <= 131072 ? JSON.parse(configured) : null; } catch { configured = null; } }
    const ids = new Set([...observed.map(h => h.hostId), ...(parseExternalSessionCollectorCredentials(configured) ?? []).filter(c => c.projectId === projectId).map(c => c.hostId)]);
    /* FNXC:ExternalSessionHealth 2026-09-23-23:24: A configured host that has never reported is listed with null
       health rather than omitted, because "no collector has ever checked in" is the most important thing to see. */
    const unreported = { lastHeartbeatAt: null, collectorConnected: false, collectorVersion: null, heartbeatAgeMs: null,
      spoolDepth: null, spoolBytes: null, parseFailures: null, deliveryFailures: null, healthReportedAt: null };
    res.json({ hosts: [...ids].sort().map(hostId => observed.find(h => h.hostId === hostId) ?? { hostId, ...unreported }) });
  });
  const resolve = async (req: Parameters<typeof ctx.getProjectContext>[0]) => {
    const id = externalSessionReadId.safeParse(req.params.id);
    if (!id.success) throw new ApiError(400, "Invalid external session id");
    const { store, projectId } = await ctx.getProjectContext(req); const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "Remote agent storage unavailable");
    const session = await new ExternalSessionReader(layer, projectId).get(id.data);
    if (!session) throw new ApiError(404, "External session not found");
    return { store, projectId, layer, session };
  };
  ctx.router.get("/external-sessions/:id/cost", async (req, res) => {
    const { session, store, layer, projectId } = await resolve(req);
    const settings = await store.getGlobalSettingsStore().getSettings();
    const summary = summarizeSessionCost(session, settings);
    /*
    FNXC:ExternalSessionIncrements 2026-09-24-04:51 (F1 = 3): prefer the sum of per-revision increments, each at
    the rates recorded with it. A session with NO increments predates 0091, so it falls back to the cumulative
    figure rather than being reported as free.
    */
    const increments = await new ExternalSessionUsageIncrementReader(layer, projectId).list(session.id).catch(() => []);
    const incremental = increments.length ? summarizeIncrementCost(increments as never, session.provider, settings) : null;
    // FNXC:RemoteAgents 2026-09-26-23:39: each usage row carries its category charges for the card's cost popover.
    res.json({ usage: summary.usage.map(u => ({ ...u, charges: categoryCharges(u) })),
      estimatedUsd: incremental ? incremental.estimatedUsd : summary.estimatedUsd,
      partialUsd: incremental ? incremental.partialUsd : summary.partialUsd,
      pricedFromIncrements: incremental !== null,
      incrementBases: incremental ? incremental.bases : [],
      unpricedIncrements: incremental ? incremental.unpricedIncrements : 0,
      usageComplete: summary.usageComplete, pricingDate: summary.basis.asOf, pricingSource: summary.basis.source,
      pricingRecalculated: summary.basis.recalculated });
  });
  ctx.router.get("/external-sessions/:id/feedback", async (req, res) => {
    const { layer, projectId, session } = await resolve(req);
    res.json({ feedback: await new ExternalSessionFeedback(layer, projectId).list(session.id) });
  });
  ctx.router.post("/external-sessions/:id/feedback", async (req, res) => {
    if (req.headers["sec-fetch-site"] === "cross-site") throw new ApiError(403, "Feedback must originate in Fusion");
    if (req.headers.origin) {
      let sameHost = false;
      try { sameHost = new URL(req.headers.origin).host === req.headers.host; } catch { /* Malformed origins fail closed. */ }
      if (!sameHost) throw new ApiError(403, "Feedback must originate in Fusion");
    }
    const b = feedbackSubmitSchema.safeParse(req.body); if (!b.success) throw new ApiError(400, "Invalid feedback");
    const { layer, projectId, session } = await resolve(req);
    try { res.json(await new ExternalSessionFeedback(layer, projectId).submit(session.id, b.data)); }
    catch (error) { if (error instanceof ExternalFeedbackConflict) throw new ApiError(409, error.message); throw error; }
  });
};

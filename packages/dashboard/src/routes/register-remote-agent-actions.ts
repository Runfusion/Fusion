import { ExternalSessionReader, ExternalSessionFeedback, ExternalFeedbackConflict, feedbackSubmitSchema, externalSessionReadId, pricingAsOf } from "@fusion/core";
import { ApiError } from "../api-error.js";
import { priceUsage } from "../remote-agents/pricing.js";
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
    res.json({ hosts: [...ids].sort().map(hostId => observed.find(h => h.hostId === hostId) ?? { hostId, lastHeartbeatAt: null, collectorConnected: false }) });
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
    const { session, store } = await resolve(req);
    const settings = await store.getGlobalSettingsStore().getSettings();
    const raw = session.observation.usage ?? [];
    const pricingProvider = session.provider === "claude" ? "claude_code" : session.provider === "codex" ? "codex_cli" : session.provider;
    const usage = raw.map(u => priceUsage(u, pricingProvider, settings.modelPricingOverrides)).filter((u): u is NonNullable<typeof u> => u !== null);
    const priced = usage.filter(u => u.usd !== null); const partial = priced.reduce((n, u) => n + u.usd!, 0);
    const complete = session.observation.usageComplete === true && usage.length > 0 && usage.length === raw.length && priced.length === usage.length;
    res.json({ usage, estimatedUsd: complete ? partial : null, partialUsd: priced.length ? partial : null,
      usageComplete: session.observation.usageComplete === true, pricingDate: settings.modelPricingFetchedAt ?? pricingAsOf, pricingSource: settings.modelPricingSource ?? "Fusion model pricing" });
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

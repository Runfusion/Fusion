import { ExternalSessionStore, ExternalSessionReader, ExternalSessionConflict, externalSessionIngestionSchema,
  externalSessionHeartbeatSchema, externalSessionListQuerySchema, externalSessionReadId,
  externalSessionCursorAfter, ExternalSessionFeedback, ExternalFeedbackConflict, feedbackClaimSchema, feedbackAckSchema,
  ExternalSessionTurnStore, ExternalSessionTurnReader, ExternalSessionTurnConflict, externalSessionTurnIngestionSchema } from "@fusion/core";
import { ApiError } from "../api-error.js";
import { sessionCostBadge, summarizeTurnCost, summarizeIncrementCost } from "../remote-agents/session-cost.js";
import { recordedRatesFor } from "../remote-agents/record-rates.js";
import { rankSessions, rankTurns } from "../remote-agents/rankings.js";
import { summarizeOverview } from "../remote-agents/overview.js";
import { ExternalSessionTurnSearch, ExternalSessionRankings, ExternalSessionUsageIncrementReader } from "@fusion/core";
import { ExternalSessionSummaryStore, summaryInput, summaryState, summarizeExternalSession,
  resolveTitleSummarizerSettingsModel, ExternalSessionAttribution } from "@fusion/core";
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
    /*
    FNXC:RemoteAgents 2026-09-23-21:32: Cost used to be reachable only by opening one session at a time, so
    "which session is expensive?" required N clicks. Each card now carries its own total, priced server-side
    from the same summary the detail pane uses, so the list and the detail can never disagree.
    */
    const page = await new ExternalSessionReader(layer, projectId).list(query.data);
    const settings = await store.getGlobalSettingsStore().getSettings();
    /*
    FNXC:ExternalSessionIncrements 2026-09-24-04:51 (F1 = 3): cards use the same increment sum as the detail
    pane, so the two cannot disagree. One query covers the whole page rather than one per session, and a session
    with no increments keeps the cumulative badge because it predates 0091 rather than being free.
    */
    const bySession = await new ExternalSessionUsageIncrementReader(layer, projectId)
      .listForSessions(page.sessions.map(session => session.id)).catch(() => new Map());
    /*
    FNXC:ExternalSessionAttribution 2026-09-24-07:05 (operator decision F4 = 1): a session that IS a Fusion task
    run is already counted in that task's telemetry, so adding its cost to a Fusion total would double count.
    Attribution is carried on the card so the overlap is visible rather than latent; it is best-effort, and a
    failure leaves sessions unattributed, which is the safe reading.
    */
    const attributed = await new ExternalSessionAttribution(layer, projectId)
      .resolve(page.sessions.map(s => ({ sessionId: s.id, provider: s.provider, nativeSessionId: s.nativeSessionId })))
      .catch(() => new Map());
    res.json({ ...page, sessions: page.sessions.map(session => {
      const fusion = attributed.get(session.id) ?? null;
      const increments = bySession.get(session.id);
      const badge = sessionCostBadge(session, settings);
      if (!increments?.length) return { ...session, cost: badge, fusion };
      const incremental = summarizeIncrementCost(increments as never, session.provider, settings);
      return { ...session, fusion, cost: { ...badge, estimatedUsd: incremental.estimatedUsd,
        partialUsd: incremental.partialUsd, unpricedRecords: incremental.unpricedIncrements } };
    }) });
  });
  /*
  FNXC:ExternalSessionSearch 2026-09-23-23:05: Registered BEFORE "/external-sessions/:id" on purpose; Express
  matches in order, so the parameter route would otherwise capture "search" as a session id and 400.
  */
  ctx.router.get("/external-sessions/search", async (req, res) => {
    const limit = typeof req.query.limit === "string" && /^\d+$/.test(req.query.limit) ? Number(req.query.limit) : undefined;
    if (typeof req.query.q !== "string") throw new ApiError(400, "Search requires a query");
    for (const key of ["hostId", "sessionId"] as const) {
      if (req.query[key] !== undefined && typeof req.query[key] !== "string") throw new ApiError(400, "Invalid external session search filter");
    }
    const { store, projectId } = await ctx.getProjectContext(req); const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    try {
      res.json(await new ExternalSessionTurnSearch(layer, projectId).search({ q: req.query.q,
        ...(limit === undefined ? {} : { limit }),
        ...(req.query.hostId === undefined ? {} : { hostId: String(req.query.hostId) }),
        ...(req.query.sessionId === undefined ? {} : { sessionId: String(req.query.sessionId) }) }));
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") throw new ApiError(400, "Invalid external session search query");
      throw error;
    }
  });
  /* FNXC:ExternalSessionRankings 2026-09-24-00:04: Registered before "/:id" for the same reason as search. */
  ctx.router.get("/external-sessions/rankings", async (req, res) => {
    const scope = req.query.scope === "sessions" ? "sessions" : "turns";
    for (const key of ["hostId", "model", "from", "to"] as const) {
      if (req.query[key] !== undefined && typeof req.query[key] !== "string") throw new ApiError(400, "Invalid ranking filter");
    }
    const { store, projectId } = await ctx.getProjectContext(req); const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    const query = {
      ...(req.query.hostId === undefined ? {} : { hostId: String(req.query.hostId) }),
      ...(req.query.model === undefined ? {} : { model: String(req.query.model) }),
      ...(req.query.from === undefined ? {} : { from: String(req.query.from) }),
      ...(req.query.to === undefined ? {} : { to: String(req.query.to) }),
    };
    try {
      const rankings = new ExternalSessionRankings(layer, projectId);
      const settings = await store.getGlobalSettingsStore().getSettings();
      const ranking = scope === "sessions"
        ? rankSessions(await rankings.sessions(query), settings)
        : rankTurns(await rankings.turns(query), settings);
      res.json({ schemaVersion: 1, scope, ...ranking });
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") throw new ApiError(400, "Invalid ranking query");
      throw error;
    }
  });
  /*
  FNXC:ExternalSessionOverview 2026-09-24-08:12: Registered before "/:id" for the same reason as search and
  rankings. Answers "what did this range cost", which per-session and top-N figures cannot: the panel's
  per-server totals cover only the sessions currently loaded.
  */
  ctx.router.get("/external-sessions/overview", async (req, res) => {
    for (const key of ["hostId", "model", "from", "to"] as const) {
      if (req.query[key] !== undefined && typeof req.query[key] !== "string") throw new ApiError(400, "Invalid overview filter");
    }
    const { store, projectId } = await ctx.getProjectContext(req); const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    const query = {
      ...(req.query.hostId === undefined ? {} : { hostId: String(req.query.hostId) }),
      ...(req.query.model === undefined ? {} : { model: String(req.query.model) }),
      ...(req.query.from === undefined ? {} : { from: String(req.query.from) }),
      ...(req.query.to === undefined ? {} : { to: String(req.query.to) }),
    };
    try {
      const scan = await new ExternalSessionRankings(layer, projectId).sessions(query);
      const settings = await store.getGlobalSettingsStore().getSettings();
      /* F4 = 1: the Fusion-run split is best-effort; a failure leaves it zero, which reads as "none proven",
         never as a suppressed cost. */
      const attributed = await new ExternalSessionAttribution(layer, projectId)
        .resolve(scan.candidates.map(c => ({ sessionId: c.sessionId, provider: c.provider, nativeSessionId: c.nativeSessionId })))
        .catch(() => new Map());
      res.json({ schemaVersion: 1, ...summarizeOverview(scan, settings, attributed) });
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") throw new ApiError(400, "Invalid overview query");
      throw error;
    }
  });
  /*
  FNXC:ExternalSessionAttribution 2026-09-26-23:39:
  Task detail shows the collected turns of the external sessions that ARE this task's runs. Membership comes from
  `sessionIdsForTask`, which reuses the card attribution, so the two surfaces cannot disagree about a session.
  An empty list means "no proven run", not "no run": a pre-spawn or contested native id is left out on purpose.
  Registered before "/external-sessions/:id" to keep the literal segment out of the parameter route.
  */
  ctx.router.get("/external-sessions/by-task/:taskId", async (req, res) => {
    const taskId = req.params.taskId;
    if (typeof taskId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(taskId)) throw new ApiError(400, "Invalid task id");
    const { store, projectId } = await ctx.getProjectContext(req);
    const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    const ids = (await new ExternalSessionAttribution(layer, projectId).sessionIdsForTask(taskId)).slice(0, 50);
    const reader = new ExternalSessionReader(layer, projectId);
    const sessions = (await Promise.all(ids.map(id => reader.get(id)))).filter(s => s !== null);
    res.json({ schemaVersion: 1, taskId, sessions });
  });
  ctx.router.get("/external-sessions/:id", async (req, res) => {
    const id = externalSessionReadId.safeParse(req.params.id);
    if (!id.success) throw new ApiError(400, "Invalid external session id");
    const { store, projectId } = await ctx.getProjectContext(req);
    const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    const session = await new ExternalSessionReader(layer, projectId).get(id.data);
    if (!session) throw new ApiError(404, "External session not found");
    // FNXC:ExternalSessionAttribution 2026-09-24-07:05 (F4 = 1): says whether this session IS a Fusion task run.
    const fusion = (await new ExternalSessionAttribution(layer, projectId).resolve([{ sessionId: session.id,
      provider: session.provider, nativeSessionId: session.nativeSessionId }]).catch(() => new Map())).get(session.id) ?? null;
    res.json({ schemaVersion: 1, session, fusion });
  });
  /*
  FNXC:ExternalSessionSummary 2026-09-24-07:05 (operator decision F3 = A):
  Session summaries are a NEW Fusion capability, not AgentPulse parity — the measured AgentPulse watcher left no
  durable summaries at all. Generation is explicitly operator-triggered: a background summarizer would spend
  model budget on every ingested session whether or not anyone ever opens it.

  The GET never generates. It returns the stored record plus DERIVED staleness, so opening a session is free and
  a stale summary reads as stale rather than being silently regenerated.
  */
  const summaryContext = async (req: Parameters<typeof ctx.getProjectContext>[0], rawId: unknown) => {
    const id = externalSessionReadId.safeParse(rawId);
    if (!id.success) throw new ApiError(400, "Invalid external session id");
    const { store, projectId } = await ctx.getProjectContext(req);
    const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    return { id: id.data, store, layer, projectId, summaries: new ExternalSessionSummaryStore(layer, projectId) };
  };
  const summaryBody = async (summaries: ExternalSessionSummaryStore, id: string) => {
    const record = await summaries.read(id);
    return { schemaVersion: 1 as const, summary: record, ...summaryState(record, await summaries.latestOrdinal(id)) };
  };
  ctx.router.get("/external-sessions/:id/summary", async (req, res) => {
    const { id, summaries } = await summaryContext(req, req.params.id);
    res.json(await summaryBody(summaries, id));
  });
  ctx.router.post("/external-sessions/:id/summary", async (req, res) => {
    const { id, store, summaries, layer, projectId } = await summaryContext(req, req.params.id);
    const session = await new ExternalSessionReader(layer, projectId).get(id);
    if (!session) throw new ApiError(404, "External session not found");
    const input = summaryInput(await summaries.tail(id));
    if (!input) throw new ApiError(409, "This session has no collected turns to summarize");
    const settings = await store.getSettings();
    const model = resolveTitleSummarizerSettingsModel(settings);
    try {
      const text = await summarizeExternalSession(input.text, store.getRootDir(), model.provider, model.modelId);
      if (!text) throw new Error("Summarizer returned no summary");
      await summaries.recordSuccess(id, { summary: text, provider: model.provider ?? null,
        model: model.modelId ?? null, coverage: input.coverage });
      res.json(await summaryBody(summaries, id));
    } catch (error) {
      /* The previous summary survives: an outage degrades the pane to "summary as of an earlier point, plus why
         it has not advanced", never to an empty one. The 502 still tells the operator the attempt failed. */
      await summaries.recordFailure(id, error instanceof Error ? error.message : String(error));
      res.status(502).json(await summaryBody(summaries, id));
    }
  });
  ctx.router.get("/external-sessions/:id/turns", async (req, res) => {
    const id = externalSessionReadId.safeParse(req.params.id);
    const limit = typeof req.query.limit === "string" && /^\d+$/.test(req.query.limit) ? Number(req.query.limit) : req.query.limit;
    if (!id.success || (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100))
      || (req.query.cursor !== undefined && typeof req.query.cursor !== "string")) throw new ApiError(400, "Invalid external turn query");
    const { store, projectId } = await ctx.getProjectContext(req); const layer = store.getAsyncLayer();
    if (!projectId || !layer || layer.projectId !== projectId) throw new ApiError(503, "External session project storage unavailable");
    const priceTurns = async (page: { turns: Array<Record<string, unknown>> }) => {
      /* FNXC:ExternalSessionUsage 2026-09-23-23:24: Pricing is additive to turn history, so a failure to resolve
         the session or the rate table leaves turns UNPRICED rather than making the history itself unavailable. */
      let session: { provider: string } | null = null;
      let settings: Parameters<typeof summarizeTurnCost>[2];
      try {
        session = await new ExternalSessionReader(layer, projectId).get(id.data as string);
        settings = await store.getGlobalSettingsStore().getSettings();
      } catch { session = null; }
      /* FNXC:ExternalSessionUsage 2026-09-23-23:24: Priced here rather than in core so turns reuse the dashboard's
         single pricing seam; a session that vanished mid-read leaves turns unpriced instead of guessing a provider. */
      return { ...page, turns: page.turns.map(turn => ({ ...turn,
        cost: session ? summarizeTurnCost(turn, session.provider, settings, (turn.endedAt ?? turn.startedAt) as string | null) : null })) };
    };
    try { res.json(await priceTurns(await new ExternalSessionTurnReader(layer, projectId).list(id.data,
      { ...(limit === undefined ? {} : { limit: Number(limit) }), ...(req.query.cursor === undefined ? {} : { cursor: req.query.cursor }) }) as never)); }
    catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && (error.name === "ZodError" || error.message.includes("cursor scope")))) {
        throw new ApiError(400, "Invalid external turn cursor");
      }
      throw error;
    }
  });
  const configured = ctx.options?.externalSessionCollectors ?? process.env.FUSION_EXTERNAL_SESSION_COLLECTORS;
  let value: unknown = configured;
  if (typeof configured === "string") {
    try { value = configured.length <= 131_072 ? JSON.parse(configured) : null; } catch { value = null; }
  }
  const credentials = configured === undefined ? undefined : parseExternalSessionCollectorCredentials(value);
  for (const operation of ["ingest", "turn-ingest", "heartbeat", "feedback-claim", "feedback-ack"] as const) {
    ctx.router.post(`/external-sessions/${operation}`, async (req, res) => {
      if (credentials === undefined) throw new ApiError(404, "External session ingestion is disabled");
      if (credentials === null) throw new ApiError(503, "Invalid external session collector configuration");
      if (req.headers.origin || req.headers["sec-fetch-site"]) throw new ApiError(403, "Collector requests must not originate in a browser");
      const principal = authenticateExternalSessionCollector(req.headers.authorization, credentials);
      if (!principal) throw new ApiError(401, "Valid collector bearer token required");
      if (req.query.projectId !== principal.projectId) throw new ApiError(403, "Collector project scope mismatch");
      const parsed = (operation === "ingest" ? externalSessionIngestionSchema : operation === "turn-ingest" ? externalSessionTurnIngestionSchema : operation === "heartbeat" ? externalSessionHeartbeatSchema : operation === "feedback-claim" ? feedbackClaimSchema : feedbackAckSchema).safeParse(req.body);
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
          /*
          FNXC:ExternalSessionIncrements 2026-09-24-04:51 (F1 = 3): supply the rates applicable right now so the
          increment this revision adds is priced at its own effective rate. Computed server-side from the
          incoming usage, so a collector cannot choose them; an unavailable rate table leaves the increment
          unpriced rather than refusing the observation.
          */
          const session = parsed.data as { session: { provider: string; usage?: Array<{ model?: unknown }> } };
          let stamp: ReturnType<typeof recordedRatesFor>;
          try {
            stamp = recordedRatesFor(session.session.usage, session.session.provider,
              await store.getGlobalSettingsStore().getSettings());
          } catch { stamp = undefined; }
          res.json(await sessions.ingest(parsed.data, stamp));
        } else if (operation === "turn-ingest") {
          /*
          FNXC:ExternalSessionRates 2026-09-24-00:04: Stamp the applicable rates as the turn arrives; this is the
          last moment the true rate is knowable. The stamp is always recomputed here and overwrites anything the
          collector sent, so a host cannot choose the rates its own work is priced at.
          */
          const body = parsed.data as { sessionId: string; turn: Record<string, unknown> };
          let pricing: ReturnType<typeof recordedRatesFor>;
          try {
            const session = await new ExternalSessionReader(layer, principal.projectId).get(body.sessionId);
            if (session) pricing = recordedRatesFor(body.turn.usage as never, session.provider, await store.getGlobalSettingsStore().getSettings());
          } catch { pricing = undefined; }
          // An unavailable rate table must not refuse the turn: unstamped stays honestly unstamped.
          const turn = { ...body.turn, ...(pricing ? { pricing } : {}) };
          if (!pricing) delete (turn as { pricing?: unknown }).pricing;
          res.json(await new ExternalSessionTurnStore(layer, principal).ingest({ ...body, turn }));
        } else {
          const feedback = new ExternalSessionFeedback(layer, principal.projectId);
          res.json(operation === "feedback-claim" ? await feedback.claim(principal.hostId, parsed.data) : await feedback.acknowledge(principal.hostId, parsed.data));
        }
      } catch (error) {
        if (error instanceof ExternalFeedbackConflict) throw new ApiError(409, error.message);
        if (error instanceof ExternalSessionTurnConflict) throw new ApiError(error.code === "session-not-found" ? 404 : 409, error.code);
        if (error instanceof ExternalSessionConflict) {
          res.status(409).json({ error: error.code, ...(error.acknowledgedSequence !== undefined ? { acknowledgedSequence: error.acknowledgedSequence } : {}) });
          return;
        }
        throw error;
      }
    });
  }
};

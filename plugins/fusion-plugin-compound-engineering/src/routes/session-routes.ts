import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/core";
import { CeOrchestrator } from "../session/orchestrator.js";
import { recoverStaleSessionsForContext } from "../session/session-recovery.js";
import { asCeSessionStatus, getCeSessionStore } from "../session/session-store.js";
import { getCePipelineStore } from "../sync/pipeline-store.js";
import { asString } from "./route-helpers.js";

/**
 * Session routes (U5): start / answer / resume / get-session-state.
 *
 * TRANSPORT. Turn execution is DETACHED: start/answer/resume return as soon
 * as the session row reflects the request, with the agent turn running in the
 * background. Clients converge via the `plugin:custom` SSE push (the
 * orchestrator emits throttled progress events) with `GET /sessions/:id`
 * polling as the fallback — that GET also attaches the in-flight working
 * output (`liveActivity`) so the user can watch the agent work mid-turn.
 */

interface RouteRequest {
  params: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/**
 * Cache the orchestrator per TaskStore so live in-process interactive-session
 * handles survive across requests within a process (a fresh orchestrator per
 * request would lose the live handle needed to answer a question).
 */
const orchestratorCache = new WeakMap<object, CeOrchestrator>();

function getOrchestrator(ctx: PluginContext): CeOrchestrator {
  const key = ctx.taskStore as object;
  const cached = orchestratorCache.get(key);
  if (cached) return cached;
  const orch = new CeOrchestrator({ ctx });
  orchestratorCache.set(key, orch);
  return orch;
}

function badRequest(message: string): PluginRouteResponse {
  return { status: 400, body: { error: message } };
}

export function createSessionRoutes(): PluginRouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/sessions",
      description: "Start an interactive CE stage session.",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const body = (req as RouteRequest).body as Record<string, unknown> | undefined;
        const stageId = asString(body?.stage);
        const openingMessage = asString(body?.message) ?? "";
        if (!stageId) return badRequest("`stage` is required");

        const orch = getOrchestrator(ctx);
        try {
          const result = await orch.start(stageId, {
            openingMessage,
            projectId: asString(body?.projectId) ?? null,
            sourceSessionId: asString(body?.sourceSessionId),
            detach: true,
          });
          return { status: 201, body: { session: result.session } };
        } catch (err) {
          return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
        }
      },
    },
    {
      method: "POST",
      path: "/sessions/:id/answer",
      description: "Answer the awaiting question and continue the session.",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const request = req as RouteRequest;
        const id = request.params.id;
        const body = request.body as Record<string, unknown> | undefined;
        const questionId = asString(body?.questionId);
        if (!questionId) return badRequest("`questionId` is required");
        if (!("response" in (body ?? {}))) return badRequest("`response` is required");

        const orch = getOrchestrator(ctx);
        try {
          const result = await orch.answer(id, questionId, (body as Record<string, unknown>).response, {
            detach: true,
          });
          return { status: 200, body: { session: result.session } };
        } catch (err) {
          return { status: 409, body: { error: err instanceof Error ? err.message : String(err) } };
        }
      },
    },
    {
      method: "POST",
      path: "/sessions/:id/resume",
      description: "Resume an awaiting_input or interrupted session to its current question.",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const id = (req as RouteRequest).params.id;
        const orch = getOrchestrator(ctx);
        try {
          const result = await orch.resume(id, { detach: true });
          return { status: 200, body: { session: result.session } };
        } catch (err) {
          return { status: 404, body: { error: err instanceof Error ? err.message : String(err) } };
        }
      },
    },
    {
      method: "POST",
      path: "/sessions/:id/cancel",
      description: "Cancel an in-flight CE session (stops the agent, keeps the row as interrupted).",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const id = (req as RouteRequest).params.id;
        const session = await getOrchestrator(ctx).cancel(id);
        if (!session) return { status: 404, body: { error: `Session ${id} not found` } };
        return { status: 200, body: { session } };
      },
    },
    {
      method: "GET",
      path: "/sessions/:id",
      description: "Get current session state, including in-flight working output (liveActivity).",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const id = (req as RouteRequest).params.id;
        await recoverStaleSessionsForContext(ctx, { reason: "route" });
        /*
         * FNXC:CompoundEngineeringConcurrency 2026-07-14-00:43:
         * Single-session polling reads through the cached orchestrator so a detached turn whose PostgreSQL failure write also failed is still observably terminal in this process; ordinary and recovered sessions continue to come from the async store.
         */
        const session = await getOrchestrator(ctx).getState(id);
        if (!session) return { status: 404, body: { error: `Session ${id} not found` } };
        // Attach the orchestrator's transient mid-turn buffer so a polling
        // client can watch the agent work while the turn runs.
        const liveActivity = getOrchestrator(ctx).getLiveActivity(id);
        return {
          status: 200,
          body: { session: liveActivity.length > 0 ? { ...session, liveActivity } : session },
        };
      },
    },
    {
      method: "GET",
      path: "/sessions",
      description: "List CE sessions (optionally filtered by project/status/stage).",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        await recoverStaleSessionsForContext(ctx, { reason: "route" });
        const query = (req as RouteRequest).query ?? {};
        const status = asCeSessionStatus(typeof query.status === "string" ? query.status : undefined);
        const stage = typeof query.stage === "string" ? query.stage : undefined;
        const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
        /*
        FNXC:CompoundEngineering 2026-07-10-23:40:
        Dashboard session collections must be scoped at the route/store boundary so resume, URL restoration, stage state, and history cannot expose another project's Compound Engineering runs.
        */
        const sessions = await getCeSessionStore(ctx).listAsync({ status, stage, projectId });
        return { status: 200, body: { sessions } };
      },
    },
    {
      method: "DELETE",
      path: "/sessions/:id",
      description: "Discard a CE session (disposes any live handle, deletes the row).",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const id = (req as RouteRequest).params.id;
        // Go through the orchestrator so an in-flight live handle is disposed,
        // not just the row removed (a bare store.delete would leave the agent
        // running unobserved in this process).
        const removed = await getOrchestrator(ctx).discard(id);
        if (!removed) return { status: 404, body: { error: `Session ${id} not found` } };
        return { status: 200, body: { deleted: true } };
      },
    },
    {
      // U7 work bridge: observe the board tasks a CE pipeline (session) landed,
      // via their link records (the addressable back-reference, FN-5719). The
      // session id IS the pipeline id. Outbound-only in U7; U8 layers state.
      method: "GET",
      path: "/sessions/:id/links",
      description: "List the CE pipeline-link records (work→board) for a session/pipeline.",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const id = (req as RouteRequest).params.id;
        const links = await getCePipelineStore(ctx).listByPipelineAsync(id);
        return { status: 200, body: { links } };
      },
    },
  ];
}

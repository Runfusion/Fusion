import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/core";
import { applyDecision, type ApprovalActor, type ApprovalDecision, type ApprovalSettings } from "../approval.js";
import { getApprovalRequired, getApproverAgentIds, getAutoPublishOnApproval, getPublishTargets } from "../settings.js";
import { buildShareBlocks } from "../share-blocks.js";
import { ReportStore } from "../store/report-store.js";

interface RouteRequest {
  params: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
}

const reportStoreCache = new WeakMap<object, ReportStore>();

function getStore(ctx: PluginContext): ReportStore {
  const taskStoreWithReports = ctx.taskStore as PluginContext["taskStore"] & { getReportStore?: () => ReportStore };
  if (typeof taskStoreWithReports.getReportStore === "function") return taskStoreWithReports.getReportStore();
  const key = ctx.taskStore as object;
  const cached = reportStoreCache.get(key);
  if (cached) return cached;
  // FNXC:PostgresCutover 2026-07-04-00:00:
  // In backend mode, pass asyncLayer so ReportStore async methods work.
  if (ctx.taskStore.isBackendMode()) {
    const store = new ReportStore(null, { asyncLayer: ctx.taskStore.getAsyncLayer() });
    reportStoreCache.set(key, store);
    return store;
  }
  const store = new ReportStore(ctx.taskStore.getDatabase());
  reportStoreCache.set(key, store);
  return store;
}

function settingsFromContext(ctx: PluginContext): ApprovalSettings {
  return {
    approvalRequired: getApprovalRequired(ctx.settings),
    autoPublishOnApproval: getAutoPublishOnApproval(ctx.settings),
    approverAgentIds: getApproverAgentIds(ctx.settings),
    publishTargets: getPublishTargets(ctx.settings),
  };
}

function actorFromRequest(request: RouteRequest, ctx: PluginContext): ApprovalActor {
  const actorType = request.headers?.["x-fusion-actor-type"];
  const actorId = request.headers?.["x-fusion-user"]
    ?? (typeof request.body?.decidedBy === "string" ? request.body.decidedBy : undefined)
    ?? "unknown";
  if (!request.headers?.["x-fusion-user"] && !request.body?.decidedBy) {
    ctx.logger.warn("reports approval route missing actor identity; using unknown");
  }
  return { id: actorId, type: actorType === "agent" ? "agent" : "human" };
}

function decisionFromRequest(request: RouteRequest, action: ApprovalDecision["action"], actor: ApprovalActor): ApprovalDecision {
  return {
    action,
    decidedBy: actor.id,
    decidedAt: new Date().toISOString(),
    note: typeof request.body?.note === "string" && request.body.note.trim().length > 0 ? request.body.note.trim() : undefined,
  };
}

function notFound(id: string): PluginRouteResponse {
  return { status: 404, body: { error: `Report ${id} not found` } };
}

export function createReportApprovalRoutes(): PluginRouteDefinition[] {
  const mutate = (action: ApprovalDecision["action"]) => async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
    const request = req as RouteRequest;
    const reportId = request.params.id;
    const store = getStore(ctx);
    const report = await store.getReportAsync(reportId);
    if (!report) return notFound(reportId);

    const actor = actorFromRequest(request, ctx);
    const settings = settingsFromContext(ctx);
    const decision = decisionFromRequest(request, action, actor);
    const result = applyDecision(report, decision, settings, actor);
    if ("error" in result) {
      return { status: result.error === "unauthorized" ? 403 : 409, body: { error: result.error } };
    }

    const updated = await store.updateReportAsync(reportId, result.updatedReport);
    return { status: 200, body: { report: updated, sideEffects: result.sideEffects } };
  };

  return [
    { method: "POST", path: "/reports/:id/approve", handler: mutate("approve") },
    { method: "POST", path: "/reports/:id/reject", handler: mutate("reject") },
    { method: "POST", path: "/reports/:id/publish", handler: mutate("publish") },
    {
      method: "GET",
      path: "/reports/:id/share-blocks",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const request = req as RouteRequest;
        const reportId = request.params.id;
        const report = await getStore(ctx).getReportAsync(reportId);
        if (!report) return notFound(reportId);
        if (!(report.approvalState === "approved" || report.approvalState === "published")) {
          return { status: 409, body: { error: "Share blocks unlock after approval" } };
        }
        return { status: 200, body: buildShareBlocks(report) };
      },
    },
  ];
}

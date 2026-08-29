import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/core";
import { getReportStore } from "../store/report-store-provider.js";

interface RouteRequest {
  params: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
}

function badRequest(message: string): PluginRouteResponse {
  return { status: 400, body: { error: message } };
}

export function createReportListRoutes(): PluginRouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/reports",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const request = req as RouteRequest;
        const query = request.query ?? {};
        const cadence = typeof query.cadence === "string" && query.cadence.length > 0 ? query.cadence : undefined;
        const status = typeof query.status === "string" && query.status.length > 0 ? query.status : undefined;
        const periodStartFrom = typeof query.from === "string" && query.from.length > 0 ? query.from : undefined;
        const periodStartTo = typeof query.to === "string" && query.to.length > 0 ? query.to : undefined;
        const q = typeof query.q === "string" && query.q.length > 0 ? query.q.toLowerCase() : undefined;
        const agent = typeof query.agentId === "string" && query.agentId.length > 0 ? query.agentId.toLowerCase() : undefined;

        const store = getReportStore(ctx);
        const reports = await store.listReportsAsync({
          cadence: cadence as never,
          status: status as never,
          periodStartFrom,
          periodStartTo,
          orderBy: "periodStart",
          orderDir: "desc",
          limit: 500,
        });

        const filtered = reports.filter((report) => {
          if (q && !report.title.toLowerCase().includes(q)) return false;
          if (agent) {
            const agentIds = ((report.metadata?.agentIds as string[] | undefined) ?? []).map((id) => id.toLowerCase());
            if (!agentIds.some((id) => id.includes(agent))) return false;
          }
          return true;
        });
        return { status: 200, body: { reports: filtered } };
      },
    },
    {
      method: "GET",
      path: "/reports/:id",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const request = req as RouteRequest;
        const report = await getReportStore(ctx).getReportAsync(request.params.id);
        if (!report) return { status: 404, body: { error: `Report ${request.params.id} not found` } };
        return { status: 200, body: { report } };
      },
    },
  ];
}

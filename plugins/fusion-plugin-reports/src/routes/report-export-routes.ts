import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/core";
import { getReportStore } from "../store/report-store-provider.js";
import { renderReportHtml } from "../render/html-template.js";
import { renderStandaloneReportHtml, slugifyReportFilename } from "../render/standalone-html.js";

interface RouteRequest {
  params: Record<string, string>;
}

function notFound(message: string): PluginRouteResponse {
  return { status: 404, body: { error: message } };
}

function conflict(message: string): PluginRouteResponse {
  return { status: 409, body: { error: message } };
}

export function createReportExportRoutes(): PluginRouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/reports/:id/export.html",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const request = req as RouteRequest;
        const id = request.params.id;
        const store = getReportStore(ctx);
        const record = await store.getReportAsync(id);
        if (!record) return notFound(`Report ${id} not found`);
        if (record.status === "generating") return conflict(`Report ${id} is not generated yet`);
        const html = record.renderedHtml ?? renderStandaloneReportHtml(record);
        if (!record.renderedHtml) {
          await store.setRenderedHtmlAsync(id, html);
        }
        return {
          status: 200,
          body: html,
          contentType: "text/html; charset=utf-8",
          headers: {
            "Content-Disposition": `attachment; filename="${slugifyReportFilename(record)}"`,
          },
        };
      },
    },
    {
      method: "GET",
      path: "/reports/:id/preview.html",
      handler: async (req: unknown, ctx: PluginContext): Promise<PluginRouteResponse> => {
        const request = req as RouteRequest;
        const id = request.params.id;
        const store = getReportStore(ctx);
        const record = await store.getReportAsync(id);
        if (!record) return notFound(`Report ${id} not found`);
        if (record.status === "generating") return conflict(`Report ${id} is not generated yet`);
        return {
          status: 200,
          body: renderReportHtml(record, { includeChrome: false }),
          contentType: "text/html; charset=utf-8",
        };
      },
    },
  ];
}

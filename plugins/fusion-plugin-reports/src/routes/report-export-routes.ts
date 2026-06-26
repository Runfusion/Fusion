import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/core";
import { ReportStore } from "../store/report-store.js";
import { renderReportHtml } from "../render/html-template.js";
import { renderStandaloneReportHtml, slugifyReportFilename } from "../render/standalone-html.js";

interface RouteRequest {
  params: Record<string, string>;
}

const reportStoreCache = new WeakMap<object, ReportStore>();

function getStore(ctx: PluginContext): ReportStore {
  const taskStoreWithReports = ctx.taskStore as PluginContext["taskStore"] & { getReportStore?: () => ReportStore };
  if (typeof taskStoreWithReports.getReportStore === "function") {
    return taskStoreWithReports.getReportStore();
  }
  const key = ctx.taskStore as object;
  const cached = reportStoreCache.get(key);
  if (cached) return cached;
  // FNXC:RuntimeSatelliteAsync 2026-06-24-22:20:
  // In backend mode, getDatabase() throws. Guard with isBackendMode() check.
  const db = ctx.taskStore.isBackendMode() ? null : ctx.taskStore.getDatabase();
  const store = new ReportStore(db);
  reportStoreCache.set(key, store);
  return store;
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
        const store = getStore(ctx);
        const record = store.getReport(id);
        if (!record) return notFound(`Report ${id} not found`);
        if (record.status === "generating") return conflict(`Report ${id} is not generated yet`);
        const html = record.renderedHtml ?? renderStandaloneReportHtml(record);
        if (!record.renderedHtml) {
          store.setRenderedHtml(id, html);
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
        const store = getStore(ctx);
        const record = store.getReport(id);
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

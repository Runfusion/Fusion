import type {
  PluginContext,
  PluginRouteDefinition,
  PluginRouteResponse,
  PluginToolDefinition,
  PluginToolResult,
} from "@fusion/plugin-sdk";
import { createReportApprovalRoutes } from "./routes/report-approval-routes.js";
import { createReportExportRoutes } from "./routes/report-export-routes.js";
import { createReportListRoutes } from "./routes/report-list-routes.js";

/*
FNXC:ReportsAgentTools 2026-07-14-18:47:
Agents need project-scoped report list, inspection, approval, publication, and export capabilities with exactly the same authorization and transition rules as the dashboard API. Route delegation keeps one policy implementation: agent decisions identify the agent explicitly and cannot bypass configured approver gates.
*/

function textResult(text: string, details?: Record<string, unknown>, isError = false): PluginToolResult {
  return { content: [{ type: "text", text }], details, isError };
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function routeResponse(value: unknown): PluginRouteResponse {
  if (!value || typeof value !== "object" || typeof (value as { status?: unknown }).status !== "number") {
    return { status: 200, body: value };
  }
  return value as PluginRouteResponse;
}

async function invokeRoute(
  routes: PluginRouteDefinition[],
  method: PluginRouteDefinition["method"],
  path: string,
  request: unknown,
  ctx: PluginContext,
): Promise<PluginRouteResponse> {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`Reports tool route unavailable: ${method} ${path}`);
  return routeResponse(await route.handler(request, ctx));
}

function responseResult(response: PluginRouteResponse, successText: string): PluginToolResult {
  const isError = response.status >= 400;
  const body = response.body;
  const error = body && typeof body === "object" && "error" in body
    ? String((body as { error: unknown }).error)
    : `Reports request failed with status ${response.status}`;
  return textResult(isError ? error : successText, { status: response.status, body }, isError);
}

export function createReportTools(
  routes: PluginRouteDefinition[] = [
    ...createReportListRoutes(),
    ...createReportExportRoutes(),
    ...createReportApprovalRoutes(),
  ],
): PluginToolDefinition[] {
  return [
    {
      name: "reports_list",
      description: "List project reports, optionally filtered by cadence, status, date range, title text, or agent id.",
      parameters: {
        type: "object",
        properties: {
          cadence: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly", "manual"] },
          status: { type: "string" },
          from: { type: "string", description: "Inclusive ISO period start." },
          to: { type: "string", description: "Inclusive ISO period end." },
          query: { type: "string", description: "Case-insensitive title search." },
          agentId: { type: "string" },
        },
        required: [],
      },
      execute: async (params, ctx) => {
        const response = await invokeRoute(routes, "GET", "/reports", {
          params: {},
          query: {
            cadence: stringParam(params, "cadence"),
            status: stringParam(params, "status"),
            from: stringParam(params, "from"),
            to: stringParam(params, "to"),
            q: stringParam(params, "query"),
            agentId: stringParam(params, "agentId"),
          },
        }, ctx);
        const count = Array.isArray((response.body as { reports?: unknown[] } | undefined)?.reports)
          ? (response.body as { reports: unknown[] }).reports.length
          : 0;
        return responseResult(response, `Found ${count} report${count === 1 ? "" : "s"}.`);
      },
    },
    {
      name: "reports_get",
      description: "Get one project report with its review and approval state.",
      parameters: {
        type: "object",
        properties: { reportId: { type: "string" } },
        required: ["reportId"],
      },
      execute: async (params, ctx) => {
        const reportId = stringParam(params, "reportId");
        if (!reportId) return textResult("reportId is required.", { code: "validation_error" }, true);
        const response = await invokeRoute(routes, "GET", "/reports/:id", { params: { id: reportId } }, ctx);
        return responseResult(response, `Loaded report ${reportId}.`);
      },
    },
    {
      name: "reports_decide",
      description: "Approve, reject, or publish a project report as a configured agent approver.",
      parameters: {
        type: "object",
        properties: {
          reportId: { type: "string" },
          action: { type: "string", enum: ["approve", "reject", "publish"] },
          actorId: { type: "string", description: "Agent id used for the configured approver authorization check." },
          note: { type: "string" },
        },
        required: ["reportId", "action", "actorId"],
      },
      execute: async (params, ctx) => {
        const reportId = stringParam(params, "reportId");
        const action = stringParam(params, "action");
        const actorId = stringParam(params, "actorId");
        if (!reportId || !actorId || !action || !["approve", "reject", "publish"].includes(action)) {
          return textResult("reportId, actorId, and a valid action are required.", { code: "validation_error" }, true);
        }
        const response = await invokeRoute(routes, "POST", `/reports/:id/${action}`, {
          params: { id: reportId },
          headers: { "x-fusion-actor-type": "agent", "x-fusion-user": actorId },
          body: { note: stringParam(params, "note") },
        }, ctx);
        return responseResult(response, `${action} decision applied to report ${reportId}.`);
      },
    },
    {
      name: "reports_export_html",
      description: "Export a generated project report as standalone HTML and return the HTML plus response metadata.",
      parameters: {
        type: "object",
        properties: { reportId: { type: "string" } },
        required: ["reportId"],
      },
      execute: async (params, ctx) => {
        const reportId = stringParam(params, "reportId");
        if (!reportId) return textResult("reportId is required.", { code: "validation_error" }, true);
        const response = await invokeRoute(routes, "GET", "/reports/:id/export.html", { params: { id: reportId } }, ctx);
        return responseResult(response, `Exported report ${reportId} as HTML.`);
      },
    },
  ];
}

export const reportTools = createReportTools();

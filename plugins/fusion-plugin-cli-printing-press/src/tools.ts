import type {
  PluginContext,
  PluginRouteDefinition,
  PluginRouteResponse,
  PluginToolDefinition,
  PluginToolResult,
} from "@fusion/plugin-sdk";
import { createCliPrintingPressRoutes } from "./routes/wizard-routes.js";

/*
FNXC:CliPrintingPressAgentTools 2026-07-14-18:47:
Agents need project-scoped CRUD, generation, and test access to CLI definitions. Every tool delegates to the existing plugin routes so draft validation, PostgreSQL ownership, generated-artifact checks, credential handling, and execution limits remain identical across agent and dashboard workflows.
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
  if (!route) throw new Error(`CLI Printing Press tool route unavailable: ${method} ${path}`);
  return routeResponse(await route.handler(request, ctx));
}

function responseResult(response: PluginRouteResponse, successText: string): PluginToolResult {
  const isError = response.status >= 400;
  const body = response.body;
  const error = body && typeof body === "object" && "error" in body
    ? String((body as { error: unknown }).error)
    : `CLI Printing Press request failed with status ${response.status}`;
  return textResult(isError ? error : successText, { status: response.status, body }, isError);
}

const draftSchema = {
  type: "object",
  description: "A complete ServiceDraft; create/update use the same validation as the dashboard wizard.",
  additionalProperties: true,
};

export function createCliPrintingPressTools(
  routes: PluginRouteDefinition[] = createCliPrintingPressRoutes(),
): PluginToolDefinition[] {
  return [
    {
      name: "cli_press_list",
      description: "List CLI service definitions in the current project.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_params, ctx) => {
        const response = await invokeRoute(routes, "GET", "/drafts", { params: {} }, ctx);
        const count = Array.isArray(response.body) ? response.body.length : 0;
        return responseResult(response, `Found ${count} CLI definition${count === 1 ? "" : "s"}.`);
      },
    },
    {
      name: "cli_press_get",
      description: "Get one complete CLI service definition from the current project.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async (params, ctx) => {
        const id = stringParam(params, "id");
        if (!id) return textResult("id is required.", { code: "validation_error" }, true);
        const response = await invokeRoute(routes, "GET", "/drafts/:id", { params: { id } }, ctx);
        return responseResult(response, `Loaded CLI definition ${id}.`);
      },
    },
    {
      name: "cli_press_create",
      description: "Create a validated CLI service definition in the current project.",
      parameters: { type: "object", properties: { draft: draftSchema }, required: ["draft"] },
      execute: async (params, ctx) => {
        const response = await invokeRoute(routes, "POST", "/drafts", { params: {}, body: params.draft }, ctx);
        return responseResult(response, "Created CLI definition.");
      },
    },
    {
      name: "cli_press_update",
      description: "Replace one CLI service definition after full wizard validation.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, draft: draftSchema },
        required: ["id", "draft"],
      },
      execute: async (params, ctx) => {
        const id = stringParam(params, "id");
        if (!id) return textResult("id is required.", { code: "validation_error" }, true);
        const response = await invokeRoute(routes, "PUT", "/drafts/:id", { params: { id }, body: params.draft }, ctx);
        return responseResult(response, `Updated CLI definition ${id}.`);
      },
    },
    {
      name: "cli_press_delete",
      description: "Delete one CLI service definition and its PostgreSQL-owned dependent records.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async (params, ctx) => {
        const id = stringParam(params, "id");
        if (!id) return textResult("id is required.", { code: "validation_error" }, true);
        const response = await invokeRoute(routes, "DELETE", "/drafts/:id", { params: { id } }, ctx);
        return responseResult(response, `Deleted CLI definition ${id}.`);
      },
    },
    {
      name: "cli_press_generate",
      description: "Generate or regenerate the executable artifact for a validated CLI definition.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async (params, ctx) => {
        const id = stringParam(params, "id");
        if (!id) return textResult("id is required.", { code: "validation_error" }, true);
        const response = await invokeRoute(routes, "POST", "/drafts/:id/regenerate", { params: { id } }, ctx);
        return responseResult(response, `Generated CLI definition ${id}.`);
      },
    },
    {
      name: "cli_press_test",
      description: "Run one endpoint from a generated CLI definition with bounded parameters, credentials, and timeout.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          endpointId: { type: "string" },
          params: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
          credentials: { type: "object", additionalProperties: { type: "string" } },
          timeoutMs: { type: "number", minimum: 1, maximum: 300000 },
        },
        required: ["id", "endpointId", "params"],
      },
      execute: async (params, ctx) => {
        const id = stringParam(params, "id");
        if (!id) return textResult("id is required.", { code: "validation_error" }, true);
        const response = await invokeRoute(routes, "POST", "/drafts/:id/run", {
          params: { id },
          body: {
            endpointId: params.endpointId,
            params: params.params,
            credentials: params.credentials,
            timeoutMs: params.timeoutMs,
          },
        }, ctx);
        return responseResult(response, `Tested CLI definition ${id}.`);
      },
    },
  ];
}

export const cliPrintingPressTools = createCliPrintingPressTools();

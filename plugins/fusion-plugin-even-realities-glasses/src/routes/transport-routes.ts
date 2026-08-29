import type { PluginContext, PluginRouteDefinition } from "@fusion/plugin-sdk";
import type { GlassesAction, WebhookGlassesTransport } from "../transport.js";
import { requireApiKey } from "./quick-capture-routes.js";

function parseAction(body: unknown): GlassesAction | null {
  if (!body || typeof body !== "object") return null;
  const input = body as Record<string, unknown>;
  if (input.type !== "start-work" && input.type !== "request-review" && input.type !== "quick-capture") {
    return null;
  }
  if (typeof input.timestamp !== "string" || input.timestamp.trim().length === 0) return null;

  return {
    type: input.type,
    taskId: typeof input.taskId === "string" ? input.taskId : undefined,
    text: typeof input.text === "string" ? input.text : undefined,
    timestamp: input.timestamp,
  };
}

export function createTransportRoutes(
  getTransport: (ctx: PluginContext) => WebhookGlassesTransport | undefined,
): PluginRouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/transport/actions",
      handler: async (req, ctx) => {
        const auth = requireApiKey(ctx, req as { headers?: Record<string, string | string[] | undefined> });
        if (!auth.ok) return auth.response;

        const transport = getTransport(ctx);
        if (!transport) return { status: 503, body: { error: "transport not running" } };

        const action = parseAction((req as { body?: unknown }).body);
        if (!action) return { status: 400, body: { error: "invalid action payload" } };

        await transport.receiveAction(action);
        return { status: 202, body: { accepted: true } };
      },
    },
  ];
}

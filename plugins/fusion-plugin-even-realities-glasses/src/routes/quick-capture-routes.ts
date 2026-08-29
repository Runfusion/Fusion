import { createHash, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginRouteDefinition, PluginRouteResponse } from "@fusion/plugin-sdk";
import { runQuickCapture, GlassesInputError } from "../quick-capture.js";
import { getQuickCaptureColumn } from "../settings.js";

function toDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function readBearer(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = headers.authorization ?? headers.Authorization;
  const header = Array.isArray(auth) ? auth[0] : auth;
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function requireApiKey(
  ctx: PluginContext,
  req: { headers?: Record<string, string | string[] | undefined> },
): { ok: true } | { ok: false; response: PluginRouteResponse } {
  const expected = typeof ctx.settings.apiKey === "string" ? ctx.settings.apiKey.trim() : "";
  if (!expected) {
    return { ok: false, response: { status: 503, body: { error: "plugin not configured" } } };
  }
  const provided = readBearer(req.headers ?? {});
  if (!provided) {
    return { ok: false, response: { status: 401, body: { error: "unauthorized" } } };
  }
  const valid = timingSafeEqual(toDigest(expected), toDigest(provided));
  if (!valid) {
    return { ok: false, response: { status: 401, body: { error: "unauthorized" } } };
  }
  return { ok: true };
}

export const quickCaptureRoutes: PluginRouteDefinition[] = [
  {
    method: "POST",
    path: "/quick-capture",
    handler: async (req, ctx) => {
      const auth = requireApiKey(ctx, req as { headers?: Record<string, string | string[] | undefined> });
      if (!auth.ok) return auth.response;

      const body = (req as { body?: unknown }).body;
      const payload = typeof body === "object" && body ? (body as Record<string, unknown>) : {};

      const defaultColumn = getQuickCaptureColumn(ctx.settings);

      try {
        const result = await runQuickCapture(
          { text: payload.text, column: payload.column },
          { taskStore: ctx.taskStore, pluginId: ctx.pluginId, defaultColumn },
        );
        return { status: 201, body: result };
      } catch (error) {
        if (error instanceof GlassesInputError) {
          return { status: error.status, body: { error: error.message } };
        }
        ctx.logger?.error?.("quick capture failed", error);
        return { status: 500, body: { error: "quick capture failed" } };
      }
    },
  },
];

import { createHash, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginRouteResponse } from "@fusion/plugin-sdk";

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
  req: { headers: Record<string, string | string[] | undefined> },
): { ok: true } | { ok: false; response: PluginRouteResponse } {
  const expected = typeof ctx.settings.apiKey === "string" ? ctx.settings.apiKey.trim() : "";
  if (!expected) {
    return { ok: false, response: { status: 503, body: { error: "plugin not configured" } } };
  }

  const provided = readBearer(req.headers ?? {});
  if (!provided) {
    return { ok: false, response: { status: 401, body: { error: "unauthorized" } } };
  }

  const expectedDigest = toDigest(expected);
  const providedDigest = toDigest(provided);
  const valid = timingSafeEqual(expectedDigest, providedDigest);

  if (!valid) {
    return { ok: false, response: { status: 401, body: { error: "unauthorized" } } };
  }

  return { ok: true };
}

/**
 * FNXC:CodeOrganization 2026-07-15-16:00:
 * Dashboard API client core (fetch wrapper + ApiRequestError).
 */
import { getAuthToken, withTokenHeader } from "../../auth";
import type { DedupeOptions } from "./dedupe.js";
// FNXC:TaskDeleteAttribution 2026-07-26-17:05: import the browser-safe leaf, not the package root — the root alias resolves to `core/src/types.ts` in the client bundle and does not carry these constants.
import { FUSION_CLIENT_HEADER, FUSION_DASHBOARD_UI_CLIENT } from "@fusion/core/task-delete-attribution";

/**
 * FNXC:DashboardApi 2026-07-15-13:25:
 * Options accepted by deduped fetchers. Pass `{ forceFresh: true }` after a
 * mutation to bypass any in-flight pre-mutation request and force a new one.
 */
export type FetchOptions = DedupeOptions;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.details = details;
  }
}

/*
FNXC:DashboardApi 2026-08-16-03:09:
Planning Retry showed the raw fetch diagnostic "API returned text/plain; charset=utf-8 instead of JSON
for /api/planning/:id/retry ... (503 ) Response: no available server". Fusion never emits that body —
it is a reverse-proxy 502/503/504 (Traefik's exact phrase is "no available server") when no healthy
backend is in the pool. Operators need a retryable unavailable message, not a content-type dump.
The same parse path is shared by every dashboard `api()` caller, so classify here rather than only in
the Planning banner.
*/
export const SERVER_UNAVAILABLE_MESSAGE =
  "The server is temporarily unavailable. Please try again.";

export function isGatewayUnavailableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export function looksLikeHtml(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML");
}

export function errorFromUnparseableApiResponse(args: {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  bodyText: string;
}): Error {
  if (isGatewayUnavailableStatus(args.status)) {
    return new ApiRequestError(SERVER_UNAVAILABLE_MESSAGE, args.status);
  }

  const isHtml = args.contentType.includes("text/html") || looksLikeHtml(args.bodyText);
  if (isHtml) {
    return new Error(
      `API returned HTML instead of JSON for ${args.url}. ` +
      `The endpoint may not be properly configured. (${args.status} ${args.statusText})`
    );
  }

  const preview = args.bodyText.length > 160 ? `${args.bodyText.slice(0, 160)}...` : args.bodyText;
  return new Error(
    `API returned ${args.contentType || "an unknown content type"} instead of JSON for ${args.url}. ` +
    `(${args.status} ${args.statusText})${preview ? ` Response: ${preview}` : ""}`
  );
}

export function buildApiUrl(path: string): string {
  return `/api${path}`;
}

/**
 * FNXC:TaskDeleteAttribution 2026-07-26-14:30:
 * Stamp every dashboard-originated request with `x-fusion-client: dashboard-ui` so server-side
 * run-audit can tell an operator's click apart from an unlabeled script or agent hitting the same
 * endpoint (the four-delete incident where `DELETE /api/tasks/:id` rows were byte-identical
 * regardless of who called). Applied once here rather than per-call so no future mutation route
 * has to remember it; the desktop shell mounts this same App and therefore inherits it.
 *
 * Self-reported and explicitly NOT a security boundary — anything can send this header. It
 * separates "the client said it was the dashboard UI" from "nothing identified itself"; no
 * authorization decision may depend on it. An existing explicit value is left alone.
 */
function applyClientIdentityHeader(headers: Headers): void {
  if (!headers.has(FUSION_CLIENT_HEADER)) {
    headers.set(FUSION_CLIENT_HEADER, FUSION_DASHBOARD_UI_CLIENT);
  }
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = buildApiUrl(path);
  const token = getAuthToken();
  const headers = (() => {
    if (token) {
      const authenticatedHeaders = new Headers(opts.headers ?? {});
      if (!authenticatedHeaders.has("Content-Type")) {
        authenticatedHeaders.set("Content-Type", "application/json");
      }
      applyClientIdentityHeader(authenticatedHeaders);
      return withTokenHeader(authenticatedHeaders);
    }

    const defaultHeaders = new Headers(opts.headers ?? {});
    if (!defaultHeaders.has("Content-Type")) {
      defaultHeaders.set("Content-Type", "application/json");
    }
    applyClientIdentityHeader(defaultHeaders);
    return Object.fromEntries(defaultHeaders.entries());
  })();

  const res = await fetch(url, {
    ...opts,
    headers,
  });

  /*
   * FNXC:DashboardApi 2026-07-15-13:25:
   * Successful 204 responses (for example DELETE and reorder) have no body or
   * JSON content type, so return undefined for void endpoints before parsing.
   */
  if (res.status === 204) {
    if (!res.ok) {
      // 204 is always ok by definition, but guard anyway
      throw new Error(`Request failed for ${url}: ${res.status} ${res.statusText}`);
    }
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  const bodyText = await res.text();
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    throw errorFromUnparseableApiResponse({
      url,
      status: res.status,
      statusText: res.statusText,
      contentType,
      bodyText,
    });
  }

  let data: unknown;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    if (isGatewayUnavailableStatus(res.status)) {
      throw new ApiRequestError(SERVER_UNAVAILABLE_MESSAGE, res.status);
    }
    throw new Error(
      `API returned invalid JSON for ${url}. (${res.status} ${res.statusText})`
    );
  }

  if (!res.ok) {
    const payload = data as { error?: string; details?: Record<string, unknown> } | null;
    throw new ApiRequestError(
      payload?.error || `Request failed for ${url}: ${res.status} ${res.statusText}`,
      res.status,
      payload?.details,
    );
  }

  return data as T;
}

/**
 * Rewrite a path to route through the node proxy when viewing a remote node.
 * When nodeId is provided and differs from localNodeId (i.e., it's a remote node),
 * rewrites the path from `/tasks` to `/proxy/${encodeURIComponent(nodeId)}/tasks`.
 * When nodeId is undefined or matches localNodeId, returns the path unchanged.
 */
export function withNodeId(path: string, nodeId?: string, localNodeId?: string): string {
  if (!nodeId || nodeId === localNodeId) return path;
  // Rewrite path to proxy endpoint: /tasks -> /proxy/:nodeId/tasks
  // Strip leading /api prefix if present since proxyApi adds it
  const apiPrefix = "/api";
  const pathWithoutPrefix = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;
  return `/proxy/${encodeURIComponent(nodeId)}${pathWithoutPrefix}`;
}

/**
 * Make an API request, optionally routing through the node proxy for remote nodes.
 * When nodeId is provided and differs from localNodeId, the request is routed
 * through /api/proxy/:nodeId/... instead of directly.
 */
export function proxyApi<T>(path: string, opts?: RequestInit & { nodeId?: string; localNodeId?: string }): Promise<T> {
  // Extract nodeId/localNodeId from opts before passing to api()
  const { nodeId, localNodeId, ...fetchOpts } = opts ?? {};
  const resolvedPath = withNodeId(path, nodeId, localNodeId);
  return api<T>(resolvedPath, fetchOpts);
}

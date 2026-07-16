/**
 * FNXC:CodeOrganization 2026-07-15-16:00:
 * Dashboard API client core (fetch wrapper + ApiRequestError).
 */
import { getAuthToken, withTokenHeader } from "../auth";
import type { DedupeOptions } from "./dedupe";

/** Options accepted by deduped fetchers. Pass `{ forceFresh: true }` after a
 *  mutation to bypass any in-flight pre-mutation request and force a new one. */
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

export function looksLikeHtml(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML");
}

export function buildApiUrl(path: string): string {
  return `/api${path}`;
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
      return withTokenHeader(authenticatedHeaders);
    }

    if (!opts.headers) {
      return { "Content-Type": "application/json" };
    }

    const defaultHeaders = new Headers(opts.headers);
    if (!defaultHeaders.has("Content-Type")) {
      defaultHeaders.set("Content-Type", "application/json");
    }
    return Object.fromEntries(defaultHeaders.entries());
  })();

  const res = await fetch(url, {
    ...opts,
    headers,
  });

  // Handle successful 204 No Content responses (e.g., DELETE, reorder)
  // These return no body and no JSON content-type — return undefined for void endpoints
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
  const isHtml = contentType.includes("text/html") || looksLikeHtml(bodyText);

  if (isHtml) {
    throw new Error(
      `API returned HTML instead of JSON for ${url}. ` +
      `The endpoint may not be properly configured. (${res.status} ${res.statusText})`
    );
  }

  if (!isJson) {
    const preview = bodyText.length > 160 ? `${bodyText.slice(0, 160)}...` : bodyText;
    throw new Error(
      `API returned ${contentType || "an unknown content type"} instead of JSON for ${url}. ` +
      `(${res.status} ${res.statusText})${preview ? ` Response: ${preview}` : ""}`
    );
  }

  let data: unknown;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
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

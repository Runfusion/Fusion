/**
 * FNXC:CloudLink 2026-08-21-22:30:
 * HTTP client for the cloud-link control plane (/v1/pair, heartbeat, redeem).
 * HTTPS required except loopback HTTP for local development. Requests time out.
 */
import {
  FUSION_CLOUD_LINK_PROTOCOL,
  FUSION_CLOUD_LINK_VERSION,
  type CloudEngineCapabilities,
  type CloudPairCompleteResult,
  type CloudPairStartResult,
  type CloudReachabilityCandidate,
  type CloudRedeemResult,
} from "./types.js";

export const CLOUD_LINK_REQUEST_TIMEOUT_MS = 15_000;

export class CloudLinkHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "CloudLinkHttpError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Normalize and validate a cloud control-plane base URL.
 * Rejects cleartext HTTP except loopback (local Convex / dev).
 */
export function normalizeCloudControlPlaneUrl(httpBaseUrl: string): string {
  const trimmed = httpBaseUrl.trim();
  if (!trimmed) {
    throw new CloudLinkHttpError("Cloud HTTP URL is required", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CloudLinkHttpError("Cloud HTTP URL is invalid", 400);
  }
  if (parsed.protocol === "https:") {
    return parsed.origin;
  }
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return parsed.origin;
  }
  throw new CloudLinkHttpError(
    "Cloud HTTP URL must be https:// (http:// is only allowed for localhost)",
    400,
  );
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUD_LINK_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new CloudLinkHttpError(
        `Cloud control-plane request timed out after ${CLOUD_LINK_REQUEST_TIMEOUT_MS}ms: ${url}`,
        504,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      typeof json.message === "string"
        ? json.message
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${res.status}`;
    throw new CloudLinkHttpError(msg, res.status, json);
  }
  return json as T;
}

export async function cloudPairStart(
  httpBaseUrl: string,
  opts: { engineName?: string } = {},
): Promise<CloudPairStartResult> {
  const base = normalizeCloudControlPlaneUrl(httpBaseUrl);
  const result = await postJson<{
    code: string;
    pendingSecret: string;
    expiresAt?: string;
  }>(`${base}/v1/pair/start`, {
    engineName: opts.engineName ?? "fusion-engine",
  });
  return {
    code: result.code,
    pendingSecret: result.pendingSecret,
    expiresAt: result.expiresAt,
  };
}

export async function cloudPairComplete(
  httpBaseUrl: string,
  opts: { code: string; pendingSecret: string },
): Promise<CloudPairCompleteResult> {
  const base = normalizeCloudControlPlaneUrl(httpBaseUrl);
  const result = await postJson<{
    engineId: string;
    deviceSecret: string;
    name: string;
  }>(`${base}/v1/pair/complete`, {
    code: opts.code,
    pendingSecret: opts.pendingSecret,
  });
  return {
    engineId: result.engineId,
    deviceSecret: result.deviceSecret,
    name: result.name,
  };
}

export async function cloudHeartbeat(
  httpBaseUrl: string,
  opts: {
    engineId: string;
    deviceSecret: string;
    candidates: CloudReachabilityCandidate[];
    capabilities?: Partial<CloudEngineCapabilities>;
  },
): Promise<{ status: string }> {
  const base = normalizeCloudControlPlaneUrl(httpBaseUrl);
  const capabilities: CloudEngineCapabilities = {
    headless: opts.capabilities?.headless ?? true,
    dashboard: opts.capabilities?.dashboard ?? true,
    sharedPostgres: opts.capabilities?.sharedPostgres ?? false,
    meshMembership: opts.capabilities?.meshMembership ?? false,
    protocolVersion: opts.capabilities?.protocolVersion ?? FUSION_CLOUD_LINK_VERSION,
    fusionVersion: opts.capabilities?.fusionVersion,
  };
  const result = await postJson<{ status: string }>(
    `${base}/v1/engine/heartbeat`,
    {
      protocol: FUSION_CLOUD_LINK_PROTOCOL,
      version: FUSION_CLOUD_LINK_VERSION,
      engineId: opts.engineId,
      candidates: opts.candidates,
      capabilities,
    },
    { Authorization: `Bearer ${opts.deviceSecret}` },
  );
  return { status: result.status };
}

export async function cloudRedeemTicket(
  httpBaseUrl: string,
  opts: { ticket: string; engineId?: string },
): Promise<CloudRedeemResult> {
  const base = normalizeCloudControlPlaneUrl(httpBaseUrl);
  const result = await postJson<{
    engineId: string;
    userId: string;
    localSessionToken: string;
    candidates?: CloudReachabilityCandidate[];
  }>(`${base}/v1/tickets/redeem`, {
    ticket: opts.ticket,
    engineId: opts.engineId,
  });
  return {
    engineId: result.engineId,
    userId: result.userId,
    localSessionToken: result.localSessionToken,
    candidates: result.candidates ?? [],
  };
}

export function buildCloudLoginHandoffUrl(
  engineOrigin: string,
  ticket: string,
): string {
  const origin = new URL(engineOrigin);
  const path = new URL("/remote-login", origin.origin);
  path.searchParams.set("cloudTicket", ticket);
  return path.toString();
}

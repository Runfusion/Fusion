/**
 * FNXC:CloudLink 2026-08-17-23:45:
 * HTTP client for Fusion Cloud control plane (.convex.site /v1/*).
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

function normalizeBase(httpBaseUrl: string): string {
  return httpBaseUrl.trim().replace(/\/$/, "");
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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
  const base = normalizeBase(httpBaseUrl);
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
  const base = normalizeBase(httpBaseUrl);
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
  const base = normalizeBase(httpBaseUrl);
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
  const base = normalizeBase(httpBaseUrl);
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

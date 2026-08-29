/**
 * FNXC:CodeOrganization 2026-07-16-20:00:
 * Remote access / tunnel client API peeled from legacy.ts.
 */
import { api } from "../client/client.js";
import { withProjectId } from "../client/health.js";

export interface RemoteSettings {
  remoteActiveProvider: "tailscale" | "cloudflare" | null;
  remoteTailscaleEnabled: boolean;
  remoteTailscaleHostname: string;
  remoteTailscaleTargetPort: number;
  remoteTailscaleAcceptRoutes: boolean;
  remoteCloudflareEnabled: boolean;
  remoteCloudflareQuickTunnel: boolean;
  remoteCloudflareTunnelName: string;
  remoteCloudflareTunnelToken: string | null;
  remoteCloudflareIngressUrl: string;
  remotePersistentToken: string | null;
  remoteShortLivedEnabled: boolean;
  remoteShortLivedTtlMs: number;
  remoteShortLivedMaxTtlMs: number;
  remoteRememberLastRunning: boolean;
  remoteWasRunningOnShutdown: boolean;
  remoteLastStartedProvider: "tailscale" | "cloudflare" | null;
}

export interface RemoteStatus {
  provider: "tailscale" | "cloudflare" | null;
  state: "stopped" | "starting" | "running" | "stopping" | "failed";
  url: string | null;
  lastError: string | null;
  lastErrorCode?: string | null;
  cloudflaredAvailable?: boolean | null;
  externalTunnel?: {
    provider: "tailscale" | "cloudflare";
    url: string | null;
  } | null;
  restore?: {
    outcome: "applied" | "skipped" | "failed";
    reason: string;
    at: string;
    provider: "tailscale" | "cloudflare" | null;
    message?: string;
  };
}

export function fetchRemoteSettings(projectId?: string): Promise<{ settings: RemoteSettings }> {
  return api<{ settings: RemoteSettings }>(withProjectId("/remote/settings", projectId));
}

export function updateRemoteSettings(
  settings: Partial<RemoteSettings>,
  projectId?: string,
): Promise<{ settings: RemoteSettings }> {
  return api<{ settings: RemoteSettings }>(withProjectId("/remote/settings", projectId), {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function fetchRemoteStatus(projectId?: string): Promise<RemoteStatus> {
  return api<RemoteStatus>(withProjectId("/remote/status", projectId));
}

export function installCloudflared(projectId?: string): Promise<{ success: boolean; command: string; error?: string }> {
  return api(withProjectId("/remote/install-cloudflared", projectId), {
    method: "POST",
  });
}

export function activateRemoteProvider(provider: "tailscale" | "cloudflare", projectId?: string): Promise<{ activeProvider: "tailscale" | "cloudflare" }> {
  return api<{ activeProvider: "tailscale" | "cloudflare" }>(withProjectId("/remote/provider/activate", projectId), {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export function startRemoteTunnel(projectId?: string): Promise<{ state: "starting" | "running"; provider: string }> {
  return api<{ state: "starting" | "running"; provider: string }>(withProjectId("/remote/tunnel/start", projectId), {
    method: "POST",
  });
}

export function stopRemoteTunnel(projectId?: string): Promise<{ state: "stopped"; provider: string | null }> {
  return api<{ state: "stopped"; provider: string | null }>(withProjectId("/remote/tunnel/stop", projectId), {
    method: "POST",
  });
}

export function killExternalTunnel(projectId?: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(withProjectId("/remote/tunnel/kill-external", projectId), {
    method: "POST",
  });
}

export function regenerateRemotePersistentToken(projectId?: string): Promise<{ token: string; maskedToken: string }> {
  return api<{ token: string; maskedToken: string }>(withProjectId("/remote/token/persistent/regenerate", projectId), {
    method: "POST",
  });
}

export function generateShortLivedRemoteToken(ttlMs: number, projectId?: string): Promise<{ token: string; expiresAt: string; ttlMs: number }> {
  return api<{ token: string; expiresAt: string; ttlMs: number }>(withProjectId("/remote/token/short-lived/generate", projectId), {
    method: "POST",
    body: JSON.stringify({ ttlMs }),
  });
}

type RemoteAuthTokenType = "persistent" | "short-lived";

type RemoteLinkRequestOptions = {
  projectId?: string;
  tokenType?: RemoteAuthTokenType;
  ttlMs?: number;
};

function buildRemoteAuthQuery(
  format: "text" | "image/svg" | null,
  tokenType: RemoteAuthTokenType,
  ttlMs?: number,
): string {
  const params = new URLSearchParams();
  if (format) {
    params.set("format", format);
  }
  params.set("tokenType", tokenType);
  if (tokenType === "short-lived" && typeof ttlMs === "number" && Number.isFinite(ttlMs)) {
    params.set("ttlMs", String(ttlMs));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function fetchRemoteUrl(
  options: RemoteLinkRequestOptions = {},
): Promise<{ url: string; tokenType: RemoteAuthTokenType; expiresAt: string | null }> {
  const { projectId, tokenType = "persistent", ttlMs } = options;
  const query = buildRemoteAuthQuery(null, tokenType, ttlMs);
  return api<{ url: string; tokenType: RemoteAuthTokenType; expiresAt: string | null }>(withProjectId(`/remote/url${query}`, projectId));
}

export function fetchRemoteQr(
  format: "text" | "image/svg" = "text",
  options: RemoteLinkRequestOptions = {},
): Promise<{ url: string; tokenType: RemoteAuthTokenType; expiresAt: string | null; format: "text" | "image/svg"; data?: string }> {
  const { projectId, tokenType = "persistent", ttlMs } = options;
  const query = buildRemoteAuthQuery(format, tokenType, ttlMs);
  return api<{ url: string; tokenType: RemoteAuthTokenType; expiresAt: string | null; format: "text" | "image/svg"; data?: string }>(withProjectId(`/remote/qr${query}`, projectId));
}


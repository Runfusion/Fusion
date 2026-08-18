/**
 * FNXC:CloudLink 2026-08-21-22:25:
 * Cloud-link Mode A client types. Engines pair/heartbeat/redeem against a
 * configured cloud HTTP base (FUSION_CLOUD_HTTP_URL); boards stay local.
 */

export const FUSION_CLOUD_LINK_PROTOCOL = "fusion.cloud-link" as const;
export const FUSION_CLOUD_LINK_VERSION = "0.1.0" as const;
export const CLOUD_TICKET_QUERY = "cloudTicket" as const;

export type CloudCandidateKind =
  | "lan"
  | "tailscale"
  | "cloudflare"
  | "public"
  | "other";

export interface CloudReachabilityCandidate {
  kind: CloudCandidateKind;
  url: string;
  priority: number;
  expiresAt?: string;
  tls: boolean;
}

export interface CloudEngineCapabilities {
  headless: boolean;
  dashboard: boolean;
  sharedPostgres: boolean;
  meshMembership: boolean;
  protocolVersion: string;
  fusionVersion?: string;
}

export interface CloudLinkDeviceState {
  httpBaseUrl: string;
  engineId: string;
  deviceSecret: string;
  name?: string;
  linkedAt: string;
}

export interface CloudPairStartResult {
  code: string;
  pendingSecret: string;
  expiresAt?: string;
}

export interface CloudPairCompleteResult {
  engineId: string;
  deviceSecret: string;
  name: string;
}

export interface CloudRedeemResult {
  engineId: string;
  userId: string;
  localSessionToken: string;
  candidates: CloudReachabilityCandidate[];
}

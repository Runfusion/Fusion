/**
 * FNXC:CloudLink 2026-08-17-23:45:
 * Fusion Cloud Mode A client types. Control plane is Runfusion/fusion-cloud (Convex).
 * Engines pair/heartbeat/redeem; boards stay local. Aligns with fusion-cloud docs/PROTOCOL.md.
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

/**
 * FNXC:CloudLink 2026-08-22-00:40:
 * Reachability candidates Fusion publishes to Cloud Link. Cloudflare Quick Tunnel
 * URLs are first-class (kind=cloudflare) so the console can open a remote instance
 * without LAN. When cloudflared rotates the trycloudflare host, the next heartbeat
 * replaces the previous candidate list — Cloud stores whatever the instance last sent.
 */
import { networkInterfaces } from "node:os";
import type { CloudCandidateKind, CloudReachabilityCandidate } from "./types.js";

/** Quick tunnels are ephemeral; hint Cloud they should not be treated as forever-stable. */
export const CLOUDFLARE_QUICK_TUNNEL_TTL_MS = 12 * 60 * 60 * 1000;
export const CLOUD_LINK_HEARTBEAT_MS = 20_000;

export function originOf(url: string): string {
  return new URL(url).origin;
}

export function classifyCandidateUrl(url: string): CloudCandidateKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host.endsWith(".trycloudflare.com") || host.endsWith(".cfargotunnel.com")) {
    return "cloudflare";
  }
  if (host.endsWith(".ts.net") || /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return "tailscale";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) {
    return "lan";
  }
  if (parsed.protocol === "https:") return "public";
  return "lan";
}

export function candidateFromUrl(
  url: string,
  now = Date.now(),
): CloudReachabilityCandidate {
  const origin = originOf(url);
  const kind = classifyCandidateUrl(origin);
  const tls = origin.startsWith("https://");
  const priority =
    kind === "cloudflare" ? 20 : kind === "public" ? 30 : kind === "tailscale" ? 40 : 80;
  const candidate: CloudReachabilityCandidate = {
    kind,
    url: origin,
    priority,
    tls,
  };
  if (kind === "cloudflare") {
    candidate.expiresAt = new Date(now + CLOUDFLARE_QUICK_TUNNEL_TTL_MS).toISOString();
  }
  return candidate;
}

export function lanCandidate(port: number): CloudReachabilityCandidate | null {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      return {
        kind: "lan",
        url: `http://${entry.address}:${port}`,
        priority: 80,
        tls: false,
      };
    }
  }
  return null;
}

export function buildHeartbeatCandidates(opts: {
  tunnelUrl?: string | null;
  extraUrl?: string | null;
  lanPort: number;
  now?: number;
}): CloudReachabilityCandidate[] {
  const now = opts.now ?? Date.now();
  const seen = new Set<string>();
  const out: CloudReachabilityCandidate[] = [];
  const push = (candidate: CloudReachabilityCandidate | null) => {
    if (!candidate) return;
    if (seen.has(candidate.url)) return;
    seen.add(candidate.url);
    out.push(candidate);
  };
  if (opts.tunnelUrl) {
    push(candidateFromUrl(opts.tunnelUrl, now));
  }
  if (opts.extraUrl) {
    push(candidateFromUrl(opts.extraUrl, now));
  }
  push(lanCandidate(opts.lanPort));
  return out;
}

export function tunnelUrlChanged(previous: string | null, next: string | null): boolean {
  if (!next) return false;
  if (!previous) return true;
  try {
    return originOf(previous) !== originOf(next);
  } catch {
    return previous !== next;
  }
}

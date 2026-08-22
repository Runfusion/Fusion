/**
 * FNXC:CloudLink 2026-08-21-22:30:
 * CLI for cloud-link Mode A — pair / complete / heartbeat / status / unlink.
 * Pending pairing is stored separately so pair-start cannot wipe a live link.
 */
import {
  clearCloudLinkPending,
  clearCloudLinkState,
  cloudHeartbeat,
  cloudPairComplete,
  cloudPairStart,
  loadCloudLinkPending,
  loadCloudLinkState,
  normalizeCloudControlPlaneUrl,
  saveCloudLinkPending,
  saveCloudLinkState,
  type CloudReachabilityCandidate,
} from "@fusion/core";
import { networkInterfaces } from "node:os";

function resolveHttpBase(explicit?: string): string {
  const fromEnv = process.env.FUSION_CLOUD_HTTP_URL?.trim();
  const base = (explicit || fromEnv || "").replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "Missing cloud HTTP URL. Pass --http <url> or set FUSION_CLOUD_HTTP_URL.",
    );
  }
  return normalizeCloudControlPlaneUrl(base);
}

function lanCandidate(port: number): CloudReachabilityCandidate | null {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      return {
        kind: "lan",
        url: `http://${entry.address}:${port}`,
        priority: 10,
        tls: false,
      };
    }
  }
  return null;
}

export async function runCloudPairStart(opts: {
  http?: string;
  name?: string;
}): Promise<void> {
  const http = resolveHttpBase(opts.http);
  const started = await cloudPairStart(http, { engineName: opts.name });
  saveCloudLinkPending({
    httpBaseUrl: http,
    code: started.code,
    pendingSecret: started.pendingSecret,
    name: opts.name,
    createdAt: new Date().toISOString(),
  });
  console.log(`Pairing code: ${started.code}`);
  console.log("Claim this code in the cloud console (/pair), then run:");
  console.log("  fn cloud pair-complete");
  if (started.expiresAt) {
    console.log(`Expires: ${started.expiresAt}`);
  }
}

export async function runCloudPairComplete(opts: {
  http?: string;
  code?: string;
  pendingSecret?: string;
}): Promise<void> {
  const pending = loadCloudLinkPending();
  const http = opts.http
    ? resolveHttpBase(opts.http)
    : pending
      ? normalizeCloudControlPlaneUrl(pending.httpBaseUrl)
      : resolveHttpBase(undefined);
  const code = opts.code ?? pending?.code;
  const pendingSecret = opts.pendingSecret ?? pending?.pendingSecret;
  if (!code || !pendingSecret) {
    throw new Error(
      "No pending pairing. Run fn cloud pair-start first, or pass --code and --pending-secret.",
    );
  }
  const completed = await cloudPairComplete(http, { code, pendingSecret });
  saveCloudLinkState({
    httpBaseUrl: http,
    engineId: completed.engineId,
    deviceSecret: completed.deviceSecret,
    name: completed.name,
    linkedAt: new Date().toISOString(),
  });
  clearCloudLinkPending();
  console.log(`Linked engineId: ${completed.engineId}`);
  console.log(`Name: ${completed.name}`);
  console.log("Credentials saved to ~/.fusion/cloud-link.json");
  console.log("Next: fn cloud heartbeat --url <public-or-lan-url>");
}

export async function runCloudHeartbeat(opts: {
  url?: string;
  port?: number;
}): Promise<void> {
  const state = loadCloudLinkState();
  if (!state?.engineId || !state.deviceSecret) {
    throw new Error("Not linked. Run fn cloud pair-start / pair-complete first.");
  }
  const candidates: CloudReachabilityCandidate[] = [];
  if (opts.url) {
    const u = new URL(opts.url);
    candidates.push({
      kind: u.hostname.startsWith("100.") ? "tailscale" : u.protocol === "https:" ? "public" : "lan",
      url: u.origin,
      priority: 20,
      tls: u.protocol === "https:",
    });
  }
  const lan = lanCandidate(opts.port ?? 4040);
  if (lan) candidates.push(lan);
  if (candidates.length === 0) {
    throw new Error("Provide --url <engine-origin> or ensure a LAN IPv4 is available.");
  }

  const result = await cloudHeartbeat(state.httpBaseUrl, {
    engineId: state.engineId,
    deviceSecret: state.deviceSecret,
    candidates,
    capabilities: { headless: true, dashboard: true },
  });
  console.log(new Date().toISOString(), "heartbeat", result.status);
}

export async function runCloudStatus(opts: { json?: boolean } = {}): Promise<void> {
  const state = loadCloudLinkState();
  if (!state) {
    if (opts.json) {
      console.log(JSON.stringify({ linked: false }));
    } else {
      console.log("Not linked to a cloud control plane.");
    }
    return;
  }
  const payload = {
    linked: Boolean(state.engineId && state.deviceSecret),
    engineId: state.engineId || null,
    name: state.name ?? null,
    httpBaseUrl: state.httpBaseUrl,
    linkedAt: state.linkedAt,
  };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Linked: ${payload.linked}`);
    console.log(`Engine: ${payload.engineId ?? "-"} (${payload.name ?? "unnamed"})`);
    console.log(`Cloud:  ${payload.httpBaseUrl}`);
    console.log(`Since:  ${payload.linkedAt}`);
  }
}

export async function runCloudUnlink(): Promise<void> {
  clearCloudLinkState();
  clearCloudLinkPending();
  console.log("Cleared ~/.fusion/cloud-link.json");
}

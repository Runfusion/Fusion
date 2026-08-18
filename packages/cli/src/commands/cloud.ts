/**
 * FNXC:CloudLink 2026-08-17-23:45:
 * CLI for Fusion Cloud Mode A — pair / complete / heartbeat / status / unlink.
 * Control plane lives in Runfusion/fusion-cloud; this is the thin engine client.
 */
import {
  clearCloudLinkState,
  cloudHeartbeat,
  cloudPairComplete,
  cloudPairStart,
  loadCloudLinkState,
  saveCloudLinkState,
  type CloudReachabilityCandidate,
} from "@fusion/core";
import { networkInterfaces } from "node:os";

function resolveHttpBase(explicit?: string): string {
  const fromEnv = process.env.FUSION_CLOUD_HTTP_URL?.trim();
  const base = (explicit || fromEnv || "").replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "Missing cloud HTTP URL. Pass --http <url> or set FUSION_CLOUD_HTTP_URL (Convex .convex.site).",
    );
  }
  return base;
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
  // Stash pending in state file under a temporary shape until complete
  saveCloudLinkState({
    httpBaseUrl: http,
    engineId: "",
    deviceSecret: "",
    name: opts.name,
    linkedAt: new Date().toISOString(),
  });
  // Write pending alongside via env-like sidecar fields in a dedicated pending file is overkill;
  // print secrets for complete step.
  console.log(`Pairing code: ${started.code}`);
  console.log("Claim this code in Fusion Cloud console (/pair), then run:");
  console.log(
    `  fn cloud pair-complete --http ${http} --code ${started.code} --pending-secret ${started.pendingSecret}`,
  );
  if (started.expiresAt) {
    console.log(`Expires: ${started.expiresAt}`);
  }
}

export async function runCloudPairComplete(opts: {
  http?: string;
  code: string;
  pendingSecret: string;
}): Promise<void> {
  const http = resolveHttpBase(opts.http);
  const completed = await cloudPairComplete(http, {
    code: opts.code,
    pendingSecret: opts.pendingSecret,
  });
  saveCloudLinkState({
    httpBaseUrl: http,
    engineId: completed.engineId,
    deviceSecret: completed.deviceSecret,
    name: completed.name,
    linkedAt: new Date().toISOString(),
  });
  console.log(`Linked engineId: ${completed.engineId}`);
  console.log(`Name: ${completed.name}`);
  console.log("Credentials saved to ~/.fusion/cloud-link.json");
  console.log("Next: fn cloud heartbeat --url <public-or-lan-url> [--loop]");
}

export async function runCloudHeartbeat(opts: {
  url?: string;
  port?: number;
  loop?: boolean;
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

  const once = async () => {
    const result = await cloudHeartbeat(state.httpBaseUrl, {
      engineId: state.engineId,
      deviceSecret: state.deviceSecret,
      candidates,
      capabilities: { headless: true, dashboard: true },
    });
    console.log(new Date().toISOString(), "heartbeat", result.status);
  };

  if (opts.loop) {
    for (;;) {
      await once();
      await new Promise((r) => setTimeout(r, 20_000));
    }
  } else {
    await once();
  }
}

export async function runCloudStatus(opts: { json?: boolean } = {}): Promise<void> {
  const state = loadCloudLinkState();
  if (!state) {
    if (opts.json) {
      console.log(JSON.stringify({ linked: false }));
    } else {
      console.log("Not linked to Fusion Cloud.");
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
  console.log("Cleared ~/.fusion/cloud-link.json");
}

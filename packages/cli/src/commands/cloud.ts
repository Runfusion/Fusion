/**
 * FNXC:CloudLink 2026-08-24-00:05:
 * CLI for cloud-link Mode A — pair / complete / heartbeat / status / unlink.
 * Pending pairing is stored separately so pair-start cannot wipe a live link.
 *
 * FNXC:CloudLink 2026-08-24-02:17:
 * pair-complete never reads the pairing secret from argv. The pending 0600
 * file is the default; operators who must override set FUSION_CLOUD_PENDING_SECRET.
 */
import {
  clearCloudLinkPending,
  clearCloudLinkState,
  cloudHeartbeat,
  cloudPairComplete,
  cloudPairStart,
  candidateFromUrl,
  lanCandidate,
  loadCloudLinkPending,
  loadCloudLinkState,
  normalizeCloudControlPlaneUrl,
  saveCloudLinkPending,
  saveCloudLinkState,
  type CloudReachabilityCandidate,
} from "@fusion/core";
import { startCloudLinkPresence, stopCloudLinkPresence } from "@fusion/engine";

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

/**
 * FNXC:CloudLink 2026-08-24-02:17:
 * Pending pairing is bound to the control plane that created it. If either
 * credential is loaded from the pending file, --http must match that origin
 * unless both --code and an explicit pending secret are supplied.
 */
export function resolveCloudPairCompleteRequest(
  opts: {
    http?: string;
    code?: string;
    pendingSecret?: string;
  },
  loadPending: typeof loadCloudLinkPending = loadCloudLinkPending,
): { http: string; code: string; pendingSecret: string } {
  const pending = loadPending();
  const explicitCode = Boolean(opts.code);
  const explicitSecret = Boolean(opts.pendingSecret);
  const usedPendingCredential = Boolean(
    pending && ((!explicitCode && pending.code) || (!explicitSecret && pending.pendingSecret)),
  );
  const http = opts.http
    ? resolveHttpBase(opts.http)
    : pending
      ? normalizeCloudControlPlaneUrl(pending.httpBaseUrl)
      : resolveHttpBase(undefined);
  if (usedPendingCredential && opts.http) {
    const pendingOrigin = normalizeCloudControlPlaneUrl(pending!.httpBaseUrl);
    if (pendingOrigin !== http) {
      throw new Error(
        "Pending pairing belongs to a different Cloud URL. Omit --http, or pass both --code and FUSION_CLOUD_PENDING_SECRET.",
      );
    }
  }
  const code = opts.code ?? pending?.code;
  const pendingSecret = opts.pendingSecret ?? pending?.pendingSecret;
  if (!code || !pendingSecret) {
    throw new Error(
      "No pending pairing. Run fn cloud pair-start first, or pass --code and FUSION_CLOUD_PENDING_SECRET.",
    );
  }
  return { http, code, pendingSecret };
}

export async function runCloudPairComplete(opts: {
  http?: string;
  code?: string;
  pendingSecret?: string;
}): Promise<void> {
  const { http, code, pendingSecret } = resolveCloudPairCompleteRequest(opts);
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
  console.log("Next: start Fusion (`fn serve` / `fn dashboard`). It will open a Cloudflare tunnel and keep Cloud Link updated if the URL changes.");
}

export async function runCloudHeartbeat(opts: {
  url?: string;
  port?: number;
  tunnel?: boolean;
}): Promise<void> {
  const state = loadCloudLinkState();
  if (!state?.engineId || !state.deviceSecret) {
    throw new Error("Not linked. Run fn cloud pair-start / pair-complete first.");
  }
  const port = opts.port ?? 4040;

  if (!opts.url && opts.tunnel !== false) {
    /*
     * FNXC:CloudLink 2026-08-22-00:40:
     * No --url means provision a Cloudflare Quick Tunnel and keep Cloud Link
     * updated when the trycloudflare host rotates. Ctrl+C stops the tunnel.
     * `fn serve` / `fn dashboard` do the same for the life of the process.
     */
    await startCloudLinkPresence(port, (message) => console.log(`[cloud-link] ${message}`));
    console.log("Cloud Link Cloudflare tunnel is running. Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    await stopCloudLinkPresence();
    return;
  }

  const candidates: CloudReachabilityCandidate[] = [];
  if (opts.url) {
    candidates.push(candidateFromUrl(opts.url));
  }
  const lan = lanCandidate(port);
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

/**
 * FNXC:CloudLink 2026-08-22-00:40:
 * When this Fusion instance is linked to Cloud Link, provision a Cloudflare
 * Quick Tunnel to the dashboard's bound port and keep the control plane updated
 * with the live URL. trycloudflare hosts rotate; every URL change (and a 20s
 * presence beat) republishes candidates so Connect always has the current tunnel.
 * Does not kill port 4040. Stops the tunnel we started on serve shutdown.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CLOUD_LINK_HEARTBEAT_MS,
  buildHeartbeatCandidates,
  cloudHeartbeat,
  loadCloudLinkState,
  tunnelUrlChanged,
  type CloudLinkDeviceState,
} from "@fusion/core";
import { TunnelProcessManager } from "./remote-access/tunnel-process-manager.js";
import type {
  TunnelProvider,
  TunnelProviderConfig,
  TunnelStatusListener,
  TunnelStatusSnapshot,
} from "./remote-access/types.js";
import { getLocalDashboardPort } from "./local-dashboard-port.js";

/** Minimal tunnel surface Cloud Link needs so tests can fake cloudflared. */
export interface CloudLinkTunnel {
  getStatus(): Pick<TunnelStatusSnapshot, "url" | "state">;
  start(provider: TunnelProvider, config: TunnelProviderConfig): Promise<void>;
  stop(): Promise<void>;
  subscribeStatus(listener: TunnelStatusListener): () => void;
}

const execFileAsync = promisify(execFile);

export type CloudLinkLog = (message: string) => void;

export interface CloudLinkPresenceDeps {
  loadState?: () => CloudLinkDeviceState | null;
  heartbeat?: typeof cloudHeartbeat;
  createTunnel?: () => CloudLinkTunnel;
  probeCloudflared?: () => Promise<boolean>;
  now?: () => number;
  intervalMs?: number;
  log?: CloudLinkLog;
}

export class CloudLinkPresence {
  private readonly loadState: () => CloudLinkDeviceState | null;
  private readonly heartbeat: typeof cloudHeartbeat;
  private readonly createTunnel: () => CloudLinkTunnel;
  private readonly probeCloudflared: () => Promise<boolean>;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly log: CloudLinkLog;

  private tunnel: CloudLinkTunnel | null = null;
  private startedTunnel = false;
  private timer: NodeJS.Timeout | null = null;
  private unsub: (() => void) | null = null;
  private lastPublishedUrl: string | null = null;
  private port = 0;
  private running = false;
  private sending = false;

  constructor(deps: CloudLinkPresenceDeps = {}) {
    this.loadState = deps.loadState ?? loadCloudLinkState;
    this.heartbeat = deps.heartbeat ?? cloudHeartbeat;
    this.createTunnel = deps.createTunnel ?? (() => new TunnelProcessManager());
    this.probeCloudflared = deps.probeCloudflared ?? probeCloudflaredOnPath;
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? CLOUD_LINK_HEARTBEAT_MS;
    this.log = deps.log ?? ((message) => {
      console.log(`[cloud-link] ${message}`);
    });
  }

  async start(port: number): Promise<void> {
    const state = this.loadState();
    if (!state?.engineId || !state.deviceSecret) {
      return;
    }
    this.port = port;
    this.running = true;

    const hasCloudflared = await this.probeCloudflared();
    if (hasCloudflared) {
      const tunnel = this.createTunnel();
      this.tunnel = tunnel;
      this.unsub = tunnel.subscribeStatus((snapshot) => {
        void this.onTunnelStatus(snapshot);
      });
      try {
        await tunnel.start("cloudflare", {
          provider: "cloudflare",
          quickTunnel: true,
          executablePath: "cloudflared",
          args: ["tunnel", "--url", `http://127.0.0.1:${port}`],
          readinessTimeoutMs: 25_000,
        });
        this.startedTunnel = true;
        this.log(`Started Cloudflare Quick Tunnel to 127.0.0.1:${port}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Could not start Cloudflare tunnel (${message}). Heartbeating LAN only.`);
      }
    } else {
      this.log("cloudflared is not on PATH; Cloud Link will publish LAN only until it is installed.");
    }

    await this.publish();
    this.timer = setInterval(() => {
      void this.publish();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsub?.();
    this.unsub = null;
    if (this.startedTunnel && this.tunnel) {
      try {
        await this.tunnel.stop();
      } catch {
        // best-effort
      }
    }
    this.tunnel = null;
    this.startedTunnel = false;
    this.lastPublishedUrl = null;
  }

  private async onTunnelStatus(snapshot: TunnelStatusSnapshot): Promise<void> {
    if (!this.running) return;
    const next = snapshot.url;
    if (!tunnelUrlChanged(this.lastPublishedUrl, next)) return;
    this.log(`Tunnel URL ${this.lastPublishedUrl ? "changed" : "ready"}: ${next}`);
    await this.publish();
  }

  private async publish(): Promise<void> {
    if (!this.running || this.sending) return;
    const state = this.loadState();
    if (!state?.engineId || !state.deviceSecret) return;
    this.sending = true;
    try {
      const tunnelUrl = this.tunnel?.getStatus().url ?? null;
      const candidates = buildHeartbeatCandidates({
        tunnelUrl,
        lanPort: this.port || getLocalDashboardPort(),
        now: this.now(),
      });
      if (candidates.length === 0) return;
      await this.heartbeat(state.httpBaseUrl, {
        engineId: state.engineId,
        deviceSecret: state.deviceSecret,
        candidates,
        capabilities: { headless: true, dashboard: true },
      });
      this.lastPublishedUrl = tunnelUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Heartbeat failed: ${message}`);
    } finally {
      this.sending = false;
      const live = this.tunnel?.getStatus().url ?? null;
      if (this.running && tunnelUrlChanged(this.lastPublishedUrl, live)) {
        void this.publish();
      }
    }
  }
}

export async function probeCloudflaredOnPath(): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(checker, ["cloudflared"]);
    return true;
  } catch {
    return false;
  }
}

let singleton: CloudLinkPresence | null = null;

/**
 * Start (or no-op) Cloud Link tunnel+heartbeat for this process after the
 * dashboard is listening. Safe to call from serve and dashboard.
 */
export async function startCloudLinkPresence(
  port: number,
  log?: CloudLinkLog,
): Promise<CloudLinkPresence | null> {
  const state = loadCloudLinkState();
  if (!state?.engineId || !state.deviceSecret) {
    return null;
  }
  if (singleton) {
    await singleton.stop();
    singleton = null;
  }
  const presence = new CloudLinkPresence({ log });
  singleton = presence;
  await presence.start(port);
  return presence;
}

export async function stopCloudLinkPresence(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
  singleton = null;
}

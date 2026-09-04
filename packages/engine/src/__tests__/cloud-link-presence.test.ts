import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudLinkPresence, type CloudLinkTunnel } from "../cloud-link-presence.js";
import type { TunnelStatusListener, TunnelStatusSnapshot } from "../remote-access/types.js";

function snapshot(url: string | null): TunnelStatusSnapshot {
  return {
    provider: url ? "cloudflare" : null,
    state: url ? "running" : "stopped",
    pid: url ? 1 : null,
    startedAt: null,
    stoppedAt: null,
    url,
    lastError: null,
  };
}

class FakeTunnel implements CloudLinkTunnel {
  url: string | null = null;
  started = false;
  stopped = false;
  lastArgs: string[] = [];
  private listeners = new Set<TunnelStatusListener>();

  getStatus() {
    return snapshot(this.url);
  }

  async start(_provider: "cloudflare" | "tailscale", config: { args: string[] }): Promise<void> {
    this.started = true;
    this.lastArgs = config.args;
    this.url = "https://first.trycloudflare.com";
    this.emit();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.url = null;
    this.emit();
  }

  subscribeStatus(listener: TunnelStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  rotate(url: string): void {
    this.url = url;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.getStatus());
  }
}

describe("CloudLinkPresence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a Cloudflare quick tunnel to the bound port and heartbeats the URL", async () => {
    const tunnel = new FakeTunnel();
    const heartbeat = vi.fn(async () => ({ status: "online" }));
    const presence = new CloudLinkPresence({
      loadState: () => ({
        httpBaseUrl: "https://cloud.example.convex.site",
        engineId: "eng_1",
        deviceSecret: "secret",
        linkedAt: "2026-08-22T00:00:00Z",
      }),
      heartbeat,
      createTunnel: () => tunnel,
      probeCloudflared: async () => true,
      intervalMs: 60_000,
    });

    await presence.start(51234);

    expect(tunnel.started).toBe(true);
    expect(tunnel.lastArgs).toEqual(["tunnel", "--url", "http://127.0.0.1:51234"]);
    expect(heartbeat).toHaveBeenCalled();
    const first = heartbeat.mock.calls[0]![1] as {
      candidates: Array<{ kind: string; url: string }>;
    };
    expect(first.candidates.some((c) => c.kind === "cloudflare" && c.url.includes("first.trycloudflare.com"))).toBe(
      true,
    );

    heartbeat.mockClear();
    tunnel.rotate("https://second.trycloudflare.com");
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalled());
    const second = heartbeat.mock.calls[0]![1] as {
      candidates: Array<{ url: string }>;
    };
    expect(second.candidates.some((c) => c.url.includes("second.trycloudflare.com"))).toBe(true);

    await presence.stop();
    expect(tunnel.stopped).toBe(true);
  });

  it("heartbeats LAN when cloudflared is missing", async () => {
    const heartbeat = vi.fn(async () => ({ status: "online" }));
    const presence = new CloudLinkPresence({
      loadState: () => ({
        httpBaseUrl: "https://cloud.example.convex.site",
        engineId: "eng_1",
        deviceSecret: "secret",
        linkedAt: "2026-08-22T00:00:00Z",
      }),
      heartbeat,
      probeCloudflared: async () => false,
      intervalMs: 60_000,
    });
    await presence.start(51234);
    expect(heartbeat).toHaveBeenCalled();
    await presence.stop();
  });

  it("no-ops when the instance is not linked", async () => {
    const heartbeat = vi.fn(async () => ({ status: "online" }));
    const presence = new CloudLinkPresence({
      loadState: () => null,
      heartbeat,
      probeCloudflared: async () => true,
    });
    await presence.start(51234);
    expect(heartbeat).not.toHaveBeenCalled();
    await presence.stop();
  });

  it("does not tight-loop when the first heartbeat fails with a live tunnel URL", async () => {
    vi.useFakeTimers();
    const tunnel = new FakeTunnel();
    const heartbeat = vi.fn(async () => {
      throw new Error("control-plane unavailable");
    });
    const presence = new CloudLinkPresence({
      loadState: () => ({
        httpBaseUrl: "https://cloud.example.convex.site",
        engineId: "eng_1",
        deviceSecret: "secret",
        linkedAt: "2026-08-22T00:00:00Z",
      }),
      heartbeat,
      createTunnel: () => tunnel,
      probeCloudflared: async () => true,
      intervalMs: 60_000,
    });

    await presence.start(51234);
    const afterStart = heartbeat.mock.calls.length;
    expect(afterStart).toBeGreaterThan(0);
    expect(afterStart).toBeLessThan(8);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(heartbeat.mock.calls.length).toBe(afterStart);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat.mock.calls.length).toBeGreaterThan(afterStart);
    await presence.stop();
  });

  it("abandons a deferred start after stop so no tunnel is left running", async () => {
    let release!: (value: boolean) => void;
    const probe = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const tunnel = new FakeTunnel();
    const presence = new CloudLinkPresence({
      loadState: () => ({
        httpBaseUrl: "https://cloud.example.convex.site",
        engineId: "eng_1",
        deviceSecret: "secret",
        linkedAt: "2026-08-22T00:00:00Z",
      }),
      heartbeat: vi.fn(async () => ({ status: "online" })),
      createTunnel: () => tunnel,
      probeCloudflared: () => probe,
    });
    const startP = presence.start(51234);
    await presence.stop();
    release(true);
    await startP;
    expect(tunnel.started).toBe(false);
  });
});

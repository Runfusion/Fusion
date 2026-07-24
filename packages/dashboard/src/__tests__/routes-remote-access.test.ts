// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import { DEFAULT_GLOBAL_SETTINGS, type TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

function buildRemoteAccessSettings() {
  return {
    activeProvider: "cloudflare" as const,
    providers: {
      tailscale: {
        enabled: true,
        hostname: "tail.example.ts.net",
        targetPort: 4040,
        acceptRoutes: false,
      },
      cloudflare: {
        enabled: true,
        quickTunnel: false,
        tunnelName: "demo-tunnel",
        tunnelToken: "cf-secret-token",
        ingressUrl: "https://remote.example.com",
      },
    },
    tokenStrategy: {
      persistent: {
        enabled: true,
        token: "frt_persistent_token",
      },
      shortLived: {
        enabled: true,
        ttlMs: 120000,
        maxTtlMs: 86400000,
      },
    },
    lifecycle: {
      rememberLastRunning: true,
      wasRunningOnShutdown: false,
      lastRunningProvider: null,
    },
  };
}

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({ remoteAccess: buildRemoteAccessSettings() }),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
    updateGlobalSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
      exec: vi.fn(),
    }),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    moveTask: vi.fn(),
    logEntry: vi.fn(),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    /*
    FNXC:PluginMcpServers 2026-07-24-01:25:
    FN-8491 (3cd023fa4) binds a project-scoped plugin-MCP provider on every getProjectContext.
    Exposing getProjectScopedPluginMcpServers marks this mock as runtime-owned so the binder
    short-circuits instead of calling getPluginStore().
    */
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

function createApp(opts: { store?: TaskStore; engine?: Record<string, unknown> } = {}) {
  const store = opts.store ?? createMockStore();
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store, { engine: opts.engine as any }));
  return { app, store };
}

async function REQUEST(app: express.Express, method: string, path: string, body?: unknown) {
  return performRequest(
    app,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? {} : { "Content-Type": "application/json" },
  );
}

describe("remote access API route contracts", () => {
  it("supports GET and PUT /api/remote/settings", async () => {
    const store = createMockStore({
      updateGlobalSettings: vi.fn().mockResolvedValue({ remoteAccess: buildRemoteAccessSettings() }),
      getSettings: vi.fn()
        .mockResolvedValueOnce({ remoteAccess: buildRemoteAccessSettings() })
        .mockResolvedValueOnce({ remoteAccess: { ...buildRemoteAccessSettings(), activeProvider: "tailscale" } }),
    });
    const { app } = createApp({ store });

    const getRes = await REQUEST(app, "GET", "/api/remote/settings");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      settings: expect.objectContaining({
        remoteEnabled: true,
        remoteActiveProvider: "cloudflare",
        remoteCloudflareQuickTunnel: false,
      }),
    });

    const putRes = await REQUEST(app, "PUT", "/api/remote/settings", {
      remoteEnabled: true,
      remoteActiveProvider: "tailscale",
      remoteCloudflareQuickTunnel: true,
      remoteShortLivedEnabled: true,
      remoteShortLivedTtlMs: 180000,
    });

    expect(putRes.status).toBe(200);
    expect(putRes.body).toMatchObject({
      settings: expect.objectContaining({
        remoteEnabled: true,
        remoteActiveProvider: "tailscale",
        remoteCloudflareQuickTunnel: true,
        remoteShortLivedEnabled: true,
        remoteShortLivedTtlMs: 180000,
      }),
    });

    expect(store.updateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        providers: expect.objectContaining({
          cloudflare: expect.objectContaining({ quickTunnel: true }),
        }),
      }),
    }));
  });

  it("persists Tailscale accept-routes and lifecycle fields without erasing populated branches", async () => {
    let remoteAccess = buildRemoteAccessSettings();
    const store = createMockStore({
      getSettings: vi.fn(async () => ({ remoteAccess })),
      updateGlobalSettings: vi.fn(async (patch: { remoteAccess?: typeof remoteAccess }) => {
        if (patch.remoteAccess) {
          remoteAccess = patch.remoteAccess;
        }
        return { remoteAccess };
      }),
    });
    const { app } = createApp({ store });

    const putRes = await REQUEST(app, "PUT", "/api/remote/settings", {
      remoteActiveProvider: "tailscale",
      remoteTailscaleEnabled: true,
      remoteTailscaleAcceptRoutes: true,
      remoteRememberLastRunning: true,
    });

    expect(putRes.status).toBe(200);
    expect(store.updateGlobalSettings).toHaveBeenCalledWith({
      remoteAccess: expect.objectContaining({
        activeProvider: "tailscale",
        providers: expect.objectContaining({
          tailscale: expect.objectContaining({ acceptRoutes: true }),
          cloudflare: expect.objectContaining({
            quickTunnel: false,
            tunnelName: "demo-tunnel",
            tunnelToken: "cf-secret-token",
            ingressUrl: "https://remote.example.com",
          }),
        }),
        tokenStrategy: expect.objectContaining({
          persistent: expect.objectContaining({ token: "frt_persistent_token" }),
          shortLived: expect.objectContaining({ enabled: true, ttlMs: 120000 }),
        }),
        lifecycle: expect.objectContaining({ rememberLastRunning: true }),
      }),
    });

    const getRes = await REQUEST(app, "GET", "/api/remote/settings");
    expect(getRes.status).toBe(200);
    expect(getRes.body.settings).toMatchObject({
      remoteActiveProvider: "tailscale",
      remoteTailscaleAcceptRoutes: true,
      remoteRememberLastRunning: true,
      remoteCloudflareQuickTunnel: false,
      remoteCloudflareTunnelName: "demo-tunnel",
      remoteShortLivedEnabled: true,
      remoteShortLivedTtlMs: 120000,
    });
  });

  it("returns default remote settings payload when remoteAccess is missing", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({}),
    });
    const { app } = createApp({ store });

    const getRes = await REQUEST(app, "GET", "/api/remote/settings");

    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      settings: expect.objectContaining({
        remoteEnabled: false,
        remoteActiveProvider: null,
        remoteTailscaleEnabled: false,
        remoteCloudflareEnabled: false,
        remoteShortLivedEnabled: false,
      }),
    });
  });

  it("seeds defaults when saving remote settings on a fresh project", async () => {
    const updateGlobalSettings = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({}),
      updateGlobalSettings,
    });
    const { app } = createApp({ store });

    const putRes = await REQUEST(app, "PUT", "/api/remote/settings", {
      remoteActiveProvider: "tailscale",
      remoteTailscaleEnabled: true,
      remoteTailscaleHostname: "first-use.ts.net",
    });

    expect(putRes.status).toBe(200);
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      remoteAccess: expect.objectContaining({
        ...DEFAULT_GLOBAL_SETTINGS.remoteAccess,
        activeProvider: "tailscale",
        providers: expect.objectContaining({
          tailscale: expect.objectContaining({ enabled: true, hostname: "first-use.ts.net" }),
          cloudflare: expect.objectContaining({ enabled: false }),
        }),
      }),
    });
    expect(putRes.body.settings).toMatchObject({
      remoteEnabled: true,
      remoteActiveProvider: "tailscale",
      remoteTailscaleEnabled: true,
    });
  });

  it("supports provider activation and tunnel lifecycle endpoints", async () => {
    const engine = {
      startRemoteTunnel: vi.fn().mockResolvedValue({
        state: "running",
        provider: "cloudflare",
        url: "https://remote.example.com",
        lastError: null,
      }),
      /*
      FNXC:RemoteAccessTests 2026-07-17-22:18:
      The stop endpoint preserves the provider that owned the completed tunnel so callers
      can render the stopped lifecycle state consistently. Keep the mock aligned with that contract.
      */
      stopRemoteTunnel: vi.fn().mockResolvedValue({
        state: "stopped",
        provider: "cloudflare",
        url: null,
        lastError: null,
      }),
    };
    const updateGlobalSettings = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({ updateGlobalSettings });
    const { app } = createApp({ store, engine });

    const activateRes = await REQUEST(app, "POST", "/api/remote/provider/activate", { provider: "tailscale" });
    expect(activateRes.status).toBe(200);
    expect(activateRes.body).toEqual({ activeProvider: "tailscale" });

    const startRes = await REQUEST(app, "POST", "/api/remote/tunnel/start", {});
    expect(startRes.status).toBe(200);
    expect(["starting", "running"]).toContain(startRes.body.state);
    expect(startRes.body.provider).toBe("cloudflare");

    const stopRes = await REQUEST(app, "POST", "/api/remote/tunnel/stop", {});
    expect(stopRes.status).toBe(200);
    expect(stopRes.body.state).toBe("stopped");
    expect(stopRes.body.provider).toBe("cloudflare");

    expect(engine.startRemoteTunnel.mock.calls.length).toBeLessThanOrEqual(1);
    expect(engine.stopRemoteTunnel.mock.calls.length).toBeLessThanOrEqual(1);
    expect(updateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({ activeProvider: "tailscale" }),
    }));
  });

  it("uses live tunnel URL for cloudflare quick tunnel link generation", async () => {
    const quickTunnelSettings = {
      ...buildRemoteAccessSettings(),
      providers: {
        ...buildRemoteAccessSettings().providers,
        cloudflare: {
          ...buildRemoteAccessSettings().providers.cloudflare,
          quickTunnel: true,
          ingressUrl: "",
          tunnelToken: null,
          tunnelName: "",
        },
      },
    };

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ remoteAccess: quickTunnelSettings }),
    });
    const engine = {
      getRemoteTunnelManager: () => ({
        getStatus: () => ({ url: "https://demo.trycloudflare.com" }),
      }),
    };
    const { app } = createApp({ store, engine });

    const urlRes = await REQUEST(app, "GET", "/api/remote/url?tokenType=persistent");
    expect(urlRes.status).toBe(200);
    expect(urlRes.body.url).toContain("https://demo.trycloudflare.com/remote-login?rt=");
  });

  it("returns 409 when quick tunnel URL is requested before cloudflared reports URL", async () => {
    const quickTunnelSettings = {
      ...buildRemoteAccessSettings(),
      providers: {
        ...buildRemoteAccessSettings().providers,
        cloudflare: {
          ...buildRemoteAccessSettings().providers.cloudflare,
          quickTunnel: true,
          ingressUrl: "",
          tunnelToken: null,
          tunnelName: "",
        },
      },
    };

    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ remoteAccess: quickTunnelSettings }),
    });
    const engine = {
      getRemoteTunnelManager: () => ({
        getStatus: () => ({ url: null }),
      }),
    };
    const { app } = createApp({ store, engine });

    const urlRes = await REQUEST(app, "GET", "/api/remote/url?tokenType=persistent");
    expect(urlRes.status).toBe(409);
    expect(urlRes.body.error).toContain("quick tunnel has not started yet");
  });

  it("supports persistent and short-lived token endpoints plus URL/QR contracts", async () => {
    const { app } = createApp();

    const persistent = await REQUEST(app, "POST", "/api/remote/token/persistent/regenerate", {});
    expect(persistent.status).toBe(200);
    expect(persistent.body).toMatchObject({
      token: expect.stringMatching(/^frt_[A-Za-z0-9_-]+$/),
      maskedToken: expect.any(String),
    });

    const shortLived = await REQUEST(app, "POST", "/api/remote/token/short-lived/generate", { ttlMs: 120000 });
    expect(shortLived.status).toBe(200);
    expect(shortLived.body).toMatchObject({
      token: expect.stringMatching(/^frt_[A-Za-z0-9_-]+$/),
      expiresAt: expect.any(String),
    });
    expect(shortLived.body.ttlMs).toBeGreaterThanOrEqual(119000);
    expect(shortLived.body.ttlMs).toBeLessThanOrEqual(120000);

    const shortLivedBounded = await REQUEST(app, "POST", "/api/remote/token/short-lived/generate", { ttlMs: 1000 });
    expect(shortLivedBounded.status).toBe(200);
    expect(shortLivedBounded.body.ttlMs).toBeGreaterThanOrEqual(60000);

    const shortLivedMaxBounded = await REQUEST(app, "POST", "/api/remote/token/short-lived/generate", { ttlMs: 200000000 });
    expect(shortLivedMaxBounded.status).toBe(200);
    expect(shortLivedMaxBounded.body.ttlMs).toBeLessThanOrEqual(86400000);

    const urlRes = await REQUEST(app, "GET", "/api/remote/url?tokenType=short-lived");
    expect(urlRes.status).toBe(200);
    expect(urlRes.body).toMatchObject({
      url: expect.stringContaining("/remote-login?rt="),
      tokenType: "short-lived",
      expiresAt: expect.any(String),
    });

    const qrText = await REQUEST(app, "GET", "/api/remote/qr?format=text&tokenType=persistent");
    expect(qrText.status).toBe(200);
    expect(qrText.body).toMatchObject({
      format: "text",
      data: expect.stringContaining("/remote-login?rt="),
      tokenType: "persistent",
    });

    const qrSvg = await REQUEST(app, "GET", "/api/remote/qr?format=image/svg&tokenType=short-lived");
    expect(qrSvg.status).toBe(200);
    expect(qrSvg.body).toMatchObject({
      format: "image/svg",
      data: expect.stringContaining("<svg"),
      tokenType: "short-lived",
    });
    // The .url field is what the QR matrix encodes — assert it carries the
    // tailnet origin AND the rt= access token so a single scan authenticates.
    expect(qrSvg.body.url).toMatch(/\/remote-login\?rt=[A-Za-z0-9_-]+/);

    const qrTerminal = await REQUEST(app, "GET", "/api/remote/qr?format=terminal&tokenType=persistent");
    expect(qrTerminal.status).toBe(200);
    expect(qrTerminal.body.format).toBe("terminal");
    expect(typeof qrTerminal.body.data).toBe("string");
    expect(qrTerminal.body.data.length).toBeGreaterThan(0);
    expect(qrTerminal.body.url).toMatch(/\/remote-login\?rt=[A-Za-z0-9_-]+/);
  });
});

// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

function buildRemoteAccessSettings() {
  return {
    enabled: true,
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
      updateSettings: vi.fn().mockResolvedValue({ remoteAccess: buildRemoteAccessSettings() }),
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
      }),
    });

    const putRes = await REQUEST(app, "PUT", "/api/remote/settings", {
      remoteEnabled: true,
      remoteActiveProvider: "tailscale",
      remoteShortLivedEnabled: true,
      remoteShortLivedTtlMs: 180000,
    });

    expect(putRes.status).toBe(200);
    expect(putRes.body).toMatchObject({
      settings: expect.objectContaining({
        remoteEnabled: true,
        remoteActiveProvider: "tailscale",
        remoteShortLivedEnabled: true,
        remoteShortLivedTtlMs: 180000,
      }),
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
      stopRemoteTunnel: vi.fn().mockResolvedValue({
        state: "stopped",
        provider: null,
        url: null,
        lastError: null,
      }),
    };
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({ updateSettings });
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
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({ activeProvider: "tailscale" }),
    }));
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
  });
});

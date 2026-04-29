// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

function buildRemoteAccessSettings(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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

beforeEach(() => {
  mockExecFile.mockReset();
  mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    const callback = typeof optionsOrCallback === "function"
      ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
      : maybeCallback;
    callback?.(null, command === "where" || command === "which" ? "/usr/local/bin/cloudflared" : "", "");
  });
});

describe("remote access provider/lifecycle contracts", () => {
  it("switches active provider and rejects invalid provider values", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const { app } = createApp({ store: createMockStore({ updateSettings }) });

    const activate = await REQUEST(app, "POST", "/api/remote/provider/activate", { provider: "tailscale" });
    expect(activate.status).toBe(200);
    expect(activate.body).toEqual({ activeProvider: "tailscale" });
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({ activeProvider: "tailscale" }),
    }));

    const invalid = await REQUEST(app, "POST", "/api/remote/provider/activate", { provider: "wireguard" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      error: "Invalid remote provider",
      details: { code: "INVALID_PROVIDER" },
    });
  });

  it("seeds defaults when activating a provider on a fresh project", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({}),
      updateSettings,
    });
    const { app } = createApp({ store });

    const activate = await REQUEST(app, "POST", "/api/remote/provider/activate", { provider: "cloudflare" });

    expect(activate.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        activeProvider: "cloudflare",
        providers: expect.objectContaining({
          tailscale: expect.objectContaining({ enabled: false }),
          cloudflare: expect.objectContaining({ enabled: false }),
        }),
      }),
    }));
  });

  it("returns NO_ACTIVE_PROVIDER when tunnel start is requested without an active provider", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        remoteAccess: buildRemoteAccessSettings({ activeProvider: null }),
      }),
    });
    const { app } = createApp({ store });

    const startRes = await REQUEST(app, "POST", "/api/remote/tunnel/start", {});

    expect(startRes.status).toBe(409);
    expect(startRes.body).toEqual({
      error: "No active provider configured",
      details: { code: "NO_ACTIVE_PROVIDER" },
    });
  });

  it("keeps repeated start/stop requests idempotent when no engine is available", async () => {
    const { app } = createApp();

    const firstStart = await REQUEST(app, "POST", "/api/remote/tunnel/start", {});
    const secondStart = await REQUEST(app, "POST", "/api/remote/tunnel/start", {});
    const firstStop = await REQUEST(app, "POST", "/api/remote/tunnel/stop", {});
    const secondStop = await REQUEST(app, "POST", "/api/remote/tunnel/stop", {});

    for (const response of [firstStart, secondStart]) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ state: "starting", provider: "cloudflare" });
      expect(response.body).toEqual(expect.objectContaining({ state: expect.any(String), provider: expect.any(String) }));
    }

    for (const response of [firstStop, secondStop]) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ state: "stopped", provider: "cloudflare" });
      expect(response.body).toEqual(expect.objectContaining({ state: expect.any(String), provider: expect.any(String) }));
    }
  });

  it("returns REMOTE_TUNNEL_PREREQUISITE_MISSING when provider is selected but runtime prerequisites are missing", async () => {
    const store = createMockStore();
    const engine = {
      getTaskStore: vi.fn().mockReturnValue(store),
      startRemoteTunnel: vi.fn().mockRejectedValue(new Error("runtime_prerequisite_missing:tailscale CLI unavailable")),
    };
    const { app } = createApp({ store, engine });

    const response = await REQUEST(app, "POST", "/api/remote/tunnel/start", {});

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "tailscale CLI unavailable",
      details: { code: "REMOTE_TUNNEL_PREREQUISITE_MISSING" },
    });
  });

  it("includes cloudflaredAvailable in remote status for cloudflare provider", async () => {
    const { app } = createApp();

    const status = await REQUEST(app, "GET", "/api/remote/status");

    expect(status.status).toBe(200);
    expect(status.body).toEqual(expect.objectContaining({
      provider: "cloudflare",
      cloudflaredAvailable: true,
    }));
  });

  it("returns cloudflaredAvailable false when cloudflared check fails", async () => {
    mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null) => void
        : maybeCallback;
      if (command === "which" || command === "where") {
        callback?.(new Error("missing"));
        return;
      }
      callback?.(null);
    });

    const { app } = createApp();
    const status = await REQUEST(app, "GET", "/api/remote/status");

    expect(status.status).toBe(200);
    expect(status.body).toEqual(expect.objectContaining({ cloudflaredAvailable: false }));
  });

  it("returns cloudflaredAvailable null for non-cloudflare provider", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        remoteAccess: buildRemoteAccessSettings({ activeProvider: "tailscale" }),
      }),
    });
    const { app } = createApp({ store });

    const status = await REQUEST(app, "GET", "/api/remote/status");

    expect(status.status).toBe(200);
    expect(status.body).toEqual(expect.objectContaining({
      provider: "tailscale",
      cloudflaredAvailable: null,
    }));
  });

  it("installs cloudflared via endpoint and returns install command metadata", async () => {
    const { app } = createApp();

    const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      success: true,
      command: expect.any(String),
    }));
  });

  it("returns install failure details when cloudflared installation command fails", async () => {
    mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback;
      if (command === "sh" || command === "cmd") {
        callback?.(new Error("Command failed"), "", "Command failed");
        return;
      }
      callback?.(null, "/usr/local/bin/cloudflared", "");
    });

    const { app } = createApp();
    const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      success: false,
      command: expect.any(String),
      error: expect.stringContaining("Command failed"),
    }));
  });
});

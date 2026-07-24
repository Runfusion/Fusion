// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";

const { mockExecFile, mockMkdir } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockMkdir: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: mockExecFile,
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: mockMkdir.mockImplementation(async () => undefined),
  };
});

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createApiRoutes } from "../routes.js";
import {
  __setCloudflaredManifestForTesting,
  validateCloudflaredManifest,
} from "../routes/register-settings-memory-routes.js";
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
    updateGlobalSettings: vi.fn().mockResolvedValue(undefined),
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
    FNXC:PluginMcpServers 2026-07-23-00:00:
    FN-8491 (3cd023fa4) made resolveProjectContext bind a project-scoped plugin
    MCP provider on every getProjectContext call. A store that already exposes
    getProjectScopedPluginMcpServers is treated as runtime-owned and skips the
    binder (which would otherwise call getPluginStore()); declare it here so the
    remote-access route contracts stay isolated from plugin-loader bootstrapping.
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

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const originalArchDescriptor = Object.getOwnPropertyDescriptor(process, "arch");

function setProcessRuntime(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

afterEach(() => {
  __setCloudflaredManifestForTesting(null);
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  if (originalArchDescriptor) {
    Object.defineProperty(process, "arch", originalArchDescriptor);
  }
});

beforeEach(() => {
  mockExecFile.mockReset();
  mockMkdir.mockReset();
  mockMkdir.mockImplementation(async () => undefined);
  mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    const callback = typeof optionsOrCallback === "function"
      ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
      : maybeCallback;
    callback?.(null, command === "where" || command === "which" ? "/usr/local/bin/cloudflared" : "", "");
  });
});

describe("remote access provider/lifecycle contracts", () => {
  it("switches active provider and rejects invalid provider values", async () => {
    const updateGlobalSettings = vi.fn().mockResolvedValue(undefined);
    const { app } = createApp({ store: createMockStore({ updateGlobalSettings }) });

    const activate = await REQUEST(app, "POST", "/api/remote/provider/activate", { provider: "tailscale" });
    expect(activate.status).toBe(200);
    expect(activate.body).toEqual({ activeProvider: "tailscale" });
    expect(updateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({
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
    const updateGlobalSettings = vi.fn().mockResolvedValue(undefined);
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({}),
      updateGlobalSettings,
    });
    const { app } = createApp({ store });

    const activate = await REQUEST(app, "POST", "/api/remote/provider/activate", { provider: "cloudflare" });

    expect(activate.status).toBe(200);
    expect(updateGlobalSettings).toHaveBeenCalledWith(expect.objectContaining({
      remoteAccess: expect.objectContaining({
        activeProvider: "cloudflare",
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

  it("returns 200 for remote status when managed tunnel is stopped", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        remoteAccess: buildRemoteAccessSettings({ activeProvider: "tailscale" }),
      }),
    });
    const { app } = createApp({ store });

    const status = await REQUEST(app, "GET", "/api/remote/status");

    expect(status.status).toBe(200);
    expect(status.body).toEqual(expect.objectContaining({ state: "stopped" }));
  });

  it("omits externalTunnel detection when managed tunnel is running", async () => {
    const engine = {
      getRemoteTunnelManager: vi.fn().mockReturnValue({
        getStatus: vi.fn().mockReturnValue({ state: "running", provider: "tailscale", url: "https://live.ts.net/", lastError: null }),
      }),
      getRemoteTunnelRestoreDiagnostics: vi.fn().mockReturnValue(null),
      detectExternalTunnel: vi.fn(),
    };
    const { app } = createApp({ engine });

    const status = await REQUEST(app, "GET", "/api/remote/status");

    expect(status.status).toBe(200);
    expect(status.body.externalTunnel).toBeNull();
    expect(engine.detectExternalTunnel).not.toHaveBeenCalled();
  });

  it("calls engine killExternalTunnel via kill-external endpoint", async () => {
    const engine = {
      killExternalTunnel: vi.fn().mockResolvedValue(undefined),
    };
    const { app } = createApp({ engine });

    const result = await REQUEST(app, "POST", "/api/remote/tunnel/kill-external", {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
  });

  const makeVerifiedManifest = (assetName: string, sha256: string) => ({
    source: "upstream-verified" as const,
    version: "2026.5.0",
    verifiedAt: "2026-05-20T00:00:00.000Z",
    assets: {
      [assetName]: {
        url: `https://github.com/cloudflare/cloudflared/releases/download/2026.5.0/${assetName}`,
        sha256,
      },
    },
  });

  it("installs cloudflared via endpoint and returns install command metadata", async () => {
    setProcessRuntime("linux", "x64");
    const { app } = createApp();

    const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      success: false,
      command: expect.stringContaining("cloudflared-linux-amd64"),
      error: expect.stringContaining("upstream-pending-verification"),
    }));
    expect(mockExecFile.mock.calls.every(([command]) => command !== "curl")).toBe(true);
  });

  it("uses arm64 cloudflared binary on Linux arm64", async () => {
    setProcessRuntime("linux", "arm64");
    const { app } = createApp();

    const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      success: false,
      command: expect.stringContaining("cloudflared-linux-arm64"),
      error: expect.stringContaining("upstream-pending-verification"),
    }));
    expect(mockExecFile.mock.calls.every(([command]) => command !== "curl")).toBe(true);
  });

  it("falls back to ~/.local/bin when /usr/local/bin move fails with permission error", async () => {
    setProcessRuntime("linux", "x64");
    const payload = Buffer.from("cloudflared-ok");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    __setCloudflaredManifestForTesting(makeVerifiedManifest("cloudflared-linux-amd64", sha256));
    mockExecFile.mockImplementation((command: string, args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback;
      if (command === "curl") {
        writeFileSync("/tmp/cloudflared", payload);
      }
      if (command === "mv" && args[1] === "/usr/local/bin/cloudflared") {
        callback?.(new Error("EPERM"), "", "EPERM");
        return;
      }
      callback?.(null, "", "");
    });

    const { app } = createApp();
    const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({ success: true }));
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('/.local/bin'), { recursive: true });
    expect(mockExecFile.mock.calls.some(([command, args]) => command === "mv" && Array.isArray(args) && String(args[1]).includes("/.local/bin/cloudflared"))).toBe(true);
  });

  it("falls back to direct download on macOS when brew is unavailable", async () => {
    setProcessRuntime("darwin", "arm64");
    const payload = Buffer.from("cloudflared-darwin");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    __setCloudflaredManifestForTesting(makeVerifiedManifest("cloudflared-darwin-arm64", sha256));
    mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback;
      if (command === "which") {
        callback?.(new Error("brew not found"), "", "brew not found");
        return;
      }
      if (command === "curl") {
        writeFileSync("/tmp/cloudflared", payload);
      }
      callback?.(null, "", "");
    });

    const { app } = createApp();
    const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({ success: true, command: expect.stringContaining("cloudflared-darwin-arm64") }));
    expect(mockExecFile.mock.calls.some(([command]) => command === "brew")).toBe(false);
    expect(mockExecFile.mock.calls.some(([command, args]) => command === "curl" && Array.isArray(args) && String(args[3]).includes("cloudflared-darwin-arm64"))).toBe(true);
  });

  it("returns install failure details when cloudflared installation command fails", async () => {
    setProcessRuntime("linux", "x64");
    const sha256 = "a".repeat(64);
    __setCloudflaredManifestForTesting(makeVerifiedManifest("cloudflared-linux-amd64", sha256));
    mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      const callback = typeof optionsOrCallback === "function"
        ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void
        : maybeCallback;
      if (command === "curl") {
        callback?.(new Error("Command failed"), "", "Command failed");
        return;
      }
      callback?.(null, "", "");
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

  describe("cloudflared manifest verification", () => {
    it("validateCloudflaredManifest accepts a pending manifest", () => {
      expect(validateCloudflaredManifest({ source: "upstream-pending-verification", version: null, verifiedAt: null, assets: {} })).toEqual({ ok: true });
    });

    it("validateCloudflaredManifest rejects pending manifest with non-empty assets", () => {
      const result = validateCloudflaredManifest({ source: "upstream-pending-verification", version: null, verifiedAt: null, assets: { a: { url: "x", sha256: "a" } } });
      expect(result.ok).toBe(false);
    });

    it("validateCloudflaredManifest accepts a verified manifest with proper sha256 and tagged URL", () => {
      expect(validateCloudflaredManifest(makeVerifiedManifest("cloudflared-linux-amd64", "a".repeat(64)))).toEqual({ ok: true });
    });

    it("validateCloudflaredManifest rejects verified manifest with releases/latest/download URL", () => {
      const result = validateCloudflaredManifest({ source: "upstream-verified", version: "v", verifiedAt: "2026-01-01T00:00:00.000Z", assets: { a: { url: "https://github.com/cloudflare/cloudflared/releases/latest/download/a", sha256: "a".repeat(64) } } });
      expect(result.ok).toBe(false);
    });

    it("validateCloudflaredManifest rejects verified manifest with empty sha256", () => {
      const result = validateCloudflaredManifest({ source: "upstream-verified", version: "v", verifiedAt: "2026-01-01T00:00:00.000Z", assets: { a: { url: "https://github.com/cloudflare/cloudflared/releases/download/v/a", sha256: "" } } });
      expect(result.ok).toBe(false);
    });

    it("validateCloudflaredManifest rejects verified manifest with uppercase or short sha256", () => {
      expect(validateCloudflaredManifest({ source: "upstream-verified", version: "v", verifiedAt: "2026-01-01T00:00:00.000Z", assets: { a: { url: "https://github.com/cloudflare/cloudflared/releases/download/v/a", sha256: "A".repeat(64) } } }).ok).toBe(false);
      expect(validateCloudflaredManifest({ source: "upstream-verified", version: "v", verifiedAt: "2026-01-01T00:00:00.000Z", assets: { a: { url: "https://github.com/cloudflare/cloudflared/releases/download/v/a", sha256: "a".repeat(63) } } }).ok).toBe(false);
    });

    it("validateCloudflaredManifest never throws on garbage input", () => {
      for (const input of [null, undefined, 42, "string", []]) {
        expect(() => validateCloudflaredManifest(input)).not.toThrow();
        expect(validateCloudflaredManifest(input).ok).toBe(false);
      }
    });

    it("installCloudflared fails closed when manifest is upstream-pending-verification", async () => {
      setProcessRuntime("linux", "x64");
      const { app } = createApp();
      const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});
      expect(result.body.success).toBe(false);
      expect(result.body.error).toContain("upstream-pending-verification");
      expect(mockExecFile.mock.calls.every(([command]) => command !== "curl")).toBe(true);
    });

    it("installCloudflared verifies sha256 and proceeds on verified manifest", async () => {
      setProcessRuntime("linux", "x64");
      const payload = Buffer.from("verified-payload");
      const sha256 = createHash("sha256").update(payload).digest("hex");
      __setCloudflaredManifestForTesting(makeVerifiedManifest("cloudflared-linux-amd64", sha256));
      mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        const callback = typeof optionsOrCallback === "function" ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void : maybeCallback;
        if (command === "curl") writeFileSync("/tmp/cloudflared", payload);
        callback?.(null, "", "");
      });
      const { app } = createApp();
      const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});
      expect(result.body.success).toBe(true);
      expect(mockExecFile.mock.calls.some(([command]) => command === "chmod")).toBe(true);
      expect(mockExecFile.mock.calls.some(([command]) => command === "mv")).toBe(true);
    });

    it("installCloudflared aborts when downloaded sha256 does not match", async () => {
      setProcessRuntime("linux", "x64");
      __setCloudflaredManifestForTesting(makeVerifiedManifest("cloudflared-linux-amd64", "a".repeat(64)));
      mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        const callback = typeof optionsOrCallback === "function" ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void : maybeCallback;
        if (command === "curl") writeFileSync("/tmp/cloudflared", Buffer.from("mismatch"));
        callback?.(null, "", "");
      });
      const { app } = createApp();
      const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});
      expect(result.body.success).toBe(false);
      expect(result.body.error).toContain("sha256 mismatch");
      expect(mockExecFile.mock.calls.some(([command]) => command === "rm")).toBe(true);
      const firstChmodIndex = mockExecFile.mock.calls.findIndex(([command]) => command === "chmod");
      const firstMvIndex = mockExecFile.mock.calls.findIndex(([command]) => command === "mv");
      expect(firstChmodIndex).toBe(-1);
      expect(firstMvIndex).toBe(-1);
    });

    it("installCloudflared on win32 (winget) is unchanged by manifest state", async () => {
      setProcessRuntime("win32", "x64");
      const { app } = createApp();
      const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});
      expect(result.body.success).toBe(true);
      expect(mockExecFile.mock.calls.some(([command]) => command === "winget")).toBe(true);
    });

    it("installCloudflared on darwin uses brew when present, regardless of manifest state", async () => {
      setProcessRuntime("darwin", "arm64");
      mockExecFile.mockImplementation((command: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout?: string, stderr?: string) => void) => {
        const callback = typeof optionsOrCallback === "function" ? optionsOrCallback as (error: Error | null, stdout?: string, stderr?: string) => void : maybeCallback;
        callback?.(null, command === "which" ? "/opt/homebrew/bin/brew" : "", "");
      });
      const { app } = createApp();
      const result = await REQUEST(app, "POST", "/api/remote/install-cloudflared", {});
      expect(result.body.success).toBe(true);
      expect(mockExecFile.mock.calls.some(([command]) => command === "brew")).toBe(true);
    });
  });
});

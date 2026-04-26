// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RemoteAccessProjectSettings, TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request as performRequest, get as performGet } from "../test-request.js";
import {
  __resetRemoteAuthStateForTests,
  constantTimeEqual,
  issueRemoteAuthToken,
  maskRemoteToken,
  validateRemoteAuthToken,
} from "../remote-auth.js";

function createRemoteSettings(overrides: Partial<RemoteAccessProjectSettings> = {}): RemoteAccessProjectSettings {
  return {
    activeProvider: "tailscale",
    providers: {
      tailscale: {
        enabled: true,
        hostname: "tail.example.ts.net",
        targetPort: 4040,
        acceptRoutes: false,
      },
      cloudflare: {
        enabled: false,
        tunnelName: "",
        tunnelToken: null,
        ingressUrl: "",
      },
    },
    tokenStrategy: {
      persistent: {
        enabled: true,
        token: "frt_persistent_token",
      },
      shortLived: {
        enabled: true,
        ttlMs: 120_000,
        maxTtlMs: 86_400_000,
      },
    },
    lifecycle: {
      rememberLastRunning: false,
      wasRunningOnShutdown: false,
      lastRunningProvider: null,
    },
    ...overrides,
  };
}

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue({ remoteAccess: createRemoteSettings() }),
    updateSettings: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    logEntry: vi.fn(),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

describe("remote-auth", () => {
  beforeEach(() => {
    __resetRemoteAuthStateForTests();
  });

  it("compares tokens with constant-time helper", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("short", "much-longer")).toBe(false);
  });

  it("returns missing when token is absent", () => {
    const result = validateRemoteAuthToken(undefined, createRemoteSettings());
    expect(result).toEqual({ status: "missing" });
  });

  it("returns disabled when remote access or token strategy is disabled", () => {
    const disabledRemote = validateRemoteAuthToken("anything", createRemoteSettings({ activeProvider: null }));
    expect(disabledRemote).toEqual({ status: "disabled" });

    const disabledStrategies = validateRemoteAuthToken(
      "anything",
      createRemoteSettings({
        tokenStrategy: {
          persistent: { enabled: false, token: null },
          shortLived: { enabled: false, ttlMs: 120_000, maxTtlMs: 86_400_000 },
        },
      }),
    );
    expect(disabledStrategies).toEqual({ status: "disabled" });
  });

  it("validates persistent token when configured", () => {
    const result = validateRemoteAuthToken("frt_persistent_token", createRemoteSettings());
    expect(result).toEqual({ status: "valid", tokenType: "persistent" });
  });

  it("issues and validates short-lived token before expiry", () => {
    const now = Date.parse("2026-04-26T12:00:00.000Z");
    const settings = createRemoteSettings();

    const issued = issueRemoteAuthToken("short-lived", settings, now);
    const result = validateRemoteAuthToken(issued.token, settings, now + 30_000);

    expect(issued.tokenType).toBe("short-lived");
    expect(issued.expiresAt).toBeDefined();
    expect(result.status).toBe("valid");
    expect(result.tokenType).toBe("short-lived");
  });

  it("marks short-lived token expired by expiresAt", () => {
    const now = Date.parse("2026-04-26T12:00:00.000Z");
    const settings = createRemoteSettings({
      tokenStrategy: {
        persistent: { enabled: true, token: "frt_persistent_token" },
        shortLived: { enabled: true, ttlMs: 60_000, maxTtlMs: 86_400_000 },
      },
    });

    const issued = issueRemoteAuthToken("short-lived", settings, now);
    const result = validateRemoteAuthToken(issued.token, settings, now + 60_001);

    expect(result.status).toBe("expired");
    expect(result.tokenType).toBe("short-lived");
  });

  it("enforces configured ttl when validating existing short-lived tokens", () => {
    const now = Date.parse("2026-04-26T12:00:00.000Z");
    const longTtlSettings = createRemoteSettings({
      tokenStrategy: {
        persistent: { enabled: true, token: "frt_persistent_token" },
        shortLived: { enabled: true, ttlMs: 180_000, maxTtlMs: 86_400_000 },
      },
    });

    const issued = issueRemoteAuthToken("short-lived", longTtlSettings, now);

    const shorterTtlSettings = createRemoteSettings({
      tokenStrategy: {
        persistent: { enabled: true, token: "frt_persistent_token" },
        shortLived: { enabled: true, ttlMs: 60_000, maxTtlMs: 86_400_000 },
      },
    });

    const result = validateRemoteAuthToken(issued.token, shorterTtlSettings, now + 61_000);
    expect(result.status).toBe("expired");
  });

  it("returns invalid for unknown tokens", () => {
    const result = validateRemoteAuthToken("frt_unknown", createRemoteSettings());
    expect(result).toEqual({ status: "invalid" });
  });

  it("masks remote token values in diagnostics", () => {
    expect(maskRemoteToken("12345678")).toBe("********");
    expect(maskRemoteToken("frt_abcdefghijklmnop")).toBe("frt_…mnop");
  });
});

describe("remote auth route contracts", () => {
  beforeEach(() => {
    __resetRemoteAuthStateForTests();
  });

  it("returns login-url payload with token shape for both persistent and short-lived modes", async () => {
    const app = createServer(createMockStore(), { noAuth: true });

    const persistent = await performRequest(
      app,
      "POST",
      "/api/remote-access/auth/login-url",
      JSON.stringify({ mode: "persistent" }),
      { "Content-Type": "application/json" },
    );

    expect(persistent.status).toBe(200);
    expect(persistent.body).toMatchObject({
      tokenType: "persistent",
      loginUrl: expect.stringContaining("/remote-login?rt="),
    });

    const shortLived = await performRequest(
      app,
      "POST",
      "/api/remote-access/auth/login-url",
      JSON.stringify({ mode: "short-lived" }),
      { "Content-Type": "application/json" },
    );

    expect(shortLived.status).toBe(200);
    expect(shortLived.body).toMatchObject({
      tokenType: "short-lived",
      loginUrl: expect.stringContaining("/remote-login?rt="),
      expiresAt: expect.any(String),
    });
  });

  it("validates /remote-login?rt= for persistent, short-lived, expired, missing, and malformed tokens", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-26T12:00:00.000Z"));
      const app = createServer(createMockStore(), { daemon: { token: "fn_daemon_token" } });

      const persistentValid = await performGet(app, "/remote-login?rt=frt_persistent_token");
      expect(persistentValid.status).toBe(302);
      expect(persistentValid.headers.location).toBe("/?token=fn_daemon_token");

      const issueShortLived = await performRequest(
        app,
        "POST",
        "/api/remote-access/auth/login-url",
        JSON.stringify({ mode: "short-lived" }),
        { "Content-Type": "application/json", Authorization: "Bearer fn_daemon_token" },
      );
      expect(issueShortLived.status).toBe(200);
      const issued = new URL(String((issueShortLived.body as Record<string, unknown>).loginUrl));
      const shortToken = issued.searchParams.get("rt");
      expect(shortToken).toBeTruthy();

      const shortValid = await performGet(app, `/remote-login?rt=${shortToken}`);
      expect(shortValid.status).toBe(302);

      vi.advanceTimersByTime(121000);

      const shortExpired = await performGet(app, `/remote-login?rt=${shortToken}`);
      expect(shortExpired.status).toBe(401);
      expect(shortExpired.body).toEqual({ error: "Unauthorized", code: "remote_token_expired" });

      const missing = await performGet(app, "/remote-login");
      expect(missing.status).toBe(401);
      expect(missing.body).toEqual({ error: "Unauthorized", code: "remote_token_missing" });

      const malformed = await performGet(app, "/remote-login?rt=not-a-valid-token");
      expect(malformed.status).toBe(401);
      expect(malformed.body).toEqual({ error: "Unauthorized", code: "remote_token_invalid" });
    } finally {
      vi.useRealTimers();
    }
  });
});

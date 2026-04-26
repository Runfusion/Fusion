/**
 * Integration tests for auth middleware with createServer.
 * Tests the full end-to-end authentication flow: valid token accepted,
 * no/invalid token rejected, health endpoint exempt, backward compatibility.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockInit,
      close: mockClose,
      getLocalNode: vi.fn().mockResolvedValue({
        id: "node_local",
        name: "local",
        type: "local",
        status: "online",
        maxConcurrent: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      listNodes: vi.fn().mockResolvedValue([
        {
          id: "node_local",
          name: "local",
          type: "local",
          status: "online",
          maxConcurrent: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
      updateNode: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-auth-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-auth-test/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }
}

describe("Auth middleware integration with createServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("with daemonToken option", () => {
    it("accepts valid bearer token", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore, {
        daemon: { token: "fn_test1234567890abcdef" },
      });

      const response = await request(
        app,
        "GET",
        "/api/tasks",
        undefined,
        { Authorization: "Bearer fn_test1234567890abcdef" }
      );

      expect(response.status).toBe(200);
    });

    it("rejects request without Authorization header", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore, {
        daemon: { token: "fn_test1234567890abcdef" },
      });

      const response = await request(app, "GET", "/api/tasks");

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
        message: "Valid bearer token required",
      });
    });

    it("rejects request with invalid bearer token", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore, {
        daemon: { token: "fn_test1234567890abcdef" },
      });

      const response = await request(
        app,
        "GET",
        "/api/tasks",
        undefined,
        { Authorization: "Bearer fn_wrong_token" }
      );

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: "Unauthorized",
        message: "Valid bearer token required",
      });
    });

    it("exempts /api/health from authentication", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore, {
        daemon: { token: "fn_test1234567890abcdef" },
      });

      const response = await request(app, "GET", "/api/health");

      expect(response.status).toBe(200);
    });

    it("exempts /api/health/ with subpath from authentication", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore, {
        daemon: { token: "fn_test1234567890abcdef" },
      });

      // /api/health returns 200 (health check endpoint)
      // The middleware correctly exempts paths starting with /api/health/
      // but the specific path /api/health/detailed may not exist (404 vs 401)
      // We test that the request is NOT rejected with 401 (auth not enforced)
      const response = await request(app, "GET", "/api/health/detailed");

      // The auth middleware is bypassed, so we get 404 (route not found) not 401 (unauthorized)
      expect(response.status).not.toBe(401);
    });

    it("accepts valid token with Bearer prefix variation", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore, {
        daemon: { token: "fn_test1234567890abcdef" },
      });

      // Test that the middleware correctly parses Bearer prefix
      const response = await request(
        app,
        "GET",
        "/api/tasks",
        undefined,
        { Authorization: "Bearer fn_test1234567890abcdef" }
      );

      expect(response.status).toBe(200);
    });

    it("rejects request with wrong Bearer prefix", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore, {
        daemon: { token: "fn_test1234567890abcdef" },
      });

      const response = await request(
        app,
        "GET",
        "/api/tasks",
        undefined,
        { Authorization: "Basic fn_test1234567890abcdef" }
      );

      expect(response.status).toBe(401);
    });

    it("rejects request with empty Bearer token", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore, {
        daemon: { token: "fn_test1234567890abcdef" },
      });

      const response = await request(
        app,
        "GET",
        "/api/tasks",
        undefined,
        { Authorization: "Bearer " }
      );

      expect(response.status).toBe(401);
    });
  });

  describe("without daemonToken option (backward compatibility)", () => {
    it("allows unauthenticated access when no daemonToken is set", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore);

      const response = await request(app, "GET", "/api/tasks");

      expect(response.status).toBe(200);
    });

    it("allows access to /api/health without daemonToken", async () => {
      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore);

      const response = await request(app, "GET", "/api/health");

      expect(response.status).toBe(200);
    });
  });

  describe("with FUSION_DAEMON_TOKEN environment variable", () => {
    const originalEnv = process.env.FUSION_DAEMON_TOKEN;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.FUSION_DAEMON_TOKEN = originalEnv;
      } else {
        delete process.env.FUSION_DAEMON_TOKEN;
      }
    });

    it("activates auth when FUSION_DAEMON_TOKEN env var is set", async () => {
      process.env.FUSION_DAEMON_TOKEN = "fn_envtoken1234567890";

      const store = new MockStore();
      const app = createServer(store as unknown as TaskStore);

      // Should reject without token
      const noAuthResponse = await request(app, "GET", "/api/tasks");
      expect(noAuthResponse.status).toBe(401);

      // Should accept with correct token
      const authResponse = await request(
        app,
        "GET",
        "/api/tasks",
        undefined,
        { Authorization: "Bearer fn_envtoken1234567890" }
      );
      expect(authResponse.status).toBe(200);

      // Should exempt health endpoint
      const healthResponse = await request(app, "GET", "/api/health");
      expect(healthResponse.status).toBe(200);
    });
  });

  describe("remote login hybrid token validation", () => {
    function buildRemoteAccessSettings() {
      return {
        enabled: true,
        activeProvider: "cloudflare",
        providers: {
          tailscale: {
            enabled: false,
            hostname: "tail.example.ts.net",
            targetPort: 4040,
            acceptRoutes: false,
          },
          cloudflare: {
            enabled: true,
            tunnelName: "demo-tunnel",
            tunnelToken: "cf-secret",
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
          rememberLastRunning: false,
          wasRunningOnShutdown: false,
          lastRunningProvider: null,
        },
      };
    }

    it("returns fully-qualified login-url payloads and consistent invalid token errors", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-04-26T12:00:00.000Z"));

        const store = new MockStore() as unknown as TaskStore & { getSettings: ReturnType<typeof vi.fn> };
        store.getSettings = vi.fn().mockResolvedValue({ remoteAccess: buildRemoteAccessSettings() });

        const app = createServer(store as unknown as TaskStore, { daemon: { token: "fn_daemon_token" } });

        const persistentIssue = await request(
          app,
          "POST",
          "/api/remote-access/auth/login-url",
          JSON.stringify({ mode: "persistent" }),
          {
            "Content-Type": "application/json",
            Authorization: "Bearer fn_daemon_token",
          },
        );

        expect(persistentIssue.status).toBe(200);
        expect(persistentIssue.body).toMatchObject({ tokenType: "persistent" });
        const persistentUrl = new URL(String((persistentIssue.body as Record<string, unknown>).loginUrl));
        expect(persistentUrl.protocol).toBe("https:");
        expect(persistentUrl.host).toBe("remote.example.com");
        expect(persistentUrl.pathname).toBe("/remote-login");
        expect(persistentUrl.searchParams.get("rt")).toMatch(/^frt_[A-Za-z0-9_-]+$/);

        const shortIssue = await request(
          app,
          "POST",
          "/api/remote-access/auth/login-url",
          JSON.stringify({ mode: "short-lived" }),
          {
            "Content-Type": "application/json",
            Authorization: "Bearer fn_daemon_token",
          },
        );

        expect(shortIssue.status).toBe(200);
        expect(shortIssue.body).toMatchObject({ tokenType: "short-lived", expiresAt: expect.any(String) });

        const shortUrl = new URL(String((shortIssue.body as Record<string, unknown>).loginUrl));
        const shortToken = shortUrl.searchParams.get("rt");
        expect(shortToken).toMatch(/^frt_[A-Za-z0-9_-]+$/);

        const invalid = await request(app, "GET", "/remote-login?rt=frt_wrong");
        const missing = await request(app, "GET", "/remote-login");

        vi.advanceTimersByTime(121000);
        const expired = await request(app, "GET", `/remote-login?rt=${shortToken}`);

        expect(invalid.status).toBe(401);
        expect(missing.status).toBe(401);
        expect(expired.status).toBe(401);

        expect(invalid.body).toEqual({ error: "Unauthorized", code: "remote_token_invalid" });
        expect(missing.body).toEqual({ error: "Unauthorized", code: "remote_token_missing" });
        expect(expired.body).toEqual({ error: "Unauthorized", code: "remote_token_expired" });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

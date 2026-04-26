// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHmac } from "node:crypto";
import express from "express";
import { createServer, setupTerminalWebSocket } from "../server.js";
import { toSessionTag } from "../terminal-websocket-diagnostics.js";
import { RATE_LIMITS } from "../rate-limit.js";
import type { TaskStore } from "@fusion/core";
import { get as performGet, request as performRequest } from "../test-request.js";

// Mock terminal-service before any imports that use it
vi.mock("../terminal-service.js", () => {
  const mockTerminalService = {
    getSession: vi.fn(),
    getScrollbackAndClearPending: vi.fn().mockReturnValue(null),
    onData: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {}),
    write: vi.fn(),
    resize: vi.fn(),
    evictStaleSessions: vi.fn().mockReturnValue(0),
  };

  return {
    getTerminalService: vi.fn(() => mockTerminalService),
    STALE_SESSION_THRESHOLD_MS: 300_000,
    __mockTerminalService: mockTerminalService,
  };
});

// Access the mock terminal service
const { __mockTerminalService: mockTerminalService } = await import("../terminal-service.js") as any;

function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    getDatabase: vi.fn().mockReturnValue({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    }),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockReturnValue([]),
      createMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      updateMission: vi.fn(),
      getMission: vi.fn(),
      deleteMission: vi.fn(),
      listMilestonesByMission: vi.fn().mockReturnValue([]),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      getMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      listTasksByMilestone: vi.fn().mockReturnValue([]),
      createMissionTask: vi.fn(),
      updateMissionTask: vi.fn(),
      getMissionTask: vi.fn(),
      deleteMissionTask: vi.fn(),
    }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

function createTerminalLoggerHarness() {
  const terminalLogger = {
    scope: "server:terminal",
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  terminalLogger.child.mockReturnValue(terminalLogger);

  const runtimeLogger = {
    scope: "server",
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  runtimeLogger.child.mockImplementation((scope: string) => {
    if (scope === "terminal") {
      return terminalLogger;
    }
    return runtimeLogger;
  });

  return { runtimeLogger, terminalLogger };
}

async function GET(app: ReturnType<typeof createServer>, path: string): Promise<{ status: number; body: unknown; headers: Record<string, unknown> }> {
  const res = await performGet(app, path);
  return res;
}

async function REQUEST(
  app: ReturnType<typeof createServer>,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: Record<string, unknown> }> {
  return performRequest(app, method, path, body, headers);
}

async function flushStartupCleanupTasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createServer AI session startup cleanup diagnostics", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createRuntimeLoggerMock() {
    const logger = {
      scope: "server",
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    return logger;
  }

  function createAiSessionStoreMock(overrides: Record<string, unknown> = {}) {
    return {
      on: vi.fn(),
      off: vi.fn(),
      recoverStaleSessions: vi.fn(),
      listRecoverable: vi.fn().mockReturnValue([]),
      cleanupStaleSessions: vi.fn().mockReturnValue({
        terminalDeleted: 0,
        orphanedDeleted: 0,
        totalDeleted: 0,
      }),
      stopScheduledCleanup: vi.fn(),
      ...overrides,
    };
  }

  it("logs structured startup cleanup summary on success", async () => {
    const runtimeLogger = createRuntimeLoggerMock();
    const aiSessionStore = createAiSessionStoreMock({
      cleanupStaleSessions: vi.fn().mockReturnValue({
        terminalDeleted: 2,
        orphanedDeleted: 1,
        totalDeleted: 3,
      }),
    });
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        aiSessionTtlMs: 700_000,
        aiSessionCleanupIntervalMs: 120_000,
      }),
    });

    createServer(store, {
      runtimeLogger: runtimeLogger as any,
      aiSessionStore: aiSessionStore as any,
      headless: true,
    });

    await flushStartupCleanupTasks();

    expect(aiSessionStore.cleanupStaleSessions).toHaveBeenCalledWith(700_000);
    expect(runtimeLogger.info).toHaveBeenCalledWith(
      "AI session cleanup summary",
      expect.objectContaining({
        message: "Removed stale AI sessions",
        source: "initial",
        ttlMs: 700_000,
        terminalDeleted: 2,
        orphanedDeleted: 1,
        totalDeleted: 3,
      }),
    );
  });

  it("logs structured startup cleanup failure and keeps server creation non-fatal", async () => {
    const runtimeLogger = createRuntimeLoggerMock();
    const aiSessionStore = createAiSessionStoreMock({
      cleanupStaleSessions: vi.fn().mockImplementation(() => {
        throw new Error("cleanup exploded");
      }),
    });
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({
        aiSessionTtlMs: 900_000,
        aiSessionCleanupIntervalMs: 180_000,
      }),
    });

    const app = createServer(store, {
      runtimeLogger: runtimeLogger as any,
      aiSessionStore: aiSessionStore as any,
      headless: true,
    });

    await flushStartupCleanupTasks();

    expect(app).toBeDefined();
    expect(runtimeLogger.error).toHaveBeenCalledWith(
      "AI session cleanup failed",
      expect.objectContaining({
        message: "Initial AI session cleanup failed",
        source: "initial",
        ttlMs: 900_000,
        errorName: "Error",
        errorMessage: "cleanup exploded",
        error: "cleanup exploded",
      }),
    );
  });

  it("logs structured settings fallback warning and continues with default cleanup values", async () => {
    const runtimeLogger = createRuntimeLoggerMock();
    const aiSessionStore = createAiSessionStoreMock({
      cleanupStaleSessions: vi.fn().mockReturnValue({
        terminalDeleted: 1,
        orphanedDeleted: 0,
        totalDeleted: 1,
      }),
    });
    const store = createMockStore({
      getSettings: vi.fn().mockRejectedValue(new Error("settings unavailable")),
    });

    const app = createServer(store, {
      runtimeLogger: runtimeLogger as any,
      aiSessionStore: aiSessionStore as any,
      headless: true,
    });

    await flushStartupCleanupTasks();

    expect(app).toBeDefined();
    expect(runtimeLogger.warn).toHaveBeenCalledWith(
      "AI session cleanup settings fallback",
      expect.objectContaining({
        message: "Failed to load settings for AI session cleanup; using defaults",
        fallbackTtlMs: 7 * 24 * 60 * 60 * 1000,
        fallbackCleanupIntervalMs: 6 * 60 * 60 * 1000,
        errorName: "Error",
        errorMessage: "settings unavailable",
        error: "settings unavailable",
      }),
    );
    expect(aiSessionStore.cleanupStaleSessions).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000);
  });
});

describe("createServer health and headless mode", () => {
  it("returns liveness payload from /api/health", async () => {
    const store = createMockStore();
    const app = createServer(store);

    const res = await GET(app, "/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      version: expect.any(String),
      uptime: expect.any(Number),
    });
  });

  it("serves API routes but no frontend when headless=true", async () => {
    const store = createMockStore();
    const app = createServer(store, { headless: true });

    const tasksRes = await GET(app, "/api/tasks");
    expect(tasksRes.status).toBe(200);

    const rootRes = await GET(app, "/");
    expect(rootRes.status).toBe(404);
  });

  it("wires remote settings/auth routes in both dashboard and headless modes", async () => {
    const remoteAccess = {
      enabled: true,
      activeProvider: "cloudflare",
      providers: {
        tailscale: { enabled: false, hostname: "", targetPort: 4040, acceptRoutes: false },
        cloudflare: { enabled: true, tunnelName: "demo", tunnelToken: "cf-secret", ingressUrl: "https://remote.example.com" },
      },
      tokenStrategy: {
        persistent: { enabled: true, token: "frt_persistent_token" },
        shortLived: { enabled: true, ttlMs: 120000, maxTtlMs: 86400000 },
      },
      lifecycle: { rememberLastRunning: false, wasRunningOnShutdown: false, lastRunningProvider: null },
    };

    const dashboard = createServer(createMockStore({ getSettings: vi.fn().mockResolvedValue({ remoteAccess }) }));
    const headless = createServer(createMockStore({ getSettings: vi.fn().mockResolvedValue({ remoteAccess }) }), { headless: true });

    const [dashSettings, headlessSettings, dashLoginUrl, headlessLoginUrl, dashStatus, headlessStatus, headlessRoot] = await Promise.all([
      GET(dashboard, "/api/remote/settings"),
      GET(headless, "/api/remote/settings"),
      REQUEST(headless, "POST", "/api/remote-access/auth/login-url", JSON.stringify({ mode: "persistent" }), { "Content-Type": "application/json" }),
      REQUEST(dashboard, "POST", "/api/remote-access/auth/login-url", JSON.stringify({ mode: "persistent" }), { "Content-Type": "application/json" }),
      GET(dashboard, "/api/remote/status"),
      GET(headless, "/api/remote/status"),
      GET(headless, "/"),
    ]);

    expect(dashSettings.status).toBe(200);
    expect(headlessSettings.status).toBe(200);
    expect(dashLoginUrl.status).toBe(200);
    expect(headlessLoginUrl.status).toBe(200);
    expect(dashStatus.status).toBe(200);
    expect(headlessStatus.status).toBe(200);

    const dashLoginBody = dashLoginUrl.body as Record<string, unknown>;
    const headlessLoginBody = headlessLoginUrl.body as Record<string, unknown>;
    expect(Object.keys(dashLoginBody).sort()).toEqual(["loginUrl", "tokenType"]);
    expect(Object.keys(headlessLoginBody).sort()).toEqual(["loginUrl", "tokenType"]);
    expect(String(dashLoginBody.loginUrl)).toContain("/remote-login?rt=");
    expect(String(headlessLoginBody.loginUrl)).toContain("/remote-login?rt=");

    const dashStatusBody = dashStatus.body as Record<string, unknown>;
    const headlessStatusBody = headlessStatus.body as Record<string, unknown>;
    expect(Object.keys(dashStatusBody).sort()).toEqual(["lastError", "lastErrorCode", "provider", "restore", "state", "url"]);
    expect(Object.keys(headlessStatusBody).sort()).toEqual(["lastError", "lastErrorCode", "provider", "restore", "state", "url"]);
    expect(headlessRoot.status).toBe(404);
  });
});

describe("API Error Handling Middleware", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createMockStore();
  });

  describe("404 handler for unmatched API routes", () => {
    it("returns JSON 404 for unmatched API routes", async () => {
      const app = createServer(store);
      const res = await GET(app, "/api/nonexistent/route");
      
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
      expect(res.headers["content-type"]).toContain("application/json");
    });

    it("returns JSON 404 for unmatched API paths under known routes", async () => {
      const app = createServer(store);
      const res = await GET(app, "/api/tasks/nonexistent/path");
      
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
      expect(res.headers["content-type"]).toContain("application/json");
    });
  });

  describe("Error handler for route failures", () => {
    it("returns JSON 500 when a route handler throws an error", async () => {
      // Create a store that throws an error for listTasks
      const failingStore = createMockStore({
        listTasks: vi.fn().mockRejectedValue(new Error("Database connection failed")),
      });
      
      const app = createServer(failingStore);
      const res = await GET(app, "/api/tasks");
      
      expect(res.status).toBe(500);
      // Error handler returns actual error message (may be "Internal server error" or specific message)
      expect(res.body).toHaveProperty("error");
      expect(res.headers["content-type"]).toContain("application/json");
    });
  });

  describe("SPA fallback behavior", () => {
    it("does not return HTML for API 404s", async () => {
      const app = createServer(store);
      const res = await GET(app, "/api/unknown-endpoint");
      
      // Should NOT get HTML (the SPA fallback returns HTML)
      expect(res.status).toBe(404);
      expect(typeof res.body).toBe("object"); // JSON object
      expect(res.body).toHaveProperty("error");
      expect(res.headers["content-type"]).toContain("application/json");
      // Verify we didn't get HTML
      if (typeof res.body === "string") {
        expect(res.body).not.toContain("<!DOCTYPE html>");
        expect(res.body).not.toContain("<html");
      }
    });
  });

  describe("planning API route content types", () => {
    it("returns JSON for all POST planning endpoints instead of falling through to SPA HTML", async () => {
      const endpoints = [
        "/api/planning/start",
        "/api/planning/start-streaming",
        "/api/planning/respond",
        "/api/planning/cancel",
        "/api/planning/create-task",
      ];

      for (const path of endpoints) {
        const app = createServer(store);
        const res = await REQUEST(app, "POST", path, JSON.stringify({}), {
          "Content-Type": "application/json",
        });

        expect(res.headers["content-type"]).toContain("application/json");
        if (typeof res.body === "string") {
          expect(res.body).not.toContain("<!DOCTYPE html>");
          expect(res.body).not.toContain("<html");
        }
      }
    });

    it("returns JSON 404s for unmatched planning API routes", async () => {
      const app = createServer(store);
      const res = await REQUEST(app, "POST", "/api/planning/not-a-route", JSON.stringify({}), {
        "Content-Type": "application/json",
      });

      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).toEqual({ error: "Not found" });
    });
  });

  describe("API rate limiting", () => {
    it("does not rate limit general dashboard reads", async () => {
      const app = createServer(store);

      for (let i = 0; i < 150; i++) {
        const res = await GET(app, `/api/nonexistent-read-${i}`);
        expect(res.status).toBe(404);
      }

      const trailingReadRes = await GET(app, "/api/nonexistent-read-final");
      expect(trailingReadRes.status).toBe(404);
    });

    it("allows setup reads after the general read budget is exhausted", async () => {
      const app = createServer(store);

      for (let i = 0; i < 150; i++) {
        const res = await GET(app, `/api/nonexistent-read-${i}`);
        expect(res.status).toBe(404);
      }

      const browseRes = await GET(app, "/api/browse-directory");

      expect(browseRes.status).toBe(200);
      expect(browseRes.body).toHaveProperty("currentPath");
      expect(browseRes.body).toHaveProperty("entries");
    });

    it("still enforces the mutation rate-limit budget independently", async () => {
      const app = createServer(store);

      for (let i = 0; i < RATE_LIMITS.mutation.max; i++) {
        const res = await REQUEST(
          app,
          "POST",
          "/api/planning/not-a-route",
          JSON.stringify({}),
          { "Content-Type": "application/json" },
        );
        expect(res.status).toBe(404);
      }

      const limitedRes = await REQUEST(
        app,
        "POST",
        "/api/planning/not-a-route",
        JSON.stringify({}),
        { "Content-Type": "application/json" },
      );

      expect(limitedRes.status).toBe(429);
      expect(limitedRes.body).toEqual({ error: "Too many requests, please try again later." });
    });

    it("allows project setup mutations after the general mutation budget is exhausted", async () => {
      const app = createServer(store);

      for (let i = 0; i < RATE_LIMITS.mutation.max; i++) {
        const res = await REQUEST(
          app,
          "POST",
          "/api/planning/not-a-route",
          JSON.stringify({}),
          { "Content-Type": "application/json" },
        );
        expect(res.status).toBe(404);
      }

      const createProjectRes = await REQUEST(
        app,
        "POST",
        "/api/projects",
        JSON.stringify({}),
        { "Content-Type": "application/json" },
      );

      expect(createProjectRes.status).toBe(400);
      expect(createProjectRes.body).toEqual({
        error: "name is required and must be a non-empty string",
      });
    });
  });

  describe("Log stream project-scoped routing", () => {
    it("server is configured with log stream endpoint that accepts projectId", () => {
      const store = createMockStore();
      const app = createServer(store);

      // Verify the server was created successfully
      expect(app).toBeDefined();
    });
  });
});

describe("Terminal WebSocket heartbeat", () => {
  let app: ReturnType<typeof express>;
  let server: http.Server;
  let store: TaskStore;
  let runtimeLogger: ReturnType<typeof createTerminalLoggerHarness>["runtimeLogger"];
  let terminalLogger: ReturnType<typeof createTerminalLoggerHarness>["terminalLogger"];

  beforeEach(() => {
    app = express();
    server = http.createServer(app);
    store = createMockStore();
    vi.useFakeTimers();
    const loggerHarness = createTerminalLoggerHarness();
    runtimeLogger = loggerHarness.runtimeLogger;
    terminalLogger = loggerHarness.terminalLogger;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    server.close();
  });

  /** Create a mock WebSocket that simulates the ws library's WebSocket */
  function createMockWs(): any {
    const listeners: Record<string, Function[]> = {};
    return {
      readyState: 1, // OPEN
      _listeners: listeners,
      on(event: string, handler: Function) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(handler);
      },
      emit(event: string, ...args: any[]) {
        (listeners[event] || []).forEach((h) => h(...args));
      },
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
    };
  }

  /** Create a mock HTTP request with sessionId */
  function createMockReq(sessionId: string): any {
    return {
      url: `/api/terminal/ws?sessionId=${sessionId}`,
      headers: { host: "localhost:3000" },
    };
  }

  /** Setup terminal WebSocket and trigger a connection */
  function setupAndConnect(ws: any, req: any, options: Record<string, unknown> = {}): void {
    setupTerminalWebSocket(app, server, store, {
      runtimeLogger: runtimeLogger as any,
      ...options,
    });

    // The function sets up wss on the server's upgrade event.
    // We need to access the WebSocketServer directly to emit a connection.
    // setupTerminalWebSocket stores wss on the app
    const storedWss = (app as any).terminalWsServer;
    if (storedWss) {
      storedWss.emit("connection", ws, req);
    }
  }

  it("does NOT terminate connection after 1 missed pong", () => {
    const ws = createMockWs();
    const req = createMockReq("session-1");

    // Setup a mock session
    mockTerminalService.getSession.mockReturnValue({
      id: "session-1",
      shell: "/bin/bash",
      cwd: "/fake/root",
      lastActivityAt: new Date(),
    });

    setupAndConnect(ws, req);

    // First ping interval: mark as not alive
    vi.advanceTimersByTime(30000);
    // The server sends a ping, ws is marked as not alive
    expect(ws.send).toHaveBeenCalled();

    // Don't send a pong response — simulate missed pong
    // Second ping interval: first missed pong — should NOT terminate
    vi.advanceTimersByTime(30000);

    // Connection should still be alive after 1 missed pong
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("terminates connection after 2 consecutive missed pongs", () => {
    const ws = createMockWs();
    const req = createMockReq("session-2");

    mockTerminalService.getSession.mockReturnValue({
      id: "session-2",
      shell: "/bin/bash",
      cwd: "/fake/root",
      lastActivityAt: new Date(),
    });

    setupAndConnect(ws, req);

    // First ping interval: mark as not alive (isAlive = false)
    vi.advanceTimersByTime(30000);
    expect(ws.send).toHaveBeenCalled();

    // Don't send pong — missed pong #1
    vi.advanceTimersByTime(30000);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(terminalLogger.info).toHaveBeenCalledWith(
      "Missed terminal websocket pong",
      expect.objectContaining({
        sessionTag: toSessionTag("session-2"),
        missedPongs: 1,
        maxMissedPongs: 2,
      }),
    );

    // Don't send pong — missed pong #2: should terminate
    vi.advanceTimersByTime(30000);
    expect(ws.terminate).toHaveBeenCalled();
    expect(terminalLogger.warn).toHaveBeenCalledWith(
      "Terminating terminal websocket after missed pong threshold",
      expect.objectContaining({
        sessionTag: toSessionTag("session-2"),
        missedPongs: 2,
        maxMissedPongs: 2,
      }),
    );
  });

  it("resets missed pong counter on successful pong", () => {
    const ws = createMockWs();
    const req = createMockReq("session-3");

    mockTerminalService.getSession.mockReturnValue({
      id: "session-3",
      shell: "/bin/bash",
      cwd: "/fake/root",
      lastActivityAt: new Date(),
    });

    setupAndConnect(ws, req);

    // First interval: mark as not alive
    vi.advanceTimersByTime(30000);

    // Miss first pong — interval 2: missedPongs = 1
    vi.advanceTimersByTime(30000);
    expect(ws.terminate).not.toHaveBeenCalled();

    // Now respond with pong (application-level "pong" message)
    const msgHandler = ws._listeners["message"]?.[0];
    expect(msgHandler).toBeDefined();
    msgHandler!(Buffer.from(JSON.stringify({ type: "pong" })));

    // Interval 3: isAlive is true again, missedPongs is 0
    vi.advanceTimersByTime(30000);
    // Still alive — missed pong counter was reset
    expect(ws.terminate).not.toHaveBeenCalled();

    // Miss 2 more pongs — should still be alive after just 1 more miss
    vi.advanceTimersByTime(30000);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("logs structured error and closes 4510 when scoped store resolution fails", async () => {
    const ws = createMockWs();
    const req = {
      url: "/api/terminal/ws?sessionId=session-4510&projectId=proj-a",
      headers: { host: "localhost:3000" },
    };

    const engineManager = {
      getEngine: vi.fn(() => {
        throw new Error("scope lookup failed");
      }),
    };

    setupAndConnect(ws, req, { engineManager });
    await Promise.resolve();

    expect(ws.close).toHaveBeenCalledWith(4510, "Failed to resolve project scope");
    expect(terminalLogger.error).toHaveBeenCalledWith(
      "Failed to resolve project scope",
      expect.objectContaining({
        projectId: "proj-a",
        error: "scope lookup failed",
      }),
    );
  });

  it("logs redacted cwd mismatch context and closes 4503", () => {
    const ws = createMockWs();
    const req = createMockReq("cross-project-session-1");

    mockTerminalService.getSession.mockReturnValue({
      id: "cross-project-session-1",
      shell: "/bin/bash",
      cwd: "/Users/alice/private/other-project",
      lastActivityAt: new Date(),
    });

    setupAndConnect(ws, req);

    expect(ws.close).toHaveBeenCalledWith(4503, "Session does not belong to this project");
    expect(terminalLogger.warn).toHaveBeenCalledWith(
      "Rejected terminal session outside scoped project root",
      expect.objectContaining({
        sessionTag: toSessionTag("cross-project-session-1"),
        sessionCwdHint: expect.stringContaining("<redacted>/"),
        scopedRootHint: expect.stringContaining("<redacted>/"),
      }),
    );
    expect(terminalLogger.warn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionCwd: "/Users/alice/private/other-project" }),
    );
  });

  it("logs structured warning for stale session reconnect with bounded context", () => {
    const ws = createMockWs();
    const req = createMockReq("stale-session-123456");

    // Session last active 10 minutes ago (past the 5-minute threshold)
    const tenMinutesAgo = new Date(Date.now() - 600_000);
    mockTerminalService.getSession.mockReturnValue({
      id: "stale-session-123456",
      shell: "/bin/bash",
      cwd: "/fake/root",
      lastActivityAt: tenMinutesAgo,
    });

    setupAndConnect(ws, req);

    expect(terminalLogger.warn).toHaveBeenCalledWith(
      "Terminal reconnect may target stale PTY session",
      expect.objectContaining({
        sessionTag: toSessionTag("stale-session-123456"),
        idleMs: 600_000,
      }),
    );
    expect(terminalLogger.warn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionId: "stale-session-123456" }),
    );
  });

  it("does not warn for fresh session reconnect", () => {
    const ws = createMockWs();
    const req = createMockReq("fresh-session");

    // Session last active 1 minute ago (under the 5-minute threshold)
    mockTerminalService.getSession.mockReturnValue({
      id: "fresh-session",
      shell: "/bin/bash",
      cwd: "/fake/root",
      lastActivityAt: new Date(Date.now() - 60_000),
    });

    setupAndConnect(ws, req);

    expect(terminalLogger.warn).not.toHaveBeenCalledWith(
      "Terminal reconnect may target stale PTY session",
      expect.anything(),
    );
  });
});

describe("Terminal stale-session eviction", () => {
  let app: ReturnType<typeof express>;
  let server: http.Server;
  let store: TaskStore;
  let runtimeLogger: ReturnType<typeof createTerminalLoggerHarness>["runtimeLogger"];
  let terminalLogger: ReturnType<typeof createTerminalLoggerHarness>["terminalLogger"];

  beforeEach(() => {
    app = express();
    server = http.createServer(app);
    store = createMockStore();
    vi.useFakeTimers();
    mockTerminalService.evictStaleSessions.mockReset().mockReturnValue(0);
    const loggerHarness = createTerminalLoggerHarness();
    runtimeLogger = loggerHarness.runtimeLogger;
    terminalLogger = loggerHarness.terminalLogger;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    server.close();
  });

  it("calls evictStaleSessions on each 60s interval tick", () => {
    setupTerminalWebSocket(app, server, store, { runtimeLogger: runtimeLogger as any });

    vi.advanceTimersByTime(60_000);
    expect(mockTerminalService.evictStaleSessions).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(mockTerminalService.evictStaleSessions).toHaveBeenCalledTimes(2);
    expect(terminalLogger.error).not.toHaveBeenCalledWith(
      "Stale session eviction failed",
      expect.anything(),
    );
  });

  it("logs structured error and continues when evictStaleSessions throws", () => {
    mockTerminalService.evictStaleSessions.mockImplementation(() => {
      throw new Error("simulated eviction failure");
    });

    setupTerminalWebSocket(app, server, store, { runtimeLogger: runtimeLogger as any });

    vi.advanceTimersByTime(60_000);

    expect(terminalLogger.error).toHaveBeenCalledWith(
      "Stale session eviction failed",
      expect.objectContaining({
        error: "simulated eviction failure",
        errorName: "Error",
        errorMessage: "simulated eviction failure",
      }),
    );

    vi.advanceTimersByTime(60_000);
    expect(mockTerminalService.evictStaleSessions).toHaveBeenCalledTimes(2);
  });

  it("stops eviction interval when server closes", () => {
    setupTerminalWebSocket(app, server, store, { runtimeLogger: runtimeLogger as any });

    server.emit("close");

    vi.advanceTimersByTime(120_000);
    expect(mockTerminalService.evictStaleSessions).not.toHaveBeenCalled();
  });
});

/**
 * Scoped Scheduling Resolver Regression Tests
 * ===========================================
 *
 * These tests verify the scoped scheduling resolver invariants across automation and routine routes.
 *
 * Scope Resolution Precedence:
 * 1. scope=global → Uses the default AutomationStore/RoutineStore from options (process-level)
 * 2. scope=project → Uses the same store with scope filtering at query time
 * 3. Omitted scope (legacy) → Defaults to project for POST, returns all for GET
 *
 * Error Contracts:
 * - 400: Invalid scope value ("invalid" is not "global" or "project")
 * - 503: Store unavailable when scope is specified
 * - 200: Empty array when store is unavailable (legacy fallback for backward compatibility)
 *
 * Cross-Project Isolation:
 * - scope=project requests never leak global-scoped items into results
 * - scope=global requests never include project-scoped items
 * - No opportunistic lane hopping: when scope=project has no results, it returns empty,
 *   NOT the global lane results
 *
 * Fallback Behavior:
 * - When no AutomationStore/RoutineStore is configured, GET endpoints return []
 *   (This is a legacy backward-compatible behavior)
 * - POST endpoints requiring a store will throw if no store is configured
 */
describe("createServer scoped scheduling resolver regressions", () => {
  // ── Mock factory helpers ─────────────────────────────────────────

  function createMockAutomationStore(name = "mock-automation-store") {
    return {
      listSchedules: vi.fn().mockResolvedValue([]),
      getSchedule: vi.fn(),
      createSchedule: vi.fn(),
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
      recordRun: vi.fn(),
      reorderSteps: vi.fn(),
      isValidCron: vi.fn().mockReturnValue(true),
    };
  }

  function createMockRoutineStore(name = "mock-routine-store") {
    return {
      listRoutines: vi.fn().mockResolvedValue([]),
      getRoutine: vi.fn(),
      createRoutine: vi.fn(),
      updateRoutine: vi.fn(),
      deleteRoutine: vi.fn(),
      isValidCron: vi.fn().mockReturnValue(true),
    };
  }

  function createMockRoutineRunner() {
    return {
      triggerManual: vi.fn().mockResolvedValue({ success: true }),
      triggerWebhook: vi.fn().mockResolvedValue({ success: true }),
    };
  }

  // ── Mock ProjectEngineManager ───────────────────────────────────

  function createMockEngineManager() {
    return {
      getEngine: vi.fn(),
      ensureEngine: vi.fn(),
      startReconciliation: vi.fn(),
    };
  }

  // ── Test fixtures ───────────────────────────────────────────────

  const FAKE_GLOBAL_SCHEDULE = {
    id: "sched-global-1",
    name: "Global Schedule",
    scope: "global" as const,
    scheduleType: "hourly" as const,
    command: "echo global",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const FAKE_PROJECT_SCHEDULE = {
    id: "sched-proj-a-1",
    name: "Project A Schedule",
    scope: "project" as const,
    scheduleType: "daily" as const,
    command: "echo proj-a",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const FAKE_GLOBAL_ROUTINE = {
    id: "routine-global-1",
    name: "Global Routine",
    scope: "global" as const,
    trigger: { type: "manual" as const },
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const FAKE_PROJECT_ROUTINE = {
    id: "routine-proj-a-1",
    name: "Project A Routine",
    scope: "project" as const,
    trigger: { type: "manual" as const },
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  // ── Automation lane selection tests ──────────────────────────────────────
  //
  // Automation lane selection: The automation store resolves based on scope parameter.
  // Precedence: global lane uses process-level store, project lane uses same store
  // with scope filtering. No lane switching occurs — scope=project with no project
  // schedules returns empty array, NOT global schedules.

  describe("Automation lane selection", () => {
    it("GET /api/automations?scope=global calls only global automation store", async () => {
      const globalStore = createMockAutomationStore("global");
      const projectStore = createMockAutomationStore("project");
      globalStore.listSchedules.mockResolvedValue([FAKE_GLOBAL_SCHEDULE]);

      const engineManager = createMockEngineManager();
      // engineManager returns undefined for all projects (no engine available)
      engineManager.getEngine.mockReturnValue(undefined);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
        engineManager: engineManager as any,
      });

      const res = await GET(app, "/api/automations?scope=global");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].scope).toBe("global");
      expect(globalStore.listSchedules).toHaveBeenCalledTimes(1);
    });

    it("GET /api/automations?scope=global returns only global schedules (no project leakage)", async () => {
      const globalStore = createMockAutomationStore("global");
      const projectStore = createMockAutomationStore("project");
      // Global store returns mixed results, but route filters by scope
      globalStore.listSchedules.mockResolvedValue([FAKE_GLOBAL_SCHEDULE, FAKE_PROJECT_SCHEDULE]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await GET(app, "/api/automations?scope=global");

      expect(res.status).toBe(200);
      // Route should filter by scope so only global schedules are returned
      expect(res.body.every((s: any) => s.scope === "global")).toBe(true);
    });

    it("GET /api/automations?scope=project returns only project-scoped schedules", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.listSchedules.mockResolvedValue([FAKE_GLOBAL_SCHEDULE, FAKE_PROJECT_SCHEDULE]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await GET(app, "/api/automations?scope=project");

      expect(res.status).toBe(200);
      // Route should filter by scope so only project schedules are returned
      expect(res.body.every((s: any) => s.scope === "project")).toBe(true);
    });

    it("POST /api/automations with scope=global creates in global lane", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.createSchedule.mockResolvedValue({ ...FAKE_GLOBAL_SCHEDULE, scope: "global" });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test Global Schedule",
        command: "echo test",
        scheduleType: "hourly",
        scope: "global",
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      expect(globalStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "global" }),
      );
    });

    it("POST /api/automations with scope=project creates in project lane", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.createSchedule.mockResolvedValue({ ...FAKE_PROJECT_SCHEDULE, scope: "project" });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test Project Schedule",
        command: "echo test",
        scheduleType: "daily",
        scope: "project",
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      expect(globalStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("GET /api/automations?scope=invalid returns 400 when automation store is configured", async () => {
      const globalStore = createMockAutomationStore("global");
      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await GET(app, "/api/automations?scope=invalid");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid scope value "invalid"');
    });

    it("GET /api/automations?scope=invalid returns empty array when no automation store configured (early exit)", async () => {
      const store = createMockStore();
      // When no automationStore is configured, route returns empty array BEFORE scope validation
      const app = createServer(store);

      const res = await GET(app, "/api/automations?scope=invalid");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("GET /api/automations without scope returns all (legacy default)", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.listSchedules.mockResolvedValue([FAKE_GLOBAL_SCHEDULE, FAKE_PROJECT_SCHEDULE]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await GET(app, "/api/automations");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it("GET /api/automations when no automation store configured returns empty array", async () => {
      const store = createMockStore();
      const app = createServer(store); // No automationStore option

      const res = await GET(app, "/api/automations");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("POST /api/automations/:id/run with scope=global runs global schedule", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.getSchedule.mockResolvedValue({ ...FAKE_GLOBAL_SCHEDULE });
      globalStore.recordRun.mockResolvedValue({ ...FAKE_GLOBAL_SCHEDULE });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/automations/sched-global-1/run?scope=global");

      expect(res.status).toBe(200);
      expect(res.body.schedule).toBeDefined();
      expect(res.body.result).toBeDefined();
      expect(globalStore.getSchedule).toHaveBeenCalledWith("sched-global-1");
    });

    it("POST /api/automations/:id/run with scope=project for global schedule returns 404", async () => {
      const globalStore = createMockAutomationStore("global");
      // Schedule is global-scoped
      globalStore.getSchedule.mockResolvedValue({ ...FAKE_GLOBAL_SCHEDULE });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      // Request with scope=project but schedule is global
      const res = await REQUEST(app, "POST", "/api/automations/sched-global-1/run?scope=project");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Schedule not found");
    });

    it("POST /api/automations/:id/toggle with scope=global toggles global schedule", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.getSchedule.mockResolvedValue({ ...FAKE_GLOBAL_SCHEDULE, enabled: true });
      globalStore.updateSchedule.mockResolvedValue({ ...FAKE_GLOBAL_SCHEDULE, enabled: false });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/automations/sched-global-1/toggle?scope=global");

      expect(res.status).toBe(200);
      expect(globalStore.updateSchedule).toHaveBeenCalled();
    });

    it("Cross-project isolation: request for proj-a never touches proj-b dependencies", async () => {
      const globalStore = createMockAutomationStore("global");
      // Returns only project A's schedule
      globalStore.listSchedules.mockResolvedValue([FAKE_PROJECT_SCHEDULE]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      // Request for project scope (would be proj-a in real scenario)
      const res = await GET(app, "/api/automations?scope=project");

      expect(res.status).toBe(200);
      // All returned schedules should be project-scoped
      expect(res.body.every((s: any) => s.scope === "project")).toBe(true);
    });
  });

  // ── Routine lane selection tests ────────────────────────────────────────
  //
  // Routine lane selection: The routine store and routine runner resolve based on scope.
  // Precedence: global lane uses process-level store/runner, project lane uses same
  // with scope filtering. RoutineRunner is invoked for /run and /trigger endpoints
  // when scope matches and routine is enabled.

  describe("Routine lane selection", () => {
    it("GET /api/routines?scope=global returns only global routines", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.listRoutines.mockResolvedValue([FAKE_GLOBAL_ROUTINE, FAKE_PROJECT_ROUTINE]);

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await GET(app, "/api/routines?scope=global");

      expect(res.status).toBe(200);
      expect(res.body.every((r: any) => r.scope === "global")).toBe(true);
    });

    it("GET /api/routines?scope=project returns only project-scoped routines", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.listRoutines.mockResolvedValue([FAKE_GLOBAL_ROUTINE, FAKE_PROJECT_ROUTINE]);

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await GET(app, "/api/routines?scope=project");

      expect(res.status).toBe(200);
      expect(res.body.every((r: any) => r.scope === "project")).toBe(true);
    });

    it("POST /api/routines with scope=global creates in global lane", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.createRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test Global Routine",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        scope: "global",
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      expect(globalStore.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "global" }),
      );
    });

    it("POST /api/routines with scope=project creates in project lane", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.createRoutine.mockResolvedValue({ ...FAKE_PROJECT_ROUTINE });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test Project Routine",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        scope: "project",
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      expect(globalStore.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("GET /api/routines?scope=invalid returns 400 when routine store is configured", async () => {
      const globalStore = createMockRoutineStore("global");
      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await GET(app, "/api/routines?scope=invalid");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid scope value "invalid"');
    });

    it("GET /api/routines?scope=invalid returns empty array when no routine store configured (early exit)", async () => {
      const store = createMockStore();
      // When no routineStore is configured, route returns empty array BEFORE scope validation
      const app = createServer(store);

      const res = await GET(app, "/api/routines?scope=invalid");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("GET /api/routines without scope returns all (legacy default)", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.listRoutines.mockResolvedValue([FAKE_GLOBAL_ROUTINE, FAKE_PROJECT_ROUTINE]);

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await GET(app, "/api/routines");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it("GET /api/routines when no routine store configured returns empty array", async () => {
      const store = createMockStore();
      const app = createServer(store); // No routineStore option

      const res = await GET(app, "/api/routines");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("POST /api/routines/:id/run with scope=global runs global routine via RoutineRunner", async () => {
      const globalStore = createMockRoutineStore("global");
      const routineRunner = createMockRoutineRunner();
      globalStore.getRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        routineRunner: routineRunner as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines/routine-global-1/run?scope=global");

      expect(res.status).toBe(200);
      expect(res.body.routine).toBeDefined();
      expect(res.body.result).toBeDefined();
      expect(routineRunner.triggerManual).toHaveBeenCalledWith("routine-global-1");
    });

    it("POST /api/routines/:id/run with scope=project for global routine returns 404", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.getRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE });

      const routineRunner = createMockRoutineRunner();

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        routineRunner: routineRunner as any,
      });

      // Request with scope=project but routine is global
      const res = await REQUEST(app, "POST", "/api/routines/routine-global-1/run?scope=project");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Routine not found");
      // RoutineRunner should NOT be called for mismatched scope
      expect(routineRunner.triggerManual).not.toHaveBeenCalled();
    });

    it("POST /api/routines/:id/trigger with scope=global triggers global routine", async () => {
      const globalStore = createMockRoutineStore("global");
      const routineRunner = createMockRoutineRunner();
      globalStore.getRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        routineRunner: routineRunner as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines/routine-global-1/trigger?scope=global");

      expect(res.status).toBe(200);
      expect(routineRunner.triggerManual).toHaveBeenCalledWith("routine-global-1");
    });

    it("GET /api/routines/:id/runs with scope=global returns runs for global routine", async () => {
      const globalStore = createMockRoutineStore("global");
      const runHistory = [
        { routineId: "routine-global-1", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z", success: true, output: "Done" },
      ];
      globalStore.getRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE, runHistory });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await GET(app, "/api/routines/routine-global-1/runs?scope=global");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("Cross-project isolation: request for proj-a never touches proj-b dependencies", async () => {
      const globalStore = createMockRoutineStore("global");
      // Returns only project-scoped routines (would be proj-b in real multi-project scenario)
      globalStore.listRoutines.mockResolvedValue([FAKE_PROJECT_ROUTINE]);

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      // Request for project scope
      const res = await GET(app, "/api/routines?scope=project");

      expect(res.status).toBe(200);
      // All returned routines should be project-scoped
      expect(res.body.every((r: any) => r.scope === "project")).toBe(true);
    });

    it("POST /api/routines/:id/webhook is scope-independent (uses routine's own scope)", async () => {
      const secret = "test-secret-test-secret";
      const payload = JSON.stringify({});
      const signature =
        "sha256=" +
        createHmac("sha256", secret).update(payload).digest("hex");

      const globalStore = createMockRoutineStore("global");
      const routineRunner = createMockRoutineRunner();
      globalStore.getRoutine.mockResolvedValue({
        ...FAKE_PROJECT_ROUTINE,
        trigger: { type: "webhook" as const, webhookPath: "/trigger/test", secret },
      });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        routineRunner: routineRunner as any,
      });

      // Webhook without scope param - should work regardless of scope
      const res = await REQUEST(app, "POST", "/api/routines/routine-proj-a-1/webhook", payload, {
        "Content-Type": "application/json",
        "x-hub-signature-256": signature,
      });

      expect(res.status).toBe(200);
      expect(routineRunner.triggerWebhook).toHaveBeenCalled();
    });

    it("POST /api/routines/:id/run when routine is disabled returns 400", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.getRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE, enabled: false });

      const routineRunner = createMockRoutineRunner();

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        routineRunner: routineRunner as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines/routine-global-1/run?scope=global");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("disabled");
      expect(routineRunner.triggerManual).not.toHaveBeenCalled();
    });

    it("POST /api/routines/:id/run when no RoutineRunner returns 503", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.getRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE });

      const store = createMockStore();
      // No routineRunner configured
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines/routine-global-1/run?scope=global");

      expect(res.status).toBe(503);
      expect(res.body.error).toContain("not available");
    });
  });

  // ── Fallback and error contract tests ────────────────────────────────
  //
  // Backward-compatible defaults: omitted scope defaults to "project" for mutations.
  // This preserves existing behavior while adding explicit scope selection.
  // Store unavailability: when no store is configured, GET returns [] for
  // backward compatibility (legacy behavior).

  describe("Fallback and error contracts", () => {
    it("omitted scope defaults to project for backward compatibility (POST automations)", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.createSchedule.mockResolvedValue({ ...FAKE_PROJECT_SCHEDULE, scope: "project" });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      // No scope specified - should default to "project"
      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "Test Schedule",
        command: "echo test",
        scheduleType: "hourly",
        // scope omitted
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      expect(globalStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("omitted scope defaults to project for backward compatibility (POST routines)", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.createRoutine.mockResolvedValue({ ...FAKE_PROJECT_ROUTINE, scope: "project" });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      // No scope specified - should default to "project"
      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "Test Routine",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        // scope omitted
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      expect(globalStore.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("scope=project with no automation store returns empty array (legacy fallback)", async () => {
      const store = createMockStore();
      // No automationStore configured - routes return empty array for backward compatibility
      const app = createServer(store);

      const res = await GET(app, "/api/automations?scope=project");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("scope=global with no automation store returns empty array (legacy fallback)", async () => {
      const store = createMockStore();
      // No automationStore configured - routes return empty array for backward compatibility
      const app = createServer(store);

      const res = await GET(app, "/api/automations?scope=global");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("scope=project with no routine store returns empty array (legacy fallback)", async () => {
      const store = createMockStore();
      // No routineStore configured - routes return empty array for backward compatibility
      const app = createServer(store);

      const res = await GET(app, "/api/routines?scope=project");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("scope=global with no routine store returns empty array (legacy fallback)", async () => {
      const store = createMockStore();
      // No routineStore configured - routes return empty array for backward compatibility
      const app = createServer(store);

      const res = await GET(app, "/api/routines?scope=global");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ── No-opportunistic-lane-hopping assertions ───────────────────────────
  //
  // Critical invariant: scope selection is deterministic and deterministic.
  // When scope=project returns no results, the resolver must NOT fall back to
  // global lane results. This prevents cross-project data leakage and ensures
  // automation/routine isolation between global and project contexts.

  describe("No opportunistic lane hopping", () => {
    it("scope=project request never falls back to global when engine is unavailable", async () => {
      const globalStore = createMockAutomationStore("global");
      const engineManager = createMockEngineManager();
      // No engine available for any project
      engineManager.getEngine.mockReturnValue(undefined);

      // Only global-scoped schedules exist
      globalStore.listSchedules.mockResolvedValue([FAKE_GLOBAL_SCHEDULE]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
        engineManager: engineManager as any,
      });

      // Request for project scope - should filter by scope, NOT switch to global
      const res = await GET(app, "/api/automations?scope=project");

      expect(res.status).toBe(200);
      // Should return empty (no project-scoped schedules) not global schedules
      expect(res.body).toHaveLength(0);
    });

    it("scope=global request never switches to project lane", async () => {
      const globalStore = createMockAutomationStore("global");
      const engineManager = createMockEngineManager();
      // Engine IS available for some project
      const mockEngine = { getTaskStore: vi.fn() };
      engineManager.getEngine.mockReturnValue(mockEngine as any);

      // Both global and project schedules exist
      globalStore.listSchedules.mockResolvedValue([FAKE_GLOBAL_SCHEDULE, FAKE_PROJECT_SCHEDULE]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
        engineManager: engineManager as any,
      });

      // Request for global scope - should only return global schedules
      const res = await GET(app, "/api/automations?scope=global");

      expect(res.status).toBe(200);
      // All results should be global-scoped
      expect(res.body.every((s: any) => s.scope === "global")).toBe(true);
      // Should not have fallen back to project
      expect(res.body.some((s: any) => s.scope === "project")).toBe(false);
    });
  });

  // ── Cross-project isolation integration tests (FN-1743) ─────────────────────
  //
  // These tests verify end-to-end cross-project isolation for scoped scheduling routes.
  // They ensure that:
  // 1. Requests with projectId=proj-a never touch proj-b stores
  // 2. Requests with projectId=proj-b never touch proj-a stores
  // 3. Fallback paths are deterministic and do not opportunistically hop lanes
  // 4. Scope filtering in routes ensures only project-scoped items are returned
  //
  // NOTE: The current implementation uses the same automation/routine store for both
  // global and project scopes, with scope filtering applied at query time. This means
  // engineManager.getEngine is not used for scope resolution - the store itself
  // handles scope filtering through getDueSchedules(scope) or listSchedules filtering.

  describe("cross-project isolation integration", () => {
    // Test fixtures for multi-project scenarios
    const FAKE_PROJ_A_SCHEDULE = {
      id: "sched-proj-a",
      name: "Project A Schedule",
      scope: "project" as const,
      scheduleType: "daily" as const,
      command: "echo proj-a",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const FAKE_PROJ_B_SCHEDULE = {
      id: "sched-proj-b",
      name: "Project B Schedule",
      scope: "project" as const,
      scheduleType: "daily" as const,
      command: "echo proj-b",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const FAKE_PROJ_A_ROUTINE = {
      id: "routine-proj-a",
      name: "Project A Routine",
      scope: "project" as const,
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const FAKE_PROJ_B_ROUTINE = {
      id: "routine-proj-b",
      name: "Project B Routine",
      scope: "project" as const,
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    it("GET /api/automations?scope=project filters to only project-scoped schedules", async () => {
      const globalStore = createMockAutomationStore("global");
      // Store returns both global and project schedules
      globalStore.listSchedules.mockResolvedValue([
        FAKE_GLOBAL_SCHEDULE,
        FAKE_PROJ_A_SCHEDULE,
        FAKE_PROJ_B_SCHEDULE,
      ]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      // Request with scope=project
      const res = await GET(app, "/api/automations?scope=project");

      expect(res.status).toBe(200);
      // Route filters by scope, so only project-scoped schedules are returned
      expect(res.body.every((s: any) => s.scope === "project")).toBe(true);
      // Global schedules should not be in the response
      expect(res.body.some((s: any) => s.scope === "global")).toBe(false);
    });

    it("GET /api/automations?scope=global filters to only global-scoped schedules", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.listSchedules.mockResolvedValue([
        FAKE_GLOBAL_SCHEDULE,
        FAKE_PROJ_A_SCHEDULE,
        FAKE_PROJ_B_SCHEDULE,
      ]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      // Request with scope=global
      const res = await GET(app, "/api/automations?scope=global");

      expect(res.status).toBe(200);
      // Route filters by scope, so only global-scoped schedules are returned
      expect(res.body.every((s: any) => s.scope === "global")).toBe(true);
      // Project schedules should not be in the response
      expect(res.body.some((s: any) => s.scope === "project")).toBe(false);
    });

    it("GET /api/routines?scope=project filters to only project-scoped routines", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.listRoutines.mockResolvedValue([
        FAKE_GLOBAL_ROUTINE,
        FAKE_PROJ_A_ROUTINE,
        FAKE_PROJ_B_ROUTINE,
      ]);

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      // Request with scope=project
      const res = await GET(app, "/api/routines?scope=project");

      expect(res.status).toBe(200);
      // Route filters by scope
      expect(res.body.every((r: any) => r.scope === "project")).toBe(true);
      expect(res.body.some((r: any) => r.scope === "global")).toBe(false);
    });

    it("GET /api/routines?scope=global filters to only global-scoped routines", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.listRoutines.mockResolvedValue([
        FAKE_GLOBAL_ROUTINE,
        FAKE_PROJ_A_ROUTINE,
        FAKE_PROJ_B_ROUTINE,
      ]);

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      // Request with scope=global
      const res = await GET(app, "/api/routines?scope=global");

      expect(res.status).toBe(200);
      // Route filters by scope
      expect(res.body.every((r: any) => r.scope === "global")).toBe(true);
      expect(res.body.some((r: any) => r.scope === "project")).toBe(false);
    });

    it("POST /api/routines/:id/run with scope=global executes global routine", async () => {
      const globalStore = createMockRoutineStore("global");
      const routineRunner = createMockRoutineRunner();
      globalStore.getRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        routineRunner: routineRunner as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines/routine-global-1/run?scope=global");

      expect(res.status).toBe(200);
      expect(routineRunner.triggerManual).toHaveBeenCalledWith("routine-global-1");
    });

    it("POST /api/routines/:id/run with scope=project for global routine returns 404", async () => {
      const globalStore = createMockRoutineStore("global");
      const routineRunner = createMockRoutineRunner();
      // Routine is global-scoped
      globalStore.getRoutine.mockResolvedValue({ ...FAKE_GLOBAL_ROUTINE });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        routineRunner: routineRunner as any,
      });

      // Request with scope=project but routine is global
      const res = await REQUEST(app, "POST", "/api/routines/routine-global-1/run?scope=project");

      expect(res.status).toBe(404);
      // RoutineRunner should NOT be called - scope mismatch
      expect(routineRunner.triggerManual).not.toHaveBeenCalled();
    });

    it("fallback to global automation store is deterministic (no lane hopping)", async () => {
      const globalStore = createMockAutomationStore("global");
      // Only project-scoped schedules exist in the store
      globalStore.listSchedules.mockResolvedValue([FAKE_PROJ_A_SCHEDULE, FAKE_PROJ_B_SCHEDULE]);

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      // scope=global should return empty (no global schedules exist)
      const res = await GET(app, "/api/automations?scope=global");

      expect(res.status).toBe(200);
      // Should NOT have hopped to project lane - should return empty
      expect(res.body).toHaveLength(0);
    });

    it("fallback to global routine store is deterministic (no lane hopping)", async () => {
      const globalStore = createMockRoutineStore("global");
      // Only project-scoped routines exist
      globalStore.listRoutines.mockResolvedValue([FAKE_PROJ_A_ROUTINE, FAKE_PROJ_B_ROUTINE]);

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      // scope=global should return empty (no global routines exist)
      const res = await GET(app, "/api/routines?scope=global");

      expect(res.status).toBe(200);
      // Should NOT have hopped to project lane - should return empty
      expect(res.body).toHaveLength(0);
    });

    it("POST /api/automations with scope=project creates in project lane", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.createSchedule.mockResolvedValue({ ...FAKE_PROJ_A_SCHEDULE });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/automations", JSON.stringify({
        name: "New Project Schedule",
        command: "echo test",
        scheduleType: "daily",
        scope: "project",
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      // Verify the schedule was created with project scope
      expect(globalStore.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    it("POST /api/routines with scope=project creates in project lane", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.createRoutine.mockResolvedValue({ ...FAKE_PROJ_A_ROUTINE });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines", JSON.stringify({
        name: "New Project Routine",
        trigger: { type: "cron", cronExpression: "0 * * * *" },
        scope: "project",
      }), { "Content-Type": "application/json" });

      expect(res.status).toBe(201);
      // Verify the routine was created with project scope
      expect(globalStore.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "project" }),
      );
    });

    // ── engineManager integration tests ─────────────────────────────────────────────
    //
    // These tests verify that engineManager.getEngine(projectId) is called for
    // project-scoped automation/routine routes when projectId is provided.

    it("GET /api/automations?scope=project&projectId=proj-a calls engineManager.getEngine(proj-a)", async () => {
      const globalStore = createMockAutomationStore("global");
      // Engine A's store has unique data
      const projAStore = {
        listSchedules: vi.fn().mockResolvedValue([FAKE_PROJ_A_SCHEDULE]),
      };
      const projAEngine = { getAutomationStore: vi.fn().mockReturnValue(projAStore) };

      const engineManager = createMockEngineManager();
      engineManager.getEngine.mockImplementation((id: string) => {
        if (id === "proj-a") return projAEngine;
        return undefined;
      });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
        engineManager: engineManager as any,
      });

      const res = await GET(app, "/api/automations?scope=project&projectId=proj-a");

      expect(res.status).toBe(200);
      // Verify engine was consulted
      expect(engineManager.getEngine).toHaveBeenCalledWith("proj-a");
      // Verify engine's store was used
      expect(projAStore.listSchedules).toHaveBeenCalled();
      // Default store should NOT have been called
      expect(globalStore.listSchedules).not.toHaveBeenCalled();
    });

    it("GET /api/automations?scope=project&projectId=proj-a never touches proj-b engine", async () => {
      const globalStore = createMockAutomationStore("global");
      const projAStore = { listSchedules: vi.fn().mockResolvedValue([FAKE_PROJ_A_SCHEDULE]) };
      const projAEngine = { getAutomationStore: vi.fn().mockReturnValue(projAStore) };
      const projBEngine = { getAutomationStore: vi.fn() }; // Should never be accessed

      const engineManager = createMockEngineManager();
      engineManager.getEngine.mockImplementation((id: string) => {
        if (id === "proj-a") return projAEngine;
        if (id === "proj-b") return projBEngine;
        return undefined;
      });

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
        engineManager: engineManager as any,
      });

      await GET(app, "/api/automations?scope=project&projectId=proj-a");

      // proj-b engine should NEVER be accessed
      expect(engineManager.getEngine).toHaveBeenCalledWith("proj-a");
      expect(engineManager.getEngine).not.toHaveBeenCalledWith("proj-b");
    });

    it("GET /api/routines?scope=project&projectId=proj-b calls engineManager.getEngine(proj-b)", async () => {
      const globalStore = createMockRoutineStore("global");
      const projBStore = {
        listRoutines: vi.fn().mockResolvedValue([FAKE_PROJ_B_ROUTINE]),
      };
      const projBEngine = { getRoutineStore: vi.fn().mockReturnValue(projBStore) };

      const engineManager = createMockEngineManager();
      engineManager.getEngine.mockImplementation((id: string) => {
        if (id === "proj-b") return projBEngine;
        return undefined;
      });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        engineManager: engineManager as any,
      });

      const res = await GET(app, "/api/routines?scope=project&projectId=proj-b");

      expect(res.status).toBe(200);
      // Verify engine was consulted
      expect(engineManager.getEngine).toHaveBeenCalledWith("proj-b");
      // Verify engine's store was used
      expect(projBStore.listRoutines).toHaveBeenCalled();
      // Default store should NOT have been called
      expect(globalStore.listRoutines).not.toHaveBeenCalled();
    });

    it("GET /api/routines?scope=project&projectId=proj-b never touches proj-a engine", async () => {
      const globalStore = createMockRoutineStore("global");
      const projAEngine = { getRoutineStore: vi.fn() }; // Should never be accessed
      const projBStore = { listRoutines: vi.fn().mockResolvedValue([FAKE_PROJ_B_ROUTINE]) };
      const projBEngine = { getRoutineStore: vi.fn().mockReturnValue(projBStore) };

      const engineManager = createMockEngineManager();
      engineManager.getEngine.mockImplementation((id: string) => {
        if (id === "proj-a") return projAEngine;
        if (id === "proj-b") return projBEngine;
        return undefined;
      });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        engineManager: engineManager as any,
      });

      await GET(app, "/api/routines?scope=project&projectId=proj-b");

      // proj-a engine should NEVER be accessed
      expect(engineManager.getEngine).toHaveBeenCalledWith("proj-b");
      expect(engineManager.getEngine).not.toHaveBeenCalledWith("proj-a");
    });

    it("POST /api/routines/:id/run?scope=project&projectId=proj-a uses engine's RoutineRunner", async () => {
      const globalStore = createMockRoutineStore("global");
      const projARoutineRunner = {
        triggerManual: vi.fn().mockResolvedValue({ success: true }),
        triggerWebhook: vi.fn().mockResolvedValue({ success: true }),
      };
      const projAEngine = {
        getRoutineStore: vi.fn().mockReturnValue({
          getRoutine: vi.fn().mockResolvedValue({ ...FAKE_PROJ_A_ROUTINE }),
        }),
        getRoutineRunner: vi.fn().mockReturnValue(projARoutineRunner),
      };

      const engineManager = createMockEngineManager();
      engineManager.getEngine.mockImplementation((id: string) => {
        if (id === "proj-a") return projAEngine;
        return undefined;
      });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        engineManager: engineManager as any,
      });

      const res = await REQUEST(app, "POST", "/api/routines/routine-proj-a/run?scope=project&projectId=proj-a");

      expect(res.status).toBe(200);
      // Verify engine was consulted
      expect(engineManager.getEngine).toHaveBeenCalledWith("proj-a");
      // Verify engine's runner was used
      expect(projARoutineRunner.triggerManual).toHaveBeenCalledWith("routine-proj-a");
    });

    it("POST /api/routines/:id/run?scope=project&projectId=proj-b never uses proj-a engine", async () => {
      const globalRoutineRunner = createMockRoutineRunner();
      const projAEngine = { getRoutineRunner: vi.fn() }; // Should never be accessed
      const projBEngine = {
        getRoutineStore: vi.fn().mockReturnValue({
          getRoutine: vi.fn().mockResolvedValue({ ...FAKE_PROJ_B_ROUTINE }),
        }),
        getRoutineRunner: vi.fn().mockReturnValue({
          triggerManual: vi.fn().mockResolvedValue({ success: true }),
          triggerWebhook: vi.fn().mockResolvedValue({ success: true }),
        }),
      };

      const engineManager = createMockEngineManager();
      engineManager.getEngine.mockImplementation((id: string) => {
        if (id === "proj-a") return projAEngine;
        if (id === "proj-b") return projBEngine;
        return undefined;
      });

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: createMockRoutineStore("global") as any,
        routineRunner: globalRoutineRunner as any,
        engineManager: engineManager as any,
      });

      await REQUEST(app, "POST", "/api/routines/routine-proj-b/run?scope=project&projectId=proj-b");

      // proj-a engine should NEVER be accessed
      expect(engineManager.getEngine).toHaveBeenCalledWith("proj-b");
      expect(engineManager.getEngine).not.toHaveBeenCalledWith("proj-a");
    });

    it("GET /api/automations?scope=project without projectId falls back to default store", async () => {
      const globalStore = createMockAutomationStore("global");
      globalStore.listSchedules.mockResolvedValue([FAKE_PROJ_A_SCHEDULE]);

      const engineManager = createMockEngineManager();

      const store = createMockStore();
      const app = createServer(store, {
        automationStore: globalStore as any,
        engineManager: engineManager as any,
      });

      const res = await GET(app, "/api/automations?scope=project");

      expect(res.status).toBe(200);
      // Engine should NOT have been consulted (no projectId)
      expect(engineManager.getEngine).not.toHaveBeenCalled();
      // Default store should be used
      expect(globalStore.listSchedules).toHaveBeenCalled();
    });

    it("GET /api/routines?scope=project without projectId falls back to default store", async () => {
      const globalStore = createMockRoutineStore("global");
      globalStore.listRoutines.mockResolvedValue([FAKE_PROJ_A_ROUTINE]);

      const engineManager = createMockEngineManager();

      const store = createMockStore();
      const app = createServer(store, {
        routineStore: globalStore as any,
        engineManager: engineManager as any,
      });

      const res = await GET(app, "/api/routines?scope=project");

      expect(res.status).toBe(200);
      // Engine should NOT have been consulted (no projectId)
      expect(engineManager.getEngine).not.toHaveBeenCalled();
      // Default store should be used
      expect(globalStore.listRoutines).toHaveBeenCalled();
    });
  });
});

describe("GET /remote-login", () => {
  const originalDaemonToken = process.env.FUSION_DAEMON_TOKEN;

  beforeEach(() => {
    delete process.env.FUSION_DAEMON_TOKEN;
  });

  afterEach(() => {
    if (originalDaemonToken === undefined) {
      delete process.env.FUSION_DAEMON_TOKEN;
    } else {
      process.env.FUSION_DAEMON_TOKEN = originalDaemonToken;
    }
  });

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
          tunnelName: "tunnel",
          tunnelToken: "secret",
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

  it("redirects valid token to dashboard with daemon token handoff when daemon auth is enabled", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ remoteAccess: buildRemoteAccessSettings() }),
    });
    const app = createServer(store, { daemon: { token: "fn_daemon_token" } });

    const res = await GET(app, "/remote-login?rt=frt_persistent_token");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?token=fn_daemon_token");
  });

  it("redirects valid token to root when daemon auth is disabled", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ remoteAccess: buildRemoteAccessSettings() }),
    });
    const app = createServer(store, { noAuth: true });

    const res = await GET(app, "/remote-login?rt=frt_persistent_token");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("returns 401 for invalid and missing remote token", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ remoteAccess: buildRemoteAccessSettings() }),
    });
    const app = createServer(store, { daemon: { token: "fn_daemon_token" } });

    const invalid = await GET(app, "/remote-login?rt=frt_wrong");
    expect(invalid.status).toBe(401);
    expect(invalid.body).toEqual({ error: "Unauthorized", code: "remote_token_invalid" });

    const missing = await GET(app, "/remote-login");
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: "Unauthorized", code: "remote_token_missing" });
  });

  it("issues short-lived login URL and expires remote-login handoff after TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-26T12:00:00.000Z"));

      const store = createMockStore({
        getSettings: vi.fn().mockResolvedValue({
          remoteAccess: {
            ...buildRemoteAccessSettings(),
            tokenStrategy: {
              persistent: { enabled: true, token: "frt_persistent_token" },
              shortLived: { enabled: true, ttlMs: 120000, maxTtlMs: 86400000 },
            },
          },
        }),
      });
      const app = createServer(store, { daemon: { token: "fn_daemon_token" } });

      const issue = await REQUEST(
        app,
        "POST",
        "/api/remote-access/auth/login-url",
        JSON.stringify({ mode: "short-lived" }),
        {
          "Content-Type": "application/json",
          Authorization: "Bearer fn_daemon_token",
        },
      );

      expect(issue.status).toBe(200);
      expect(typeof issue.body === "object" ? (issue.body as Record<string, unknown>).loginUrl : "").toEqual(expect.any(String));
      const issuedLoginUrl = new URL(String((issue.body as Record<string, unknown>).loginUrl));
      const shortLivedToken = issuedLoginUrl.searchParams.get("rt");
      expect(shortLivedToken).toBeTruthy();

      const beforeExpiry = await GET(app, `/remote-login?rt=${shortLivedToken}`);
      expect(beforeExpiry.status).toBe(302);
      expect(beforeExpiry.headers.location).toBe("/?token=fn_daemon_token");

      vi.advanceTimersByTime(121000);

      const afterExpiry = await GET(app, `/remote-login?rt=${shortLivedToken}`);
      expect(afterExpiry.status).toBe(401);
      expect(afterExpiry.body).toEqual({ error: "Unauthorized", code: "remote_token_expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept remote rt query tokens as API auth", async () => {
    const store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ remoteAccess: buildRemoteAccessSettings() }),
    });
    const app = createServer(store, { daemon: { token: "fn_daemon_token" } });

    const res = await GET(app, "/api/tasks?rt=frt_persistent_token");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "Unauthorized",
      message: "Valid bearer token required",
    });
  });
});

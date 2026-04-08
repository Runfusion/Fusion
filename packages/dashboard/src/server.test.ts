// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import express from "express";
import { createServer, setupTerminalWebSocket } from "./server.js";
import type { TaskStore } from "@fusion/core";
import { get as performGet, request as performRequest } from "./test-request.js";

// Mock terminal-service before any imports that use it
vi.mock("./terminal-service.js", () => {
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
const { __mockTerminalService: mockTerminalService } = await import("./terminal-service.js") as any;

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

      for (let i = 0; i < 30; i++) {
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

      for (let i = 0; i < 30; i++) {
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
});

describe("Terminal WebSocket heartbeat", () => {
  let app: ReturnType<typeof express>;
  let server: http.Server;

  beforeEach(() => {
    app = express();
    server = http.createServer(app);
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
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
  function setupAndConnect(ws: any, req: any): void {
    const wss = setupTerminalWebSocket(app, server);

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
      cwd: "/project",
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
      cwd: "/project",
      lastActivityAt: new Date(),
    });

    setupAndConnect(ws, req);

    // First ping interval: mark as not alive (isAlive = false)
    vi.advanceTimersByTime(30000);
    expect(ws.send).toHaveBeenCalled();

    // Don't send pong — missed pong #1
    vi.advanceTimersByTime(30000);
    expect(ws.terminate).not.toHaveBeenCalled();

    // Don't send pong — missed pong #2: should terminate
    vi.advanceTimersByTime(30000);
    expect(ws.terminate).toHaveBeenCalled();
  });

  it("resets missed pong counter on successful pong", () => {
    const ws = createMockWs();
    const req = createMockReq("session-3");

    mockTerminalService.getSession.mockReturnValue({
      id: "session-3",
      shell: "/bin/bash",
      cwd: "/project",
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

  it("logs warning for stale session reconnect", () => {
    const ws = createMockWs();
    const req = createMockReq("stale-session");

    // Session last active 10 minutes ago (past the 5-minute threshold)
    const tenMinutesAgo = new Date(Date.now() - 600_000);
    mockTerminalService.getSession.mockReturnValue({
      id: "stale-session",
      shell: "/bin/bash",
      cwd: "/project",
      lastActivityAt: tenMinutesAgo,
    });

    setupAndConnect(ws, req);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("stale-session"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("PTY may be stale"),
    );
  });

  it("does not warn for fresh session reconnect", () => {
    const ws = createMockWs();
    const req = createMockReq("fresh-session");

    // Session last active 1 minute ago (under the 5-minute threshold)
    mockTerminalService.getSession.mockReturnValue({
      id: "fresh-session",
      shell: "/bin/bash",
      cwd: "/project",
      lastActivityAt: new Date(Date.now() - 60_000),
    });

    setupAndConnect(ws, req);

    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("PTY may be stale"),
    );
  });
});

// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer } from "./server.js";
import type { TaskStore } from "@fusion/core";
import { get as performGet, request as performRequest } from "./test-request.js";

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

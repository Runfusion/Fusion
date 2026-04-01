import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import { createServer } from "./server.js";
import type { TaskStore } from "@fusion/core";

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
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

/** Helper: send GET and return { status, body, headers } */
async function GET(app: express.Express, path: string): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      http.get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode!, body: data, headers: res.headers });
          }
        });
      }).on("error", (err) => { server.close(); reject(err); });
    });
  });
}

async function REQUEST(
  app: express.Express,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const req = http.request(
        { hostname: "127.0.0.1", port: addr.port, path, method, headers },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers });
            } catch {
              resolve({ status: res.statusCode!, body: data, headers: res.headers });
            }
          });
        },
      );
      req.on("error", (err) => { server.close(); reject(err); });
      if (body) req.write(body);
      req.end();
    });
  });
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
});

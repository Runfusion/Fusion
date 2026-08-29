// @vitest-environment node

import express from "express";
import { describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerProjectRoutes } from "../register-project-routes.js";

function appFor(project: { id: string; path: string } | null) {
  const router = express.Router();
  registerProjectRoutes({
    router,
    options: { centralCore: { getProject: vi.fn(async () => project), isInitialized: () => true } },
    runtimeLogger: { child: () => ({ warn: vi.fn() }) },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  const app = express(); app.use("/api", router);
  app.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 500).json({ error: error.message }));
  return app;
}

describe("codebase metrics route", () => {
  it("returns separately named source and disk metrics", async () => {
    const app = appFor({ id: "p1", path: process.cwd() });
    const response = await request(app, "GET", "/api/projects/p1/codebase-metrics");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tokenEstimate: expect.any(Number), sourceFileCount: expect.any(Number), sourceByteCount: expect.any(Number), diskBytes: expect.any(Number), diskFileCount: expect.any(Number), method: expect.any(String), truncated: expect.any(Boolean) });
  });

  it("returns 404 for a missing project", async () => {
    const response = await request(appFor(null), "GET", "/api/projects/missing/codebase-metrics");
    expect(response.status).toBe(404);
  });
});

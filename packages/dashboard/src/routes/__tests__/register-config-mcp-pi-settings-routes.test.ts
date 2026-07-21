// @vitest-environment node

import express from "express";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api-error.js";
import { request } from "../../test-request.js";
import { registerConfigMcpPiSettingsRoutes } from "../register-config-mcp-pi-settings-routes.js";
import type { ApiRoutesContext } from "../types.js";

function createApp(settings = { maxConcurrent: 6, maxTriageConcurrent: 3, maxWorktrees: 2 }) {
  const app = express();
  app.use(express.json());
  const store = {
    getRootDir: () => "/workspace",
    getSettingsFast: async () => settings,
  };
  const context = {
    router: app,
    options: { maxConcurrent: 9 },
    getProjectContext: async () => ({ store, engine: undefined, projectId: undefined }),
    rethrowAsApiError(error: unknown): never {
      throw error;
    },
  } as unknown as ApiRoutesContext;
  registerConfigMcpPiSettingsRoutes(context);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, "Internal server error");
    res.status(apiError.statusCode).json({ error: apiError.message });
  });
  return app;
}

describe("registerConfigMcpPiSettingsRoutes", () => {
  it("returns stored scheduler concurrency values", async () => {
    const response = await request(createApp(), "GET", "/config");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ maxConcurrent: 6, maxTriageConcurrent: 3, maxWorktrees: 2, rootDir: "/workspace" });
  });

  it("uses option and fixed defaults for missing scheduler settings", async () => {
    const response = await request(createApp({}), "GET", "/config");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ maxConcurrent: 9, maxTriageConcurrent: 2, maxWorktrees: 4, rootDir: "/workspace" });
  });

  it("rejects malformed MCP validation bodies", async () => {
    const response = await request(createApp(), "POST", "/mcp/validate", JSON.stringify({ timeoutMs: 1000 }), { "content-type": "application/json" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Provide either name or server" });
  });

  it("rejects pi-settings updates with no fields", async () => {
    const response = await request(createApp(), "PUT", "/pi-settings", JSON.stringify({}), { "content-type": "application/json" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "At least one setting field must be provided (packages, extensions, skills, prompts, or themes)" });
  });
});

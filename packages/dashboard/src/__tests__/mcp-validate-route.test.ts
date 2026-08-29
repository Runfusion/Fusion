// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";

const engineMocks = vi.hoisted(() => ({
  validateMcpServer: vi.fn(),
  resolveMcpServersForRuntime: vi.fn(),
  resolveMcpServersForStore: vi.fn(),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    createFnAgent: vi.fn(),
    getExemptToolNames: vi.fn(() => []),
    promptWithFallback: vi.fn(),
    reloadExemptTools: vi.fn(),
    resolveIntegrationBranch: vi.fn(() => "main"),
    resolveMcpServersForRuntime: engineMocks.resolveMcpServersForRuntime,
    resolveMcpServersForStore: engineMocks.resolveMcpServersForStore,
    validateMcpServer: engineMocks.validateMcpServer,
  };
});

function createMockStore() {
  return {
    getRootDir: () => "/workspace",
    getSecretsStore: () => ({ revealSecret: vi.fn() }),
    getSettingsByScope: async () => ({ global: { mcpServers: { enabled: true, servers: [] } }, project: {} }),
    /*
    FNXC:PluginMcpServers 2026-07-24-01:25:
    FN-8491 (3cd023fa4) binds a project-scoped plugin-MCP provider on every getProjectContext.
    Exposing getProjectScopedPluginMcpServers marks this mock as runtime-owned so the binder
    short-circuits instead of calling getPluginStore().
    */
    getProjectScopedPluginMcpServers: async () => [],
  };
}

function createApp(store = createMockStore()) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store as never));
  return app;
}

describe("POST /api/mcp/validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineMocks.validateMcpServer.mockResolvedValue({ status: "valid", message: "ok" });
    engineMocks.resolveMcpServersForRuntime.mockResolvedValue({
      servers: [{ name: "local", transport: "stdio", command: "node", env: { TOKEN: "resolved-secret" } }],
      errors: [],
    });
    engineMocks.resolveMcpServersForStore.mockResolvedValue({ servers: [], errors: [] });
  });

  it("validates a supplied server definition and returns only status JSON", async () => {
    const app = createApp();
    const response = await request(
      app,
      "POST",
      "/api/mcp/validate",
      JSON.stringify({ server: { name: "local", transport: "stdio", command: "node", env: { TOKEN: { secretRef: "token", scope: "project" } } } }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "valid", message: "ok" });
    expect(engineMocks.resolveMcpServersForRuntime).toHaveBeenCalledTimes(1);
    expect(engineMocks.validateMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "local", env: { TOKEN: "resolved-secret" } }),
      expect.objectContaining({ cwd: "/workspace" }),
    );
    expect(JSON.stringify(response.body)).not.toContain("resolved-secret");
  });

  it("returns 400 for malformed request bodies", async () => {
    const app = createApp();
    const response = await request(
      app,
      "POST",
      "/api/mcp/validate",
      JSON.stringify({ timeoutMs: 1000 }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Provide either name or server" });
    expect(engineMocks.validateMcpServer).not.toHaveBeenCalled();
  });

  it("returns probe error status without converting it to HTTP failure", async () => {
    engineMocks.resolveMcpServersForStore.mockResolvedValue({
      servers: [{ name: "remote", transport: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: "resolved-secret" } }],
      errors: [],
    });
    engineMocks.validateMcpServer.mockResolvedValue({ status: "error", message: "server responded with HTTP 503" });

    const app = createApp();
    const response = await request(
      app,
      "POST",
      "/api/mcp/validate",
      JSON.stringify({ name: "remote" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "error", message: "server responded with HTTP 503" });
    expect(engineMocks.resolveMcpServersForStore).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response.body)).not.toContain("resolved-secret");
  });
});

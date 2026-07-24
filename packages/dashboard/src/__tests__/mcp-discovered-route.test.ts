// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";

const engineMocks = vi.hoisted(() => ({
  discoverMcpServers: vi.fn(),
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
    discoverMcpServers: engineMocks.discoverMcpServers,
    resolveMcpServersForRuntime: engineMocks.resolveMcpServersForRuntime,
    resolveMcpServersForStore: engineMocks.resolveMcpServersForStore,
    validateMcpServer: engineMocks.validateMcpServer,
  };
});

const projectSource = { id: "vscode-project", tool: "VS Code", label: "VS Code project", scope: "project" as const, path: "/repo/.vscode/mcp.json" };
const globalSource = { id: "claude-desktop-global", tool: "Claude Desktop", label: "Claude Desktop", scope: "global" as const, path: "/home/ada/claude.json" };

function createMockStore(settingsByScope = {
  global: { mcpServers: { enabled: true, servers: [{ name: "global-configured", transport: "stdio" as const, command: "node" }] } },
  project: { mcpServers: { enabled: true, servers: [{ name: "project-configured", transport: "stdio" as const, command: "node" }] } },
}) {
  return {
    getRootDir: () => "/repo",
    getSettingsByScopeFast: async () => settingsByScope,
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

describe("GET /api/mcp/discovered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineMocks.discoverMcpServers.mockResolvedValue({ sources: [], servers: [], errors: [] });
  });

  it("returns project discoveries with configured markers and stripped plaintext descriptors", async () => {
    engineMocks.discoverMcpServers.mockResolvedValue({
      sources: [projectSource],
      servers: [
        {
          source: projectSource,
          definition: { name: "project-configured", transport: "stdio", command: "node" },
          secretsToCreate: [],
        },
        {
          source: projectSource,
          definition: { name: "secure", transport: "stdio", command: "secure-mcp", env: { TOKEN: { secretRef: "mcp.secure.env.TOKEN", scope: "project" } } },
          secretsToCreate: [{ serverName: "secure", field: "env", key: "TOKEN", scope: "project", suggestedKey: "mcp.secure.env.TOKEN", plaintextValue: "do-not-return" }],
        },
      ],
      errors: ["VS Code project: skipped malformed entry"],
    });

    const response = await request(createApp(), "GET", "/api/mcp/discovered?scope=project");

    expect(response.status).toBe(200);
    expect(engineMocks.discoverMcpServers).toHaveBeenCalledWith({ scope: "project", projectRootDir: "/repo" });
    expect(response.body.servers[0]).toMatchObject({ alreadyConfigured: true, hasPlaintextSecrets: false });
    expect(response.body.servers[1]).toMatchObject({
      alreadyConfigured: false,
      hasPlaintextSecrets: true,
      secretDescriptors: [{ field: "env", key: "TOKEN", scope: "project", suggestedKey: "mcp.secure.env.TOKEN" }],
    });
    expect(JSON.stringify(response.body)).not.toContain("do-not-return");
    expect(response.body.errors).toEqual(["VS Code project: skipped malformed entry"]);
  });

  it("uses global configured settings when scope=global", async () => {
    engineMocks.discoverMcpServers.mockResolvedValue({
      sources: [globalSource],
      servers: [{ source: globalSource, definition: { name: "global-configured", transport: "stdio", command: "node" }, secretsToCreate: [] }],
      errors: [],
    });

    const response = await request(createApp(), "GET", "/api/mcp/discovered?scope=global");

    expect(response.status).toBe(200);
    expect(engineMocks.discoverMcpServers).toHaveBeenCalledWith({ scope: "global", projectRootDir: "/repo" });
    expect(response.body.servers[0].alreadyConfigured).toBe(true);
  });

  it("degrades to an empty result when no supported files exist", async () => {
    const response = await request(createApp(), "GET", "/api/mcp/discovered");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sources: [], servers: [], errors: [] });
  });
});

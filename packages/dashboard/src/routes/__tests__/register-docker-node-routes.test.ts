// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

const service = {
  listContexts: vi.fn(),
  testConnection: vi.fn(),
  recreateContainer: vi.fn(),
};

const mockCentralInstance = {
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getManagedDockerNode: vi.fn(),
  updateManagedDockerNode: vi.fn(),
  listNodes: vi.fn(),
  registerNode: vi.fn(),
  linkManagedDockerNodeToNode: vi.fn(),
  checkNodeHealth: vi.fn(),
  updateNode: vi.fn(),
  getNode: vi.fn(),
};

const mockGeneratorInstance = {
  provisionAndRegister: vi.fn(),
};

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    DockerClientService: vi.fn().mockImplementation(() => service),
    CentralCore: vi.fn().mockImplementation(() => mockCentralInstance),
    MeshConfigGenerator: vi.fn().mockImplementation(() => mockGeneratorInstance),
  };
});

function createStore() {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn().mockResolvedValue({}) })),
    getRootDir: vi.fn().mockReturnValue("/tmp"),
    getFusionDir: vi.fn().mockReturnValue("/tmp/.fusion"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as any;
}

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api", createApiRoutes(createStore()));
  return server;
}

describe("registerDockerNodeRoutes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /api/docker/contexts returns contexts", async () => {
    service.listContexts.mockResolvedValue([{ name: "default", isCurrentContext: true }]);
    const res = await request(app(), "GET", "/api/docker/contexts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: "default", isCurrentContext: true }]);
  });

  it("POST /api/docker/test-connection validates host protocol", async () => {
    const res = await request(app(), "POST", "/api/docker/test-connection", JSON.stringify({ hostConfig: { host: "http://bad" } }), { "Content-Type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("POST /api/docker/test-connection passes hostConfig", async () => {
    service.testConnection.mockResolvedValue({ success: true, isLocalDaemon: false });
    const hostConfig = { host: "tcp://1.2.3.4:2376", tlsVerify: true };
    const res = await request(app(), "POST", "/api/docker/test-connection", JSON.stringify({ hostConfig }), { "Content-Type": "application/json" });
    expect(res.status).toBe(200);
    expect(service.testConnection).toHaveBeenCalledWith(hostConfig);
  });

  it("GET /api/docker/local-available maps connection", async () => {
    service.testConnection.mockResolvedValue({ success: true, isLocalDaemon: true, dockerVersion: "24.0" });
    const res = await request(app(), "GET", "/api/docker/local-available");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, version: "24.0" });
  });

  it("GET /api/docker/local-available handles errors", async () => {
    service.testConnection.mockRejectedValue(new Error("boom"));
    const res = await request(app(), "GET", "/api/docker/local-available");
    expect(res.status).toBe(200);
    expect((res.body as any).available).toBe(false);
  });
});

describe("Mesh config routes", () => {
  const managedNode = {
    id: "dn_test123",
    nodeId: null,
    name: "test-node",
    imageName: "runfusion/fusion",
    imageTag: "latest",
    containerId: "container_abc",
    status: "creating",
    hostConfig: { host: undefined },
    envVars: {},
    volumeMounts: [],
    resourceSizing: { memoryMB: 4096, cpus: 2 },
    extraClis: [],
    persistentStorage: true,
    reachableUrl: null,
    apiKey: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => vi.clearAllMocks());

  // ── apply-mesh-config ──────────────────────────────────────────────────

  it("POST /api/docker/nodes/:managedId/apply-mesh-config — 201 success", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue(managedNode);
    mockCentralInstance.listNodes.mockResolvedValue([
      { id: "node-local", name: "local", type: "local", apiKey: "local-api-key" },
    ]);
    mockGeneratorInstance.provisionAndRegister.mockResolvedValue({
      config: { nodeApiKey: "new-key" },
      node: { id: "node_new", name: "test-node" },
      isHealthy: true,
    });

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/apply-mesh-config",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect((res.body as any).isHealthy).toBe(true);
    expect(mockGeneratorInstance.provisionAndRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        managedNode,
        orchestratorApiKey: "local-api-key",
      }),
    );
  });

  it("POST /api/docker/nodes/:managedId/apply-mesh-config — 404 not found", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue(undefined);

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/apply-mesh-config",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(404);
  });

  it("POST /api/docker/nodes/:managedId/apply-mesh-config — 400 already running", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue({
      ...managedNode,
      status: "running",
    });

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/apply-mesh-config",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/docker/nodes/:managedId/apply-mesh-config — 400 node in error state", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue({
      ...managedNode,
      status: "error",
    });

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/apply-mesh-config",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/docker/nodes/:managedId/apply-mesh-config — 400 no orchestrator API key", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue(managedNode);
    mockCentralInstance.listNodes.mockResolvedValue([
      { id: "node-local", name: "local", type: "local", apiKey: undefined },
    ]);

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/apply-mesh-config",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/docker/nodes/:managedId/apply-mesh-config — 500 container recreation failure", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue(managedNode);
    mockCentralInstance.listNodes.mockResolvedValue([
      { id: "node-local", name: "local", type: "local", apiKey: "local-key" },
    ]);
    mockGeneratorInstance.provisionAndRegister.mockRejectedValue(new Error("Container recreation failed"));

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/apply-mesh-config",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(500);
  });

  // ── regenerate-api-key ────────────────────────────────────────────────

  it("POST /api/docker/nodes/:managedId/regenerate-api-key — 200 updates both records", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue({
      ...managedNode,
      nodeId: "node_linked",
    });
    mockCentralInstance.updateManagedDockerNode.mockResolvedValue({ ...managedNode, apiKey: "new-key" });
    mockCentralInstance.updateNode.mockResolvedValue({ id: "node_linked", apiKey: "new-key" });

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/regenerate-api-key",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect((res.body as any).apiKey).toMatch(/^[0-9a-f]{32}$/);
    expect(mockCentralInstance.updateManagedDockerNode).toHaveBeenCalledWith(
      "dn_test123",
      expect.objectContaining({ apiKey: expect.any(String) }),
    );
    expect(mockCentralInstance.updateNode).toHaveBeenCalledWith(
      "node_linked",
      expect.objectContaining({ apiKey: expect.any(String) }),
    );
  });

  it("POST /api/docker/nodes/:managedId/regenerate-api-key — 200 without linked NodeConfig", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue({
      ...managedNode,
      nodeId: null,
    });
    mockCentralInstance.updateManagedDockerNode.mockResolvedValue({ ...managedNode, apiKey: "new-key" });

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/regenerate-api-key",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect((res.body as any).apiKey).toMatch(/^[0-9a-f]{32}$/);
    // Should NOT call updateNode since no linked NodeConfig
    expect(mockCentralInstance.updateNode).not.toHaveBeenCalled();
  });

  it("POST /api/docker/nodes/:managedId/regenerate-api-key — 404 not found", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue(undefined);

    const res = await request(
      app(),
      "POST",
      "/api/docker/nodes/dn_test123/regenerate-api-key",
      JSON.stringify({}),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(404);
  });

  // ── mesh-status ──────────────────────────────────────────────────────

  it("GET /api/docker/nodes/:managedId/mesh-status — 200 registered: true", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue({
      ...managedNode,
      nodeId: "node_linked",
      reachableUrl: "http://localhost:4041",
    });
    mockCentralInstance.getNode.mockResolvedValue({ id: "node_linked", status: "online" });
    mockCentralInstance.checkNodeHealth.mockResolvedValue("online");

    const res = await request(
      app(),
      "GET",
      "/api/docker/nodes/dn_test123/mesh-status",
    );

    expect(res.status).toBe(200);
    expect((res.body as any).registered).toBe(true);
    expect((res.body as any).status).toBe("online");
    expect((res.body as any).reachableUrl).toBe("http://localhost:4041");
    expect((res.body as any).lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("GET /api/docker/nodes/:managedId/mesh-status — 200 registered: false", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue({
      ...managedNode,
      nodeId: null,
    });

    const res = await request(
      app(),
      "GET",
      "/api/docker/nodes/dn_test123/mesh-status",
    );

    expect(res.status).toBe(200);
    expect((res.body as any).registered).toBe(false);
    expect((res.body as any).status).toBe("offline");
  });

  it("GET /api/docker/nodes/:managedId/mesh-status — 404 not found", async () => {
    mockCentralInstance.getManagedDockerNode.mockResolvedValue(undefined);

    const res = await request(
      app(),
      "GET",
      "/api/docker/nodes/dn_test123/mesh-status",
    );

    expect(res.status).toBe(404);
  });
});

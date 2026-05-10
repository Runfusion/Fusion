import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListNodes = vi.fn().mockResolvedValue([]);
const mockRegisterNode = vi.fn();
const mockGetNode = vi.fn();
const mockUpdateNode = vi.fn();
const mockUnregisterNode = vi.fn().mockResolvedValue(undefined);
const mockCheckNodeHealth = vi.fn();
const mockUpdateProject = vi.fn();
const mockAssignProjectToNode = vi.fn();
const mockUnassignProjectFromNode = vi.fn();
const mockGetLocalMeshSnapshot = vi.fn();
const mockGetLocalNode = vi.fn();
const mockGetNodeVersionInfo = vi.fn();
const mockSyncPlugins = vi.fn();
const mockCheckVersionCompatibility = vi.fn();
const mockListProjectNodePathMappingsForNode = vi.fn();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockInit,
      close: mockClose,
      listNodes: mockListNodes,
      registerNode: mockRegisterNode,
      getNode: mockGetNode,
      updateNode: mockUpdateNode,
      unregisterNode: mockUnregisterNode,
      checkNodeHealth: mockCheckNodeHealth,
      updateProject: mockUpdateProject,
      assignProjectToNode: mockAssignProjectToNode,
      unassignProjectFromNode: mockUnassignProjectFromNode,
      getLocalMeshSnapshot: mockGetLocalMeshSnapshot,
      getLocalNode: mockGetLocalNode,
      getNodeVersionInfo: mockGetNodeVersionInfo,
      syncPlugins: mockSyncPlugins,
      checkVersionCompatibility: mockCheckVersionCompatibility,
      listProjectNodePathMappingsForNode: mockListProjectNodePathMappingsForNode,
    })),
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1080";
  }

  getFusionDir(): string {
    return "/tmp/fn-1080/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
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

function makeNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "node_local",
    name: "local-node",
    type: "local",
    status: "online",
    maxConcurrent: 2,
    capabilities: ["executor"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Node routes", () => {
  const app = createServer(new MockStore() as any);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListNodes.mockResolvedValue([]);
    mockGetNode.mockResolvedValue(undefined);
    mockRegisterNode.mockResolvedValue(makeNode());
    mockUpdateNode.mockResolvedValue(makeNode({ name: "updated-node", maxConcurrent: 4 }));
    mockCheckNodeHealth.mockResolvedValue("online");
    mockUpdateProject.mockResolvedValue({
      id: "proj_123",
      name: "Project",
      path: "/tmp/project",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockAssignProjectToNode.mockResolvedValue({
      id: "proj_123",
      name: "Project",
      path: "/tmp/project",
      status: "active",
      isolationMode: "in-process",
      nodeId: "node_local",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockUnassignProjectFromNode.mockResolvedValue({
      id: "proj_123",
      name: "Project",
      path: "/tmp/project",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockGetLocalNode.mockResolvedValue({ id: "node_local", type: "local" });
    mockGetLocalMeshSnapshot.mockResolvedValue([
      {
        nodeId: "node_local",
        nodeName: "local-node",
        nodeUrl: undefined,
        nodeType: "local",
        status: "online",
        metrics: null,
        lastSeen: "2026-01-01T00:00:00.000Z",
        connectedAt: "2026-01-01T00:00:00.000Z",
        knownPeers: [],
      },
    ]);
    mockGetNodeVersionInfo.mockResolvedValue(undefined);
    mockSyncPlugins.mockResolvedValue({
      localNodeId: "node_local",
      remoteNodeId: "node_remote",
      plugins: [],
      comparedAt: "2026-01-01T00:00:00.000Z",
      isCompatible: true,
      summary: "No plugins to compare",
    });
    mockCheckVersionCompatibility.mockReturnValue({
      localVersion: "1.0.0",
      remoteVersion: "1.0.0",
      status: "compatible",
      message: "Versions match",
    });
    mockListProjectNodePathMappingsForNode.mockResolvedValue([]);
  });

  describe("POST /api/nodes/discover-projects", () => {
    it("returns normalized remote project discovery payload on success", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ([
          {
            id: "proj_1",
            name: "Project One",
            path: "/srv/project-one",
            status: "active",
            isolationMode: "in-process",
          },
        ]),
      });
      vi.stubGlobal("fetch", fetchMock);

      const res = await request(
        app,
        "POST",
        "/api/nodes/discover-projects",
        JSON.stringify({ url: "https://node.example.com", apiKey: "secret" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        projects: [
          {
            id: "proj_1",
            name: "Project One",
            path: "/srv/project-one",
            status: "active",
            isolationMode: "in-process",
          },
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://node.example.com/api/projects",
        expect.objectContaining({
          method: "GET",
          headers: { Authorization: "Bearer secret" },
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("returns upstream HTTP failure status and message", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({ error: "upstream down" }),
      }));

      const res = await request(
        app,
        "POST",
        "/api/nodes/discover-projects",
        JSON.stringify({ url: "https://node.example.com" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "upstream down" });
    });

    it("returns 401 when upstream rejects auth", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({ error: "Invalid API key" }),
      }));

      const res = await request(
        app,
        "POST",
        "/api/nodes/discover-projects",
        JSON.stringify({ url: "https://node.example.com", apiKey: "wrong" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid API key" });
    });

    it("rejects malformed upstream payload", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ projects: [] }),
      }));

      const res = await request(
        app,
        "POST",
        "/api/nodes/discover-projects",
        JSON.stringify({ url: "https://node.example.com" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Remote node returned malformed project discovery payload" });
    });

    it("returns 504 on timeout/unreachable abort", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));

      const res = await request(
        app,
        "POST",
        "/api/nodes/discover-projects",
        JSON.stringify({ url: "https://node.example.com" }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: "Remote node discovery request timed out" });
    });
  });

  it("GET /api/nodes/:id/path-mappings returns node mappings", async () => {
    mockListProjectNodePathMappingsForNode.mockResolvedValue([
      {
        projectId: "proj_1",
        nodeId: "node_local",
        path: "/tmp/project",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await request(app, "GET", "/api/nodes/node_local/path-mappings");

    expect(res.status).toBe(200);
    expect(mockListProjectNodePathMappingsForNode).toHaveBeenCalledWith("node_local");
  });

  it("GET /api/nodes/:id/path-mappings returns 404 when node missing", async () => {
    mockListProjectNodePathMappingsForNode.mockRejectedValue(new Error("Node not found: node_missing"));

    const res = await request(app, "GET", "/api/nodes/node_missing/path-mappings");

    expect(res.status).toBe(404);
  });

  it("GET /api/nodes returns an empty array when no nodes are registered", async () => {
    mockListNodes.mockResolvedValue([]);

    const res = await request(app, "GET", "/api/nodes");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/nodes returns node list", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ id: "node_b", name: "z-node" }),
      makeNode({ id: "node_a", name: "a-node" }),
    ]);

    const res = await request(app, "GET", "/api/nodes");

    expect(res.status).toBe(200);
    expect((res.body as any[])).toHaveLength(2);
    expect((res.body as any[])[0].name).toBe("a-node");
    expect((res.body as any[])[1].name).toBe("z-node");
  });

  it("POST /api/nodes registers a local node with minimal input", async () => {
    mockRegisterNode.mockResolvedValue(makeNode({ id: "node_1", name: "node-one", type: "local" }));

    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ name: "node-one", type: "local" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect((res.body as any).id).toBe("node_1");
    expect(mockRegisterNode).toHaveBeenCalledWith(expect.objectContaining({ name: "node-one", type: "local" }));
  });

  it("POST /api/nodes registers a remote node with url", async () => {
    mockRegisterNode.mockResolvedValue(
      makeNode({ id: "node_remote", name: "remote-node", type: "remote", url: "https://node.example.com" }),
    );

    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ name: "remote-node", type: "remote", url: "https://node.example.com" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect((res.body as any).type).toBe("remote");
    expect(mockRegisterNode).toHaveBeenCalledWith(
      expect.objectContaining({ name: "remote-node", type: "remote", url: "https://node.example.com" }),
    );
  });

  it("POST /api/nodes returns 400 when name is missing", async () => {
    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ type: "local" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/nodes returns 400 when remote node is missing url", async () => {
    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ name: "remote-node", type: "remote" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/nodes returns 400 for invalid type", async () => {
    const res = await request(
      app,
      "POST",
      "/api/nodes",
      JSON.stringify({ name: "node", type: "invalid" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
  });

  it("GET /api/nodes/:id returns node by id", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_1", name: "node-one" }));

    const res = await request(app, "GET", "/api/nodes/node_1");

    expect(res.status).toBe(200);
    expect((res.body as any).id).toBe("node_1");
  });

  it("GET /api/nodes/:id returns 404 for unknown id", async () => {
    mockGetNode.mockResolvedValue(undefined);

    const res = await request(app, "GET", "/api/nodes/missing");

    expect(res.status).toBe(404);
  });

  it("PATCH /api/nodes/:id updates node", async () => {
    mockUpdateNode.mockResolvedValue(makeNode({ id: "node_1", name: "node-two", maxConcurrent: 6 }));

    const res = await request(
      app,
      "PATCH",
      "/api/nodes/node_1",
      JSON.stringify({ name: "node-two", maxConcurrent: 6 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect((res.body as any).name).toBe("node-two");
    expect((res.body as any).maxConcurrent).toBe(6);
  });

  it("PATCH /api/nodes/:id returns 404 for unknown id", async () => {
    mockUpdateNode.mockRejectedValue(new Error("Node not found: missing"));

    const res = await request(
      app,
      "PATCH",
      "/api/nodes/missing",
      JSON.stringify({ name: "new-name" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(404);
  });

  it("DELETE /api/nodes/:id unregisters node", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_1" }));

    const res = await request(app, "DELETE", "/api/nodes/node_1");

    expect(res.status).toBe(204);
    expect(res.body == null || res.body === "").toBe(true);
    expect(mockUnregisterNode).toHaveBeenCalledWith("node_1");
  });

  it("DELETE /api/nodes/:id returns 404 for unknown id", async () => {
    mockGetNode.mockResolvedValue(undefined);

    const res = await request(app, "DELETE", "/api/nodes/missing");

    expect(res.status).toBe(404);
  });

  it("POST /api/nodes/:id/health-check returns health status", async () => {
    mockCheckNodeHealth.mockResolvedValue("online");

    const res = await request(app, "POST", "/api/nodes/node_1/health-check");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "online" });
  });

  it("POST /api/nodes/:id/health-check returns 404 for unknown id", async () => {
    mockCheckNodeHealth.mockRejectedValue(new Error("Node not found: missing"));

    const res = await request(app, "POST", "/api/nodes/missing/health-check");

    expect(res.status).toBe(404);
  });

  it("GET /api/mesh/state returns mesh topology snapshot", async () => {
    mockListNodes.mockResolvedValue([
      makeNode({ id: "node_local", name: "local", type: "local" }),
      makeNode({ id: "node_remote", name: "remote", type: "remote", url: "http://remote:3001" }),
    ]);

    const remoteMeshState = {
      sourceNodeId: "node_remote",
      collectedAt: "2026-01-01T00:00:00.000Z",
      nodes: [
        {
          nodeId: "node_remote",
          nodeName: "remote",
          nodeUrl: "http://remote:3001",
          nodeType: "remote" as const,
          status: "online" as const,
          metrics: { cpuUsage: 30, memoryUsed: 2e9, memoryTotal: 8e9, storageUsed: 100e9, storageTotal: 500e9, uptime: 3600000, reportedAt: "2026-01-01T00:00:00.000Z" },
          lastSeen: "2026-01-01T00:00:00.000Z",
          connectedAt: "2026-01-01T00:00:00.000Z",
          knownPeers: [{ id: "peer_1", nodeId: "node_remote", peerNodeId: "node_local", name: "local", url: "http://localhost:3001", status: "online" as const, lastSeen: "2026-01-01T00:00:00.000Z", connectedAt: "2026-01-01T00:00:00.000Z" }],
        },
      ],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => remoteMeshState }));

    const res = await request(app, "GET", "/api/mesh/state");

    expect(res.status).toBe(200);
    expect((res.body as { nodes: Array<{ nodeId: string }> }).nodes).toHaveLength(2);
    expect((res.body as { nodes: Array<{ nodeId: string }> }).nodes[0].nodeId).toBe("node_local");
    expect((res.body as { nodes: Array<{ nodeId: string }> }).nodes[1].nodeId).toBe("node_remote");
  });

  it("GET /api/nodes/:id/metrics returns systemMetrics from node", async () => {
    const systemMetrics = {
      cpuUsage: 45.5,
      memoryUsed: 4294967296,
      memoryTotal: 8589934592,
      storageUsed: 107374182400,
      storageTotal: 536870912000,
      uptime: 86400000,
      reportedAt: "2026-01-01T00:00:00.000Z",
    };
    mockGetNode.mockResolvedValue(
      makeNode({ id: "node_1", type: "local", maxConcurrent: 8, systemMetrics })
    );

    const res = await request(app, "GET", "/api/nodes/node_1/metrics");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(systemMetrics);
  });

  it("GET /api/nodes/:id/metrics returns null when no metrics available", async () => {
    mockGetNode.mockResolvedValue(makeNode({ id: "node_2", type: "remote" }));

    const res = await request(app, "GET", "/api/nodes/node_2/metrics");

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("PATCH /api/projects/:id assigns project to node when nodeId is provided", async () => {
    const res = await request(
      app,
      "PATCH",
      "/api/projects/proj_123",
      JSON.stringify({ nodeId: "node_local" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(mockUpdateProject).toHaveBeenCalledWith("proj_123", {});
    expect(mockAssignProjectToNode).toHaveBeenCalledWith("proj_123", "node_local");
    expect((res.body as any).nodeId).toBe("node_local");
  });

  it("PATCH /api/projects/:id unassigns project from node when nodeId is null", async () => {
    const res = await request(
      app,
      "PATCH",
      "/api/projects/proj_123",
      JSON.stringify({ nodeId: null }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(mockUnassignProjectFromNode).toHaveBeenCalledWith("proj_123");
    expect(res.body).not.toHaveProperty("nodeId");
  });

  // ── Node Version Routes ────────────────────────────────────────────────

  describe("GET /api/nodes/:id/version", () => {
    it("returns version info when available", async () => {
      const versionInfo = {
        appVersion: "1.2.3",
        pluginVersions: { "my-plugin": "0.1.0" },
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
      };
      mockGetNode.mockResolvedValue(makeNode({ id: "node_1", versionInfo }));

      const res = await request(app, "GET", "/api/nodes/node_1/version");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(versionInfo);
    });

    it("returns null when version info is absent", async () => {
      mockGetNode.mockResolvedValue(makeNode({ id: "node_2", type: "remote" }));
      mockGetNodeVersionInfo.mockResolvedValue(undefined);

      const res = await request(app, "GET", "/api/nodes/node_2/version");

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it("returns 404 when node is missing", async () => {
      mockGetNode.mockResolvedValue(undefined);

      const res = await request(app, "GET", "/api/nodes/missing/version");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/nodes/:id/sync-plugins", () => {
    it("returns 200 for remote node when local node exists", async () => {
      const remoteNode = makeNode({ id: "node_remote", name: "remote", type: "remote", url: "http://remote:3001" });
      const localNode = makeNode({ id: "node_local", name: "local", type: "local" });
      const syncResult = {
        localNodeId: "node_local",
        remoteNodeId: "node_remote",
        plugins: [],
        comparedAt: "2026-01-01T00:00:00.000Z",
        isCompatible: true,
        summary: "No plugins to compare",
      };

      mockGetNode.mockResolvedValue(remoteNode);
      mockListNodes.mockResolvedValue([localNode, remoteNode]);
      mockSyncPlugins.mockResolvedValue(syncResult);

      const res = await request(app, "POST", "/api/nodes/node_remote/sync-plugins");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(syncResult);
      expect(mockSyncPlugins).toHaveBeenCalledWith("node_local", "node_remote");
    });

    it("returns 400 when target node is local", async () => {
      const localNode = makeNode({ id: "node_local", name: "local", type: "local" });
      mockGetNode.mockResolvedValue(localNode);

      const res = await request(app, "POST", "/api/nodes/node_local/sync-plugins");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Cannot sync plugins to a local node - sync-plugins is for remote nodes only" });
    });

    it("returns 400 when no local node exists", async () => {
      const remoteNode = makeNode({ id: "node_remote", name: "remote", type: "remote", url: "http://remote:3001" });
      mockGetNode.mockResolvedValue(remoteNode);
      mockListNodes.mockResolvedValue([remoteNode]); // No local node

      const res = await request(app, "POST", "/api/nodes/node_remote/sync-plugins");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Local node not registered - cannot perform sync" });
    });

    it("returns 404 when target node is missing", async () => {
      mockGetNode.mockResolvedValue(undefined);

      const res = await request(app, "POST", "/api/nodes/missing/sync-plugins");

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/nodes/:id/compatibility", () => {
    it("returns 200 when both local and target versions are available", async () => {
      const localNode = makeNode({ id: "node_local", name: "local", type: "local" });
      const remoteNode = makeNode({ id: "node_remote", name: "remote", type: "remote", url: "http://remote:3001" });
      const compatibilityResult = {
        localVersion: "1.0.0",
        remoteVersion: "1.1.0",
        status: "minor-difference",
        message: "Minor version difference: local 1.0.0 vs remote 1.1.0",
      };

      mockGetNode.mockResolvedValue(remoteNode);
      mockListNodes.mockResolvedValue([localNode, remoteNode]);
      mockGetNodeVersionInfo
        .mockResolvedValueOnce({ appVersion: "1.0.0", pluginVersions: {}, lastSyncedAt: "2026-01-01T00:00:00.000Z" })
        .mockResolvedValueOnce({ appVersion: "1.1.0", pluginVersions: {}, lastSyncedAt: "2026-01-01T00:00:00.000Z" });
      mockCheckVersionCompatibility.mockReturnValue(compatibilityResult);

      const res = await request(app, "GET", "/api/nodes/node_remote/compatibility");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(compatibilityResult);
      expect(mockCheckVersionCompatibility).toHaveBeenCalledWith("1.0.0", "1.1.0");
    });

    it("returns 400 when local node is missing", async () => {
      const remoteNode = makeNode({ id: "node_remote", name: "remote", type: "remote", url: "http://remote:3001" });
      mockGetNode.mockResolvedValue(remoteNode);
      mockListNodes.mockResolvedValue([remoteNode]); // No local node

      const res = await request(app, "GET", "/api/nodes/node_remote/compatibility");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Local node not registered - cannot check compatibility" });
    });

    it("returns 400 when local version info is missing", async () => {
      const localNode = makeNode({ id: "node_local", name: "local", type: "local" });
      const remoteNode = makeNode({ id: "node_remote", name: "remote", type: "remote", url: "http://remote:3001" });
      mockGetNode.mockResolvedValue(remoteNode);
      mockListNodes.mockResolvedValue([localNode, remoteNode]);
      mockGetNodeVersionInfo
        .mockResolvedValueOnce(undefined) // No version info for local
        .mockResolvedValueOnce({ appVersion: "1.1.0", pluginVersions: {}, lastSyncedAt: "2026-01-01T00:00:00.000Z" });

      const res = await request(app, "GET", "/api/nodes/node_remote/compatibility");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Local node has no version info yet" });
    });

    it("returns 400 when target version info is missing", async () => {
      const localNode = makeNode({ id: "node_local", name: "local", type: "local" });
      const remoteNode = makeNode({ id: "node_remote", name: "remote", type: "remote", url: "http://remote:3001" });
      mockGetNode.mockResolvedValue(remoteNode);
      mockListNodes.mockResolvedValue([localNode, remoteNode]);
      mockGetNodeVersionInfo
        .mockResolvedValueOnce({ appVersion: "1.0.0", pluginVersions: {}, lastSyncedAt: "2026-01-01T00:00:00.000Z" })
        .mockResolvedValueOnce(undefined); // No version info for remote

      const res = await request(app, "GET", "/api/nodes/node_remote/compatibility");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Target node has no version info yet" });
    });

    it("returns 404 when target node is missing", async () => {
      mockGetNode.mockResolvedValue(undefined);

      const res = await request(app, "GET", "/api/nodes/missing/compatibility");

      expect(res.status).toBe(404);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request, get } from "../test-request.js";
import { createServer } from "../server.js";

// ── Mock @fusion/core for node routes ─────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListNodes = vi.fn();
const mockGetNode = vi.fn();
const mockRegisterNode = vi.fn();
const mockUpdateNode = vi.fn();
const mockUnregisterNode = vi.fn();
const mockCheckNodeHealth = vi.fn();
const mockGetLocalNode = vi.fn();
const mockGetLocalMeshSnapshot = vi.fn();
const mockIsDiscoveryActive = vi.fn().mockReturnValue(false);
const mockGetDiscoveryConfig = vi.fn().mockReturnValue(null);
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreGetAgent = vi.fn().mockResolvedValue(null);

vi.mock("@fusion/core", () => {
  return {
    CentralCore: class MockCentralCore {
      init = mockInit;
      close = mockClose;
      listNodes = mockListNodes;
      getNode = mockGetNode;
      registerNode = mockRegisterNode;
      updateNode = mockUpdateNode;
      unregisterNode = mockUnregisterNode;
      checkNodeHealth = mockCheckNodeHealth;
      getLocalNode = mockGetLocalNode;
      getLocalMeshSnapshot = mockGetLocalMeshSnapshot;
      isDiscoveryActive = mockIsDiscoveryActive;
      getDiscoveryConfig = mockGetDiscoveryConfig;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
    AgentStore: class MockAgentStore {
      init = mockAgentStoreInit;
      getAgent = mockAgentStoreGetAgent;
    },
    deterministicGuardLocks: new Map(),
  };
});

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1228-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1228-test/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }
}

// ── Test helpers ──────────────────────────────────────────────────────

function createMockNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "node-001",
    name: "Test Node",
    type: "local" as const,
    status: "online" as const,
    url: null,
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Node routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListNodes.mockResolvedValue([]);
    mockGetNode.mockResolvedValue(null);
    mockRegisterNode.mockResolvedValue(null);
    mockUpdateNode.mockResolvedValue(null);
    mockUnregisterNode.mockResolvedValue(undefined);
    mockCheckNodeHealth.mockResolvedValue({ status: "online" });
    mockGetLocalNode.mockResolvedValue(createMockNode({ id: "local", name: "Local", type: "local" }));
    mockGetLocalMeshSnapshot.mockResolvedValue([
      {
        nodeId: "local",
        nodeName: "Local",
        nodeUrl: undefined,
        nodeType: "local",
        status: "online",
        metrics: null,
        lastSeen: "2026-01-01T00:00:00.000Z",
        connectedAt: "2026-01-01T00:00:00.000Z",
        knownPeers: [],
      },
    ]);
    mockIsDiscoveryActive.mockReturnValue(false);
    mockGetDiscoveryConfig.mockReturnValue(null);

    store = new MockStore();
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("GET /api/nodes", () => {
    it("returns empty array when no nodes registered", async () => {
      mockListNodes.mockResolvedValue([]);

      const res = await get(app, "/api/nodes");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockListNodes).toHaveBeenCalled();
    });

    it("returns list of registered nodes sorted by name", async () => {
      const nodes = [
        createMockNode({ id: "node-002", name: "Zebra" }),
        createMockNode({ id: "node-001", name: "Alpha" }),
      ];
      mockListNodes.mockResolvedValue(nodes);

      const res = await get(app, "/api/nodes");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].name).toBe("Alpha");
      expect(res.body[1].name).toBe("Zebra");
    });

    it("includes node metadata in response", async () => {
      const node = createMockNode({
        id: "node-001",
        name: "Test Node",
        type: "remote",
        status: "online",
        url: "http://192.168.1.100:3001",
        maxConcurrent: 3,
      });
      mockListNodes.mockResolvedValue([node]);

      const res = await get(app, "/api/nodes");

      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({
        id: "node-001",
        name: "Test Node",
        type: "remote",
        status: "online",
        url: "http://192.168.1.100:3001",
        maxConcurrent: 3,
      });
    });
  });

  describe("POST /api/nodes", () => {
    it("registers a new remote node", async () => {
      const newNode = createMockNode({
        id: "node-003",
        name: "Remote Server",
        type: "remote",
        url: "http://192.168.1.100:3001",
      });
      mockRegisterNode.mockResolvedValue(newNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes",
        JSON.stringify({
          name: "Remote Server",
          type: "remote",
          url: "http://192.168.1.100:3001",
          maxConcurrent: 2,
        }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: "node-003",
        name: "Remote Server",
        type: "remote",
      });
      expect(mockRegisterNode).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Remote Server",
          type: "remote",
          url: "http://192.168.1.100:3001",
          maxConcurrent: 2,
        }),
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(
        app,
        "POST",
        "/api/nodes",
        JSON.stringify({
          type: "remote",
          url: "http://example.com",
        }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name");
    });

    it("returns 400 when url is missing for remote node", async () => {
      const res = await request(
        app,
        "POST",
        "/api/nodes",
        JSON.stringify({
          name: "Test Node",
          type: "remote",
        }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("url");
    });

    it("registers a local node without url", async () => {
      const localNode = createMockNode({
        id: "node-local",
        name: "Local Node",
        type: "local",
        url: null,
      });
      mockRegisterNode.mockResolvedValue(localNode);

      const res = await request(
        app,
        "POST",
        "/api/nodes",
        JSON.stringify({
          name: "Local Node",
          type: "local",
        }),
        { "content-type": "application/json" },
      );

      expect(res.status).toBe(201);
      expect(mockRegisterNode).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Local Node",
          type: "local",
        }),
      );
    });
  });

  describe("GET /api/nodes/:id", () => {
    it("returns node detail for existing node", async () => {
      const node = createMockNode({ id: "node-001", name: "Test Node" });
      mockGetNode.mockResolvedValue(node);

      const res = await get(app, "/api/nodes/node-001");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: "node-001",
        name: "Test Node",
      });
    });

    it("returns 404 for unknown node", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await get(app, "/api/nodes/unknown");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("not found");
    });
  });

  describe("GET /api/nodes/:id/metrics", () => {
    it("returns metrics for local node", async () => {
      const node = createMockNode({
        id: "node-001",
        type: "local",
        systemMetrics: {
          cpu: { usagePercent: 12 },
          memory: { totalBytes: 1024, usedBytes: 512, freeBytes: 512, usagePercent: 50 },
          uptime: { seconds: 123 },
          platform: "darwin",
          hostname: "local-node",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      });
      mockGetNode.mockResolvedValue(node);

      const res = await get(app, "/api/nodes/node-001/metrics");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        cpu: { usagePercent: 12 },
        hostname: "local-node",
      });
    });

    it("returns 404 for unknown node", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await get(app, "/api/nodes/unknown/metrics");

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/nodes/:id", () => {
    it("removes node and returns 204", async () => {
      const node = createMockNode({ id: "node-001" });
      mockGetNode.mockResolvedValue(node);
      mockUnregisterNode.mockResolvedValue(undefined);

      const res = await request(app, "DELETE", "/api/nodes/node-001");

      expect(res.status).toBe(204);
      expect(mockUnregisterNode).toHaveBeenCalledWith("node-001");
    });

    it("returns 404 for unknown node", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await request(app, "DELETE", "/api/nodes/unknown");

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/mesh/state", () => {
    it("returns mesh topology snapshot payload", async () => {
      mockListNodes.mockResolvedValue([
        createMockNode({ id: "local", name: "Local", type: "local" }),
        createMockNode({ id: "remote-1", name: "Remote 1", type: "remote", url: "http://remote1:3001" }),
      ]);
      mockGetLocalMeshSnapshot.mockResolvedValue([
        {
          nodeId: "local",
          nodeName: "Local",
          nodeUrl: undefined,
          nodeType: "local",
          status: "online",
          metrics: null,
          lastSeen: "2026-01-01T00:00:00.000Z",
          connectedAt: "2026-01-01T00:00:00.000Z",
          knownPeers: [],
        },
      ]);

      const res = await get(app, "/api/mesh/state");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sourceNodeId: "local",
        nodes: [
          {
            nodeId: "local",
            nodeType: "local",
          },
        ],
      });
    });

    it("fetches remote local mesh state and merges it into response", async () => {
      mockListNodes.mockResolvedValue([
        createMockNode({ id: "local", name: "Local", type: "local" }),
        createMockNode({ id: "remote-1", name: "Remote 1", type: "remote", url: "http://remote1:3001" }),
      ]);

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sourceNodeId: "remote-1",
          collectedAt: "2026-01-02T00:00:00.000Z",
          nodes: [
            {
              nodeId: "remote-1",
              nodeName: "Remote 1",
              nodeUrl: "http://remote1:3001",
              nodeType: "remote",
              status: "online",
              metrics: {
                cpuUsage: 50,
                memoryUsed: 1024,
                memoryTotal: 2048,
                storageUsed: 8192,
                storageTotal: 16384,
                uptime: 120,
                reportedAt: "2026-01-02T00:00:00.000Z",
              },
              lastSeen: "2026-01-02T00:00:00.000Z",
              connectedAt: "2026-01-01T00:00:00.000Z",
              knownPeers: [],
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const res = await get(app, "/api/mesh/state");

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://remote1:3001/api/mesh/state?includeRemote=false",
        expect.objectContaining({ method: "GET" }),
      );
      const remoteState = (res.body as { nodes: Array<{ nodeId: string; metrics: unknown }> }).nodes.find((entry) => entry.nodeId === "remote-1");
      expect(remoteState).toBeDefined();
      expect(remoteState?.metrics).toEqual({
        cpuUsage: 50,
        memoryUsed: 1024,
        memoryTotal: 2048,
        storageUsed: 8192,
        storageTotal: 16384,
        uptime: 120,
        reportedAt: "2026-01-02T00:00:00.000Z",
      });
    });

    it("returns local snapshot only when includeRemote is false", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await get(app, "/api/mesh/state?includeRemote=false");

      expect(res.status).toBe(200);
      expect((res.body as { nodes: Array<{ nodeId: string }> }).nodes).toHaveLength(1);
      expect((res.body as { nodes: Array<{ nodeId: string }> }).nodes[0].nodeId).toBe("local");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/nodes/:id/health-check", () => {
    it("triggers health check for existing node", async () => {
      const node = createMockNode({ id: "node-001" });
      mockGetNode.mockResolvedValue(node);
      mockCheckNodeHealth.mockResolvedValue({
        status: "online",
        responseTimeMs: 50,
      });

      const res = await request(app, "POST", "/api/nodes/node-001/health-check");

      expect(res.status).toBe(200);
      // Response wraps healthStatus in { status: healthStatus }
      expect(res.body.status).toMatchObject({ status: "online" });
      expect(mockCheckNodeHealth).toHaveBeenCalledWith("node-001");
    });

    it("returns 404 for unknown node (checkNodeHealth throws)", async () => {
      mockGetNode.mockResolvedValue(null);
      mockCheckNodeHealth.mockRejectedValue(new Error("Node not found"));

      const res = await request(app, "POST", "/api/nodes/unknown/health-check");

      expect(res.status).toBe(404);
    });
  });
});

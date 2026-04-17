import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request, get } from "../test-request.js";

// ── Mock @fusion/core for node routes ─────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListNodes = vi.fn();
const mockGetNode = vi.fn();
const mockRegisterNode = vi.fn();
const mockUpdateNode = vi.fn();
const mockUnregisterNode = vi.fn();
const mockCheckNodeHealth = vi.fn();
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
  let app: ReturnType<typeof import("../server.js").createServer>;

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
    mockIsDiscoveryActive.mockReturnValue(false);
    mockGetDiscoveryConfig.mockReturnValue(null);

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    it("returns mesh topology state with connections", async () => {
      const nodes = [
        createMockNode({ id: "local", name: "Local", type: "local" }),
        createMockNode({ id: "remote-1", name: "Remote 1", type: "remote", url: "http://remote1:3001" }),
        createMockNode({ id: "remote-2", name: "Remote 2", type: "remote", url: "http://remote2:3001" }),
      ];
      mockListNodes.mockResolvedValue(nodes);

      const res = await get(app, "/api/mesh/state");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);

      // Local node should have connections to both remote nodes
      const localNode = res.body.find((n: any) => n.type === "local");
      expect(localNode).toBeDefined();
      expect(localNode.connections).toHaveLength(2);
      expect(localNode.connections.map((c: any) => c.peerId)).toContain("remote-1");
      expect(localNode.connections.map((c: any) => c.peerId)).toContain("remote-2");
    });

    it("returns empty connections when only local node exists", async () => {
      const nodes = [createMockNode({ id: "local", name: "Local", type: "local" })];
      mockListNodes.mockResolvedValue(nodes);

      const res = await get(app, "/api/mesh/state");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].connections).toHaveLength(0);
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

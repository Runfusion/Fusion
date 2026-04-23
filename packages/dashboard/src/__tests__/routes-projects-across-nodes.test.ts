import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { get } from "../test-request.js";

// ── Mock @fusion/core for project routes ─────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListProjects = vi.fn();
const mockListNodes = vi.fn();
const mockReconcileProjectStatuses = vi.fn().mockResolvedValue(undefined);
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreInit = vi.fn().mockResolvedValue(undefined);

// Store original fetch for use in tests
const originalFetch = globalThis.fetch;

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: class MockCentralCore {
      init = mockInit;
      close = mockClose;
      listProjects = mockListProjects;
      listNodes = mockListNodes;
      reconcileProjectStatuses = mockReconcileProjectStatuses;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
    AgentStore: class MockAgentStore {
      init = mockAgentStoreInit;
    },
  };
});

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1850-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1850-test/.fusion";
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

function createMockProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_local001",
    name: "Local Project",
    path: "/projects/local",
    status: "active" as const,
    isolationMode: "in-process" as const,
    nodeId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockRemoteNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "node_remote001",
    name: "Remote Node",
    type: "remote" as const,
    status: "online" as const,
    url: "https://remote-node.example.com",
    apiKey: "test-api-key-123",
    maxConcurrent: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockRemoteProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_remote001",
    name: "Remote Project",
    path: "/projects/remote",
    status: "active" as const,
    isolationMode: "child-process" as const,
    nodeId: "node_remote001",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Test setup ─────────────────────────────────────────────────────────

describe("GET /api/projects/across-nodes", () => {
  let store: MockStore;
  let app: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as unknown as Parameters<typeof createServer>[0] extends { store: infer S } ? S : never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  it("returns local projects when no remote nodes exist", async () => {
    const localProjects = [
      createMockProject({ id: "proj_001", name: "Local Project 1" }),
      createMockProject({ id: "proj_002", name: "Local Project 2" }),
    ];

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([]); // No remote nodes

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string }>;
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("proj_001");
    expect(body[1].id).toBe("proj_002");
  });

  it("returns merged projects when remote nodes are online", async () => {
    const localProjects = [
      createMockProject({ id: "proj_local001", name: "Local Project" }),
    ];
    const remoteNode = createMockRemoteNode();
    const remoteProjects = [
      createMockRemoteProject({ id: "proj_remote001", name: "Remote Project" }),
    ];

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([remoteNode]);

    // Mock fetch for remote node
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => remoteProjects,
    });
    globalThis.fetch = mockFetch;

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string; nodeId?: string; _sourceNodeName?: string }>;
    expect(body).toHaveLength(2);

    // Check local project
    const localProject = body.find((p) => p.id === "proj_local001");
    expect(localProject).toBeDefined();
    expect(localProject?.nodeId).toBeUndefined();

    // Check remote project was tagged with node info
    const remoteProject = body.find((p) => p.id === "proj_remote001");
    expect(remoteProject).toBeDefined();
    expect(remoteProject?.nodeId).toBe(remoteNode.id);
    expect(remoteProject?._sourceNodeName).toBe(remoteNode.name);
  });

  it("skips unreachable remote nodes gracefully", async () => {
    const localProjects = [
      createMockProject({ id: "proj_local001", name: "Local Project" }),
    ];
    const remoteNode = createMockRemoteNode({ id: "node_unreachable", name: "Unreachable Node" });

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([remoteNode]);

    // Mock fetch that throws an error (simulating unreachable node)
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    globalThis.fetch = mockFetch;

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string }>;
    // Should still return local projects
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("proj_local001");

    // Should have logged a warning
    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy.mock.calls[0][0]).toContain("projects:across-nodes]");

    consoleWarnSpy.mockRestore();
  });

  it("skips offline remote nodes", async () => {
    const localProjects = [
      createMockProject({ id: "proj_local001", name: "Local Project" }),
    ];
    const offlineNode = createMockRemoteNode({
      id: "node_offline",
      name: "Offline Node",
      status: "offline",
    });

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([offlineNode]);

    // Mock fetch - should NOT be called
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string }>;
    expect(body).toHaveLength(1);

    // Fetch should not have been called for offline node
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips nodes without URLs", async () => {
    const localProjects = [
      createMockProject({ id: "proj_local001", name: "Local Project" }),
    ];
    const nodeWithoutUrl = createMockRemoteNode({
      id: "node_no_url",
      name: "Node Without URL",
      url: undefined,
    });

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([nodeWithoutUrl]);

    // Mock fetch - should NOT be called
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string }>;
    expect(body).toHaveLength(1);

    // Fetch should not have been called for node without URL
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("tags remote projects with nodeId and sourceNodeName", async () => {
    const localProjects: ReturnType<typeof createMockProject>[] = [];
    const remoteNode1 = createMockRemoteNode({
      id: "node_alpha",
      name: "Alpha Node",
      url: "https://alpha.example.com",
    });
    const remoteNode2 = createMockRemoteNode({
      id: "node_beta",
      name: "Beta Node",
      url: "https://beta.example.com",
    });
    const remoteProjectsAlpha = [
      createMockProject({ id: "proj_a1", name: "Alpha Project 1" }),
      createMockProject({ id: "proj_a2", name: "Alpha Project 2" }),
    ];
    const remoteProjectsBeta = [
      createMockProject({ id: "proj_b1", name: "Beta Project" }),
    ];

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([remoteNode1, remoteNode2]);

    // Mock fetch for multiple nodes
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => remoteProjectsAlpha,
        });
      } else {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => remoteProjectsBeta,
        });
      }
    });
    globalThis.fetch = mockFetch;

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string; nodeId?: string; _sourceNodeName?: string }>;
    expect(body).toHaveLength(3);

    // Check Alpha node projects
    const alphaProject1 = body.find((p) => p.id === "proj_a1");
    expect(alphaProject1?.nodeId).toBe("node_alpha");
    expect(alphaProject1?._sourceNodeName).toBe("Alpha Node");

    const alphaProject2 = body.find((p) => p.id === "proj_a2");
    expect(alphaProject2?.nodeId).toBe("node_alpha");
    expect(alphaProject2?._sourceNodeName).toBe("Alpha Node");

    // Check Beta node project
    const betaProject = body.find((p) => p.id === "proj_b1");
    expect(betaProject?.nodeId).toBe("node_beta");
    expect(betaProject?._sourceNodeName).toBe("Beta Node");
  });

  it("handles HTTP errors from remote nodes gracefully", async () => {
    const localProjects = [
      createMockProject({ id: "proj_local001", name: "Local Project" }),
    ];
    const remoteNode = createMockRemoteNode({
      id: "node_error",
      name: "Error Node",
      url: "https://error.example.com",
    });

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([remoteNode]);

    // Mock fetch that returns an error response
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });
    globalThis.fetch = mockFetch;

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string }>;
    // Should still return local projects
    expect(body).toHaveLength(1);

    // Should have logged a warning
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  it("handles non-JSON responses from remote nodes gracefully", async () => {
    const localProjects = [
      createMockProject({ id: "proj_local001", name: "Local Project" }),
    ];
    const remoteNode = createMockRemoteNode({
      id: "node_bad_json",
      name: "Bad JSON Node",
      url: "https://badjson.example.com",
    });

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([remoteNode]);

    // Mock fetch that returns non-JSON response
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    globalThis.fetch = mockFetch;

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string }>;
    // Should still return local projects
    expect(body).toHaveLength(1);

    // Should have logged a warning
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
  });

  it("fetches from multiple remote nodes in parallel", async () => {
    const localProjects: ReturnType<typeof createMockProject>[] = [];
    const remoteNode1 = createMockRemoteNode({
      id: "node_p1",
      name: "Parallel Node 1",
      url: "https://p1.example.com",
    });
    const remoteNode2 = createMockRemoteNode({
      id: "node_p2",
      name: "Parallel Node 2",
      url: "https://p2.example.com",
    });

    mockListProjects.mockResolvedValueOnce(localProjects);
    mockListNodes.mockResolvedValueOnce([remoteNode1, remoteNode2]);

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [
          createMockProject({ id: `proj_${url.includes("p1") ? "from1" : "from2"}` }),
        ],
      });
    });
    globalThis.fetch = mockFetch;

    const response = await get(app, "/api/projects/across-nodes");

    expect(response.status).toBe(200);
    const body = response.body as Array<{ id: string }>;
    expect(body).toHaveLength(2);

    // Both fetches should have been triggered
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

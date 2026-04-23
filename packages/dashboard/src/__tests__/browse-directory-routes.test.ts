import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

// Mock node:fs for route handler tests that check path existence
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  };
});

// Use vi.hoisted() for mock functions that need to be accessible in hoisted vi.mock calls
const {
  mockInit,
  mockClose,
  mockListNodes,
  mockGetNode,
} = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockListNodes: vi.fn().mockResolvedValue([]),
  mockGetNode: vi.fn().mockResolvedValue(null),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockInit,
      close: mockClose,
      listNodes: mockListNodes,
      getNode: mockGetNode,
    })),
  };
});

// Import after mocking
import { browseDirectory } from "../../app/api.js";

function mockFetchResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 500,
  contentType = "application/json"
) {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
    arrayBuffer: () => Promise.resolve(Buffer.from(bodyText)),
  } as unknown as Response);
}

class MockStoreForRoutes extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-944";
  }

  getFusionDir(): string {
    return "/tmp/fn-944/.fusion";
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

  async listTasks() {
    return [];
  }
}

describe("GET /api/browse-directory route handler", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
    mockListNodes.mockResolvedValue([]);
    mockGetNode.mockResolvedValue(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("local node (no nodeId)", () => {
    it("returns local filesystem entries when no nodeId is provided", async () => {
      const store = new MockStoreForRoutes();
      const app = createServer(store as any);

      const res = await request(app, "GET", "/api/browse-directory");

      expect(res.status).toBe(200);
      // No CentralCore calls when nodeId is not provided (direct filesystem access)
      expect(mockInit).not.toHaveBeenCalled();
    });
  });

  describe("local node (nodeId matches local node)", () => {
    it("returns local filesystem entries when nodeId matches local node", async () => {
      const store = new MockStoreForRoutes();
      const app = createServer(store as any);

      // Mock local node
      mockListNodes.mockResolvedValue([
        {
          id: "node-local-1",
          name: "Local Node",
          type: "local",
          url: "http://localhost:4040",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      const res = await request(app, "GET", "/api/browse-directory?nodeId=node-local-1");

      expect(res.status).toBe(200);
      expect(mockListNodes).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("remote node (nodeId is remote)", () => {
    it("proxies request to remote node", async () => {
      const store = new MockStoreForRoutes();
      const app = createServer(store as any);

      // Mock remote node
      mockGetNode.mockResolvedValue({
        id: "node-remote-1",
        name: "Remote Node",
        type: "remote",
        url: "http://remote:4040",
        apiKey: undefined,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      // Mock remote fetch response
      const remoteResponse = {
        currentPath: "/home",
        parentPath: "/",
        entries: [],
      };
      globalThis.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {
            get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null,
            entries: () => [],
          },
          json: () => Promise.resolve(remoteResponse),
          arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify(remoteResponse))),
        });
      });

      const res = await request(app, "GET", "/api/browse-directory?nodeId=node-remote-1&path=/home");

      expect(res.status).toBe(200);
      expect(mockGetNode).toHaveBeenCalledWith("node-remote-1");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("http://remote:4040"),
        expect.objectContaining({
          method: "GET",
        })
      );
    });

    it("includes Authorization header when apiKey is set", async () => {
      const store = new MockStoreForRoutes();
      const app = createServer(store as any);

      // Mock remote node with apiKey
      mockGetNode.mockResolvedValue({
        id: "node-remote-1",
        name: "Remote Node",
        type: "remote",
        url: "http://remote:4040",
        apiKey: "secret-key",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(true, { currentPath: "/", parentPath: null, entries: [] }));

      await request(app, "GET", "/api/browse-directory?nodeId=node-remote-1");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer secret-key",
          }),
        })
      );
    });

    it("returns 404 when node not found", async () => {
      const store = new MockStoreForRoutes();
      const app = createServer(store as any);

      // No local nodes, getNode returns null
      mockGetNode.mockResolvedValue(null);

      const res = await request(app, "GET", "/api/browse-directory?nodeId=nonexistent");

      expect(res.status).toBe(404);
    });

    it("returns 400 when node has no URL", async () => {
      const store = new MockStoreForRoutes();
      const app = createServer(store as any);

      // Node exists but has no URL
      mockGetNode.mockResolvedValue({
        id: "node-no-url",
        name: "No URL Node",
        type: "remote",
        url: undefined,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const res = await request(app, "GET", "/api/browse-directory?nodeId=node-no-url");

      expect(res.status).toBe(400);
    });

    it("returns 502 on remote fetch error", async () => {
      const store = new MockStoreForRoutes();
      const app = createServer(store as any);

      mockGetNode.mockResolvedValue({
        id: "node-remote-1",
        name: "Remote Node",
        type: "remote",
        url: "http://remote:4040",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      // Mock fetch throwing TypeError (network error)
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      const res = await request(app, "GET", "/api/browse-directory?nodeId=node-remote-1");

      expect(res.status).toBe(502);
    });
  });
});

describe("browseDirectory API function", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends nodeId parameter when provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(true, { currentPath: "/", parentPath: null, entries: [] })
    );

    await browseDirectory("/home", false, "node-remote-1", "node-local-1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/browse-directory?path=%2Fhome&nodeId=node-remote-1"),
      expect.any(Object),
    );
  });

  it("calls directly without proxy when nodeId matches localNodeId", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(true, { currentPath: "/", parentPath: null, entries: [] })
    );

    await browseDirectory("/home", false, "node-local-1", "node-local-1");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/browse-directory"),
      expect.not.objectContaining({ nodeId: expect.anything() })
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/proxy/"),
    );
  });

  it("does not include nodeId in direct calls", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(true, { currentPath: "/", parentPath: null, entries: [] })
    );

    await browseDirectory("/home");

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const url: string = calls[0][0];
    expect(url).not.toContain("nodeId");
  });
});

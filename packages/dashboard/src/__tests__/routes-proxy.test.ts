import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockGetNode = vi.fn();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockInit,
      close: mockClose,
      getNode: mockGetNode,
    })),
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1806";
  }

  getFusionDir(): string {
    return "/tmp/fn-1806/.fusion";
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

describe("Node proxy routes", () => {
  const app = createServer(new MockStore() as any);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNode.mockResolvedValue(undefined);
    vi.mock("@fusion/core", async () => {
      const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
      return {
        ...actual,
        CentralCore: vi.fn().mockImplementation(() => ({
          init: mockInit,
          close: mockClose,
          getNode: mockGetNode,
        })),
      };
    });
  });

  // ── Helper to create a mock fetch response ─────────────────────────────

  function makeMockFetchResponse(options: {
    status?: number;
    ok?: boolean;
    body?: unknown;
    headers?: Record<string, string>;
    streamChunks?: string[];
  }): Promise<Response> {
    const {
      status = 200,
      ok = true,
      body,
      headers = { "content-type": "application/json" },
      streamChunks = [],
    } = options;

    // Build chunks: if body is provided, encode it as JSON; otherwise use streamChunks
    const chunks =
      body !== undefined && streamChunks.length === 0
        ? [JSON.stringify(body)]
        : streamChunks;

    const readable = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const mockResponse = {
      ok,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: new Map(Object.entries(headers)),
      body: readable,
    } as unknown as Response;

    return Promise.resolve(mockResponse);
  }

  // ── Successful proxy tests ─────────────────────────────────────────────

  describe("GET /api/proxy/:nodeId/health", () => {
    it("returns forwarded JSON from remote node health endpoint", async () => {
      const remoteNode = makeNode({
        id: "node_remote",
        name: "remote",
        type: "remote",
        url: "http://remote:4040",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeMockFetchResponse({
            status: 200,
            ok: true,
            body: { status: "ok", version: "1.0.0" },
          }),
        ),
      );

      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(app, "GET", "/api/proxy/node_remote/health");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", version: "1.0.0" });
      expect(mockInit).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("GET /api/proxy/:nodeId/projects", () => {
    it("returns forwarded JSON from remote node projects endpoint", async () => {
      const remoteNode = makeNode({
        id: "node_remote",
        name: "remote",
        type: "remote",
        url: "http://remote:4040",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeMockFetchResponse({
            status: 200,
            ok: true,
            body: [
              { id: "proj_1", name: "Project 1", path: "/tmp/p1" },
              { id: "proj_2", name: "Project 2", path: "/tmp/p2" },
            ],
          }),
        ),
      );

      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(app, "GET", "/api/proxy/node_remote/projects");

      expect(res.status).toBe(200);
      expect((res.body as unknown[])).toHaveLength(2);
      expect((res.body as unknown[])[0]).toEqual({ id: "proj_1", name: "Project 1", path: "/tmp/p1" });
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("GET /api/proxy/:nodeId/tasks", () => {
    it("forwards query params to remote node tasks endpoint", async () => {
      const remoteNode = makeNode({
        id: "node_remote",
        name: "remote",
        type: "remote",
        url: "http://remote:4040",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeMockFetchResponse({
            status: 200,
            ok: true,
            body: [],
          }),
        ),
      );

      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(
        app,
        "GET",
        "/api/proxy/node_remote/tasks?projectId=proj_123&q=test+query",
      );

      expect(res.status).toBe(200);
      expect(mockClose).toHaveBeenCalled();

      // Verify fetch was called with the correct URL containing forwarded query params
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe(
        "http://remote:4040/api/tasks?projectId=proj_123&q=test+query",
      );
    });
  });

  describe("GET /api/proxy/:nodeId/project-health", () => {
    it("forwards projectId query param to remote node project-health endpoint", async () => {
      const remoteNode = makeNode({
        id: "node_remote",
        name: "remote",
        type: "remote",
        url: "http://remote:4040",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeMockFetchResponse({
            status: 200,
            ok: true,
            body: { healthy: true, tasksDone: 42, tasksTotal: 100 },
          }),
        ),
      );

      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(
        app,
        "GET",
        "/api/proxy/node_remote/project-health?projectId=proj_456",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ healthy: true, tasksDone: 42, tasksTotal: 100 });
      expect(mockClose).toHaveBeenCalled();

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://remote:4040/api/project-health?projectId=proj_456");
    });
  });

  // ── Node not found / local / no URL ───────────────────────────────────

  it("returns 404 when node is not found", async () => {
    mockGetNode.mockResolvedValue(undefined);

    const res = await request(app, "GET", "/api/proxy/missing_node/health");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Node not found" });
    expect(mockClose).toHaveBeenCalled();
  });

  it("returns 400 when node type is local", async () => {
    const localNode = makeNode({
      id: "node_local",
      name: "local",
      type: "local",
    });

    mockGetNode.mockResolvedValue(localNode);

    const res = await request(app, "GET", "/api/proxy/node_local/projects");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Cannot proxy to local node" });
    expect(mockClose).toHaveBeenCalled();
  });

  it("returns 400 when remote node has no URL configured", async () => {
    const nodeNoUrl = makeNode({
      id: "node_remote",
      name: "remote",
      type: "remote",
      url: undefined,
    });

    mockGetNode.mockResolvedValue(nodeNoUrl);

    const res = await request(app, "GET", "/api/proxy/node_remote/health");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Node has no URL configured" });
    expect(mockClose).toHaveBeenCalled();
  });

  // ── Auth header injection ─────────────────────────────────────────────

  it("injects Authorization header when node has apiKey", async () => {
    const remoteNode = makeNode({
      id: "node_remote",
      name: "remote",
      type: "remote",
      url: "http://remote:4040",
      apiKey: "secret-key-123",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeMockFetchResponse({ status: 200, ok: true, body: [] }),
      ),
    );

    mockGetNode.mockResolvedValue(remoteNode);

    await request(app, "GET", "/api/proxy/node_remote/projects");

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[1]?.headers).toEqual({
      Authorization: "Bearer secret-key-123",
    });
    expect(mockClose).toHaveBeenCalled();
  });

  it("does not inject Authorization header when node has no apiKey", async () => {
    const remoteNode = makeNode({
      id: "node_remote",
      name: "remote",
      type: "remote",
      url: "http://remote:4040",
      apiKey: undefined,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeMockFetchResponse({ status: 200, ok: true, body: [] }),
      ),
    );

    mockGetNode.mockResolvedValue(remoteNode);

    await request(app, "GET", "/api/proxy/node_remote/health");

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(fetchCall[1]?.headers).toEqual({});
    expect(mockClose).toHaveBeenCalled();
  });

  // ── Network error handling ─────────────────────────────────────────────

  it("returns 502 when fetch throws TypeError (network error)", async () => {
    const remoteNode = makeNode({
      id: "node_remote",
      name: "remote",
      type: "remote",
      url: "http://remote:4040",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    mockGetNode.mockResolvedValue(remoteNode);

    const res = await request(app, "GET", "/api/proxy/node_remote/health");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Remote node unreachable" });
    expect(mockClose).toHaveBeenCalled();
  });

  it("returns 504 when fetch throws AbortError (timeout)", async () => {
    const remoteNode = makeNode({
      id: "node_remote",
      name: "remote",
      type: "remote",
      url: "http://remote:4040",
    });

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    mockGetNode.mockResolvedValue(remoteNode);

    const res = await request(app, "GET", "/api/proxy/node_remote/health");

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: "Remote node timeout" });
    expect(mockClose).toHaveBeenCalled();
  });

  // ── Response header filtering ───────────────────────────────────────────

  it("filters hop-by-hop headers from remote response", async () => {
    const remoteNode = makeNode({
      id: "node_remote",
      name: "remote",
      type: "remote",
      url: "http://remote:4040",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeMockFetchResponse({
          status: 200,
          ok: true,
          body: { foo: "bar" },
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            "connection": "keep-alive",
          },
        }),
      ),
    );

    mockGetNode.mockResolvedValue(remoteNode);

    const res = await request(app, "GET", "/api/proxy/node_remote/health");

    expect(res.status).toBe(200);
    // content-type should be forwarded
    expect(res.headers["content-type"]).toBe("application/json");
    // transfer-encoding and connection should NOT be forwarded
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    expect(res.headers["connection"]).toBeUndefined();
    expect(mockClose).toHaveBeenCalled();
  });

  // ── SSE Proxy Route ───────────────────────────────────────────────────

  describe("GET /api/proxy/:nodeId/events", () => {
    it("sets correct SSE headers and streams data", async () => {
      const remoteNode = makeNode({
        id: "node_remote",
        name: "remote",
        type: "remote",
        url: "http://remote:4040",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeMockFetchResponse({
            status: 200,
            ok: true,
            headers: { "content-type": "text/event-stream" },
            streamChunks: [
              'data: {"event":"task:updated"}\n\n',
              'data: {"event":"task:created"}\n\n',
            ],
          }),
        ),
      );

      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(app, "GET", "/api/proxy/node_remote/events");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/event-stream");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.headers["connection"]).toBe("keep-alive");
      expect(res.headers["x-accel-buffering"]).toBe("no");
      expect(mockClose).toHaveBeenCalled();
    });

    it("forwards projectId query param to remote events endpoint", async () => {
      const remoteNode = makeNode({
        id: "node_remote",
        name: "remote",
        type: "remote",
        url: "http://remote:4040",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          makeMockFetchResponse({
            status: 200,
            ok: true,
            headers: { "content-type": "text/event-stream" },
            streamChunks: ["data: ok\n\n"],
          }),
        ),
      );

      mockGetNode.mockResolvedValue(remoteNode);

      await request(app, "GET", "/api/proxy/node_remote/events?projectId=proj_789");

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("http://remote:4040/api/events?projectId=proj_789");
      expect(mockClose).toHaveBeenCalled();
    });

    it("returns 502 when SSE fetch throws TypeError", async () => {
      const remoteNode = makeNode({
        id: "node_remote",
        name: "remote",
        type: "remote",
        url: "http://remote:4040",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("getaddrinfo ENOTFOUND")),
      );

      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(app, "GET", "/api/proxy/node_remote/events");

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Remote node unreachable" });
      expect(mockClose).toHaveBeenCalled();
    });

    it("returns 504 when SSE fetch throws AbortError", async () => {
      const remoteNode = makeNode({
        id: "node_remote",
        name: "remote",
        type: "remote",
        url: "http://remote:4040",
      });

      const abortError = new Error("The user abort");
      abortError.name = "AbortError";

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

      mockGetNode.mockResolvedValue(remoteNode);

      const res = await request(app, "GET", "/api/proxy/node_remote/events");

      expect(res.status).toBe(504);
      expect(res.body).toEqual({ error: "Remote node timeout" });
      expect(mockClose).toHaveBeenCalled();
    });
  });
});

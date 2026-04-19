import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request, get } from "../test-request.js";

// ── Mock @fusion/core for proxy routes ──────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockGetNode = vi.fn();
const mockAgentStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreGetAgent = vi.fn().mockResolvedValue(null);

vi.mock("@fusion/core", () => {
  return {
    CentralCore: class MockCentralCore {
      init = mockInit;
      close = mockClose;
      getNode = mockGetNode;
    },
    ChatStore: class MockChatStore {
      init = vi.fn().mockResolvedValue(undefined);
    },
    AgentStore: class MockAgentStore {
      init = mockAgentStoreInit;
      getAgent = mockAgentStoreGetAgent;
    },
  };
});

// ── Mock Store ──────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-test/.fusion";
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

// ── Test helpers ───────────────────────────────────────────────────

function createMockRemoteNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "remote-node",
    name: "Remote Node",
    type: "remote" as const,
    status: "online" as const,
    url: "http://remote:4040",
    apiKey: undefined as string | undefined,
    maxConcurrent: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockResponse(status: number, headers: Record<string, string>, bodyData?: unknown) {
  const body = bodyData !== undefined
    ? JSON.stringify(bodyData)
    : undefined;
  const stream = body
    ? new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      })
    : null;

  const mockHeaders = new Headers(headers);

  return {
    status,
    headers: mockHeaders,
    body: stream,
    ok: status >= 200 && status < 300,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Proxy routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockGetNode.mockResolvedValue(null);

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/proxy/:nodeId/*", () => {
    it("proxies GET request to remote node successfully", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      const mockResponse = createMockResponse(200, { "content-type": "application/json" }, { ok: true });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await get(app, "/api/proxy/remote-node/browse-directory?path=/");

        expect(res.status).toBe(200);
        expect(mockGetNode).toHaveBeenCalledWith("remote-node");
        expect(mockFetch).toHaveBeenCalledWith(
          "http://remote:4040/browse-directory?path=/",
          expect.objectContaining({
            method: "GET",
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("passes Authorization header when node has apiKey", async () => {
      const node = createMockRemoteNode({ apiKey: "secret-key" });
      mockGetNode.mockResolvedValue(node);

      const mockResponse = createMockResponse(200, { "content-type": "application/json" }, { ok: true });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        await get(app, "/api/proxy/remote-node/browse-directory?path=/");

        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer secret-key",
            }),
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 404 when node not found", async () => {
      mockGetNode.mockResolvedValue(null);

      const res = await get(app, "/api/proxy/unknown-node/some-endpoint");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Node not found" });
    });

    it("returns 400 when node is local (no url)", async () => {
      const node = createMockRemoteNode({ type: "local", url: undefined });
      mockGetNode.mockResolvedValue(node);

      const res = await get(app, "/api/proxy/local-node/some-endpoint");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Node has no URL" });
    });

    it("returns 502 on connection error (TypeError)", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      const mockFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await get(app, "/api/proxy/remote-node/browse-directory");

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: "Bad Gateway" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 504 on timeout/AbortError", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      // Create an AbortError-like DOMException
      const abortError = new DOMException("Aborted", "AbortError");
      const mockFetch = vi.fn().mockRejectedValue(abortError);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await get(app, "/api/proxy/remote-node/browse-directory");

        expect(res.status).toBe(504);
        expect(res.body).toEqual({ error: "Gateway Timeout" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("filters hop-by-hop headers from response", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      const mockResponse = createMockResponse(200, {
        "content-type": "application/json",
        "connection": "keep-alive",
        "transfer-encoding": "chunked",
        "x-custom-header": "value",
      }, { ok: true });

      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await get(app, "/api/proxy/remote-node/browse-directory");

        expect(res.status).toBe(200);
        // Hop-by-hop headers should not be forwarded
        expect(res.headers).not.toHaveProperty("connection");
        expect(res.headers).not.toHaveProperty("transfer-encoding");
        // Custom headers should be forwarded
        expect(res.headers).toHaveProperty("x-custom-header");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("POST /api/proxy/:nodeId/* body forwarding", () => {
    it("forwards POST body with JSON Content-Type", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      const requestBody = JSON.stringify({ key: "value" });
      const rawBody = Buffer.from(requestBody);
      const mockResponse = createMockResponse(200, { "content-type": "application/json" }, { ok: true });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await request(
          app,
          "POST",
          "/api/proxy/remote-node/settings/sync",
          requestBody,
          { "Content-Type": "application/json" },
          rawBody,
        );

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("http://remote:4040/settings/sync"),
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              "Content-Type": "application/json",
            }),
            body: rawBody,
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("forwards POST body with binary Content-Type", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      const requestBody = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      const mockResponse = createMockResponse(200, { "content-type": "application/json" }, { ok: true });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await request(
          app,
          "POST",
          "/api/proxy/remote-node/settings/sync",
          requestBody,
          { "Content-Type": "application/octet-stream" },
          requestBody,
        );

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("http://remote:4040/settings/sync"),
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              "Content-Type": "application/octet-stream",
            }),
            body: requestBody,
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("forwards PUT body with Content-Type", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      const requestBody = JSON.stringify({ key: "value" });
      const rawBody = Buffer.from(requestBody);
      const mockResponse = createMockResponse(200, { "content-type": "application/json" }, { ok: true });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await request(
          app,
          "PUT",
          "/api/proxy/remote-node/settings/sync",
          requestBody,
          { "Content-Type": "application/json" },
          rawBody,
        );

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("http://remote:4040/settings/sync"),
          expect.objectContaining({
            method: "PUT",
            headers: expect.objectContaining({
              "Content-Type": "application/json",
            }),
            body: rawBody,
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("does not set body for GET requests", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      const mockResponse = createMockResponse(200, { "content-type": "application/json" }, { ok: true });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await request(app, "GET", "/api/proxy/remote-node/some/path");

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("http://remote:4040/some/path"),
          expect.objectContaining({ method: "GET" }),
        );
        const fetchOptions = mockFetch.mock.calls[0]?.[1] as { body?: Buffer };
        expect(fetchOptions.body).toBeUndefined();
        expect(res.status).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("forwards POST body with Authorization header when node has apiKey", async () => {
      const node = createMockRemoteNode({ apiKey: "test-key" });
      mockGetNode.mockResolvedValue(node);

      const requestBody = JSON.stringify({ key: "value" });
      const rawBody = Buffer.from(requestBody);
      const mockResponse = createMockResponse(200, { "content-type": "application/json" }, { ok: true });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await request(
          app,
          "POST",
          "/api/proxy/remote-node/settings/sync",
          requestBody,
          { "Content-Type": "application/json" },
          rawBody,
        );

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("http://remote:4040/settings/sync"),
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              "Content-Type": "application/json",
              Authorization: "Bearer test-key",
            }),
            body: rawBody,
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns 502 on upstream error during POST", async () => {
      const node = createMockRemoteNode();
      mockGetNode.mockResolvedValue(node);

      const requestBody = JSON.stringify({ key: "value" });
      const rawBody = Buffer.from(requestBody);
      const mockFetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const res = await request(
          app,
          "POST",
          "/api/proxy/remote-node/settings/sync",
          requestBody,
          { "Content-Type": "application/json" },
          rawBody,
        );

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: "Bad Gateway" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

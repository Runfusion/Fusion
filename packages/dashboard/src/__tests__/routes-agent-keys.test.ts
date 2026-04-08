import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockGetAgent = vi.fn();
const mockCreateApiKey = vi.fn();
const mockListApiKeys = vi.fn();
const mockRevokeApiKey = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue([]);

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      getAgent = mockGetAgent;
      createApiKey = mockCreateApiKey;
      listApiKeys = mockListApiKeys;
      revokeApiKey = mockRevokeApiKey;
      listAgents = mockListAgents;
    },
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1119-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1119-test/.fusion";
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

describe("Agent API key routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /api/agents/:id/keys", () => {
    it("creates a new key and returns { key, token }", async () => {
      mockGetAgent.mockResolvedValue({ id: "agent-001", name: "Agent", role: "executor", state: "idle" });
      mockCreateApiKey.mockResolvedValue({
        key: {
          id: "key-a1b2c3d4",
          agentId: "agent-001",
          tokenHash: "a".repeat(64),
          label: "CI",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        token: "b".repeat(64),
      });

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/keys",
        JSON.stringify({ label: "CI" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect((response.body as any).key.id).toBe("key-a1b2c3d4");
      expect((response.body as any).token).toHaveLength(64);
      expect(mockGetAgent).toHaveBeenCalledWith("agent-001");
      expect(mockCreateApiKey).toHaveBeenCalledWith("agent-001", { label: "CI" });
    });

    it("returns 404 when agent does not exist", async () => {
      mockGetAgent.mockResolvedValue(null);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-404/keys",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Agent not found");
    });
  });

  describe("GET /api/agents/:id/keys", () => {
    it("lists all keys for the agent", async () => {
      mockListApiKeys.mockResolvedValue([
        {
          id: "key-a1b2c3d4",
          agentId: "agent-001",
          tokenHash: "a".repeat(64),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      const response = await request(app, "GET", "/api/agents/agent-001/keys");

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect((response.body as any[])).toHaveLength(1);
      expect(mockListApiKeys).toHaveBeenCalledWith("agent-001");
    });

    it("returns 404 when agent is not found", async () => {
      mockListApiKeys.mockRejectedValue(new Error("Agent agent-404 not found"));

      const response = await request(app, "GET", "/api/agents/agent-404/keys");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("not found");
    });
  });

  describe("DELETE /api/agents/:id/keys/:keyId", () => {
    it("revokes an API key and returns the revoked key", async () => {
      mockRevokeApiKey.mockResolvedValue({
        id: "key-a1b2c3d4",
        agentId: "agent-001",
        tokenHash: "a".repeat(64),
        createdAt: "2026-01-01T00:00:00.000Z",
        revokedAt: "2026-01-02T00:00:00.000Z",
      });

      const response = await request(app, "DELETE", "/api/agents/agent-001/keys/key-a1b2c3d4");

      expect(response.status).toBe(200);
      expect((response.body as any).id).toBe("key-a1b2c3d4");
      expect((response.body as any).revokedAt).toBeDefined();
      expect(mockRevokeApiKey).toHaveBeenCalledWith("agent-001", "key-a1b2c3d4");
    });

    it("returns 404 when key is not found", async () => {
      mockRevokeApiKey.mockRejectedValue(new Error("API key key-missing not found for agent agent-001"));

      const response = await request(app, "DELETE", "/api/agents/agent-001/keys/key-missing");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("not found");
    });
  });
});

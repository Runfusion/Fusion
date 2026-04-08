import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockGetAgent = vi.fn();
const mockGetConfigRevisions = vi.fn();
const mockGetConfigRevision = vi.fn();
const mockRollbackConfig = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue([]);

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      getAgent = mockGetAgent;
      getConfigRevisions = mockGetConfigRevisions;
      getConfigRevision = mockGetConfigRevision;
      rollbackConfig = mockRollbackConfig;
      listAgents = mockListAgents;
    },
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1120-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1120-test/.fusion";
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

function createMockAgent(id = "agent-001") {
  return {
    id,
    name: "Test Agent",
    role: "executor",
    state: "idle",
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createMockRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: "revision-001",
    agentId: "agent-001",
    createdAt: "2026-01-01T00:00:00.000Z",
    before: {
      name: "Agent v1",
      role: "executor",
      metadata: {},
    },
    after: {
      name: "Agent v2",
      role: "executor",
      metadata: {},
    },
    diffs: [{ field: "name", oldValue: "Agent v1", newValue: "Agent v2" }],
    summary: "Updated name",
    source: "user",
    ...overrides,
  };
}

describe("Agent config revision routes", () => {
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

  describe("GET /api/agents/:id/config-revisions", () => {
    it("returns revision array", async () => {
      mockGetAgent.mockResolvedValue(createMockAgent());
      mockGetConfigRevisions.mockResolvedValue([createMockRevision()]);

      const response = await request(app, "GET", "/api/agents/agent-001/config-revisions");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([expect.objectContaining({ id: "revision-001" })]);
      expect(mockGetConfigRevisions).toHaveBeenCalledWith("agent-001", 50);
    });

    it("returns 404 for non-existent agent", async () => {
      mockGetAgent.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-404/config-revisions");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Agent not found");
    });

    it("passes limit query parameter correctly", async () => {
      mockGetAgent.mockResolvedValue(createMockAgent());
      mockGetConfigRevisions.mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/config-revisions?limit=5");

      expect(response.status).toBe(200);
      expect(mockGetConfigRevisions).toHaveBeenCalledWith("agent-001", 5);
    });
  });

  describe("GET /api/agents/:id/config-revisions/:revisionId", () => {
    it("returns a single revision", async () => {
      mockGetAgent.mockResolvedValue(createMockAgent());
      mockGetConfigRevision.mockResolvedValue(createMockRevision());

      const response = await request(app, "GET", "/api/agents/agent-001/config-revisions/revision-001");

      expect(response.status).toBe(200);
      expect((response.body as any).id).toBe("revision-001");
      expect(mockGetConfigRevision).toHaveBeenCalledWith("agent-001", "revision-001");
    });

    it("returns 404 for non-existent revision", async () => {
      mockGetAgent.mockResolvedValue(createMockAgent());
      mockGetConfigRevision.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-001/config-revisions/revision-missing");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Config revision not found");
    });

    it("returns 404 for non-existent agent", async () => {
      mockGetAgent.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-404/config-revisions/revision-001");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Agent not found");
    });
  });

  describe("POST /api/agents/:id/config-revisions/:revisionId/rollback", () => {
    it("returns { agent, revision } on successful rollback", async () => {
      const rollbackRevision = createMockRevision({
        id: "revision-rollback",
        source: "rollback",
        rollbackToRevisionId: "revision-001",
      });
      mockGetAgent.mockResolvedValue(createMockAgent());
      mockRollbackConfig.mockResolvedValue({
        agent: { ...createMockAgent(), name: "Agent v1" },
        revision: rollbackRevision,
      });

      const response = await request(app, "POST", "/api/agents/agent-001/config-revisions/revision-001/rollback");

      expect(response.status).toBe(200);
      expect((response.body as any).agent.name).toBe("Agent v1");
      expect((response.body as any).revision.source).toBe("rollback");
      expect(mockRollbackConfig).toHaveBeenCalledWith("agent-001", "revision-001");
    });

    it("returns 404 for non-existent agent", async () => {
      mockGetAgent.mockResolvedValue(null);

      const response = await request(app, "POST", "/api/agents/agent-404/config-revisions/revision-001/rollback");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Agent not found");
    });

    it("returns 404 for non-existent revision", async () => {
      mockGetAgent.mockResolvedValue(createMockAgent());
      mockRollbackConfig.mockRejectedValue(new Error("Config revision revision-missing not found for agent agent-001"));

      const response = await request(app, "POST", "/api/agents/agent-001/config-revisions/revision-missing/rollback");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("not found");
    });

    it("returns 400 when revision belongs to a different agent", async () => {
      mockGetAgent.mockResolvedValue(createMockAgent());
      mockRollbackConfig.mockRejectedValue(new Error("Config revision revision-002 belongs to agent agent-002"));

      const response = await request(app, "POST", "/api/agents/agent-001/config-revisions/revision-002/rollback");

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("belongs to agent");
    });
  });
});

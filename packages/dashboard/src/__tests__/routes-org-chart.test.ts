import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockGetAgent = vi.fn();
const mockGetChainOfCommand = vi.fn();
const mockGetOrgTree = vi.fn();
const mockResolveAgent = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      getAgent = mockGetAgent;
      getChainOfCommand = mockGetChainOfCommand;
      getOrgTree = mockGetOrgTree;
      resolveAgent = mockResolveAgent;
      listAgents = mockListAgents;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1165-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1165-test/.fusion";
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

function createMockAgent(id: string, name: string, reportsTo?: string) {
  return {
    id,
    name,
    role: "executor",
    state: "idle",
    metadata: {},
    reportsTo,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Agent org chart routes", () => {
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

  describe("GET /api/agents/:id/chain-of-command", () => {
    it("returns chain of command for a valid agent", async () => {
      const self = createMockAgent("agent-001", "Builder Bot", "agent-010");
      const manager = createMockAgent("agent-010", "Manager Bot");
      mockGetAgent.mockResolvedValue(self);
      mockGetChainOfCommand.mockResolvedValue([self, manager]);

      const response = await request(app, "GET", "/api/agents/agent-001/chain-of-command");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([self, manager]);
      expect(mockGetChainOfCommand).toHaveBeenCalledWith("agent-001");
    });

    it("returns 404 when agent is not found", async () => {
      mockGetAgent.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/missing-agent/chain-of-command");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Agent not found");
      expect(mockGetChainOfCommand).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/agents/org-tree", () => {
    it("returns empty array for empty store", async () => {
      mockGetOrgTree.mockResolvedValue([]);
      mockListAgents.mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/org-tree");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it("returns populated org tree", async () => {
      const ceo = createMockAgent("agent-ceo", "CEO Bot");
      const lead = createMockAgent("agent-lead", "Lead Bot", "agent-ceo");
      mockListAgents.mockResolvedValue([ceo, lead]);
      mockGetOrgTree.mockResolvedValue([
        {
          agent: ceo,
          children: [
            {
              agent: lead,
              children: [],
            },
          ],
        },
      ]);

      const response = await request(app, "GET", "/api/agents/org-tree");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        {
          agent: ceo,
          children: [
            {
              agent: lead,
              children: [],
            },
          ],
        },
      ]);
    });
  });

  describe("GET /api/agents/resolve/:shortname", () => {
    it("resolves by shortname", async () => {
      const agent = createMockAgent("agent-001", "Build Agent");
      mockListAgents.mockResolvedValue([agent]);
      mockResolveAgent.mockResolvedValue(agent);

      const response = await request(app, "GET", "/api/agents/resolve/build-agent");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ agent });
      expect(mockResolveAgent).toHaveBeenCalledWith("build-agent");
    });

    it("resolves by ID", async () => {
      const agent = createMockAgent("agent-001", "Build Agent");
      mockListAgents.mockResolvedValue([agent]);
      mockResolveAgent.mockResolvedValue(agent);

      const response = await request(app, "GET", "/api/agents/resolve/agent-001");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ agent });
      expect(mockResolveAgent).toHaveBeenCalledWith("agent-001");
    });

    it("returns 404 when not found", async () => {
      mockListAgents.mockResolvedValue([]);
      mockResolveAgent.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/resolve/missing-agent");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Agent not found");
    });

    it("returns 404 when ambiguous", async () => {
      mockListAgents.mockResolvedValue([
        createMockAgent("agent-001", "Build Agent"),
        createMockAgent("agent-002", "Build Agent"),
      ]);
      mockResolveAgent.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/resolve/build-agent");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Agent not found");
    });
  });
});

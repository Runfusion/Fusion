import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

type AgentRecord = {
  id: string;
  name: string;
  role: "executor" | "reviewer" | "triage" | "merger" | "scheduler" | "engineer" | "custom";
  state: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  reportsTo?: string;
};

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockCreateAgent = vi.fn();
const mockUpdateAgent = vi.fn();
const mockGetAgent = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);

// Import route mocks
const mockParseCompanyDirectory = vi.fn();
const mockParseCompanyArchive = vi.fn();
const mockParseSingleAgentManifest = vi.fn();
const mockPrepareAgentCompaniesImport = vi.fn();

class MockAgentCompaniesParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCompaniesParseError";
  }
}

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      createAgent = mockCreateAgent;
      updateAgent = mockUpdateAgent;
      getAgent = mockGetAgent;
      listAgents = mockListAgents;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
    parseCompanyDirectory: (...args: unknown[]) => mockParseCompanyDirectory(...args),
    parseCompanyArchive: (...args: unknown[]) => mockParseCompanyArchive(...args),
    parseSingleAgentManifest: (...args: unknown[]) => mockParseSingleAgentManifest(...args),
    prepareAgentCompaniesImport: (...args: unknown[]) => mockPrepareAgentCompaniesImport(...args),
    AgentCompaniesParseError: MockAgentCompaniesParseError,
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1812-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1812-test/.fusion";
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

describe("Agent skills routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  let agents: Map<string, AgentRecord>;

  beforeEach(async () => {
    vi.clearAllMocks();
    agents = new Map<string, AgentRecord>();

    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);

    mockCreateAgent.mockImplementation(async (input: any) => {
      const id = `agent-${input.name}`;
      const agent: AgentRecord = {
        id,
        name: input.name,
        role: input.role,
        state: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: input.metadata ?? {},
      };
      agents.set(id, agent);
      return agent;
    });

    mockGetAgent.mockImplementation(async (agentId: string) => {
      return agents.get(agentId) ?? null;
    });

    mockUpdateAgent.mockImplementation(async (agentId: string, updates: Partial<AgentRecord>) => {
      const existing = agents.get(agentId);
      if (!existing) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const updated: AgentRecord = {
        ...existing,
        ...updates,
        updatedAt: "2026-01-02T00:00:00.000Z",
      };

      agents.set(agentId, updated);
      return updated;
    });

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /api/agents", () => {
    it("creates agent with skills", async () => {
      const response = await request(
        app,
        "POST",
        "/api/agents",
        JSON.stringify({
          name: "Skill Agent",
          role: "executor",
          metadata: { skills: ["review", "executor"] },
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Skill Agent",
          role: "executor",
          metadata: { skills: ["review", "executor"] },
        }),
      );
      const body = response.body as AgentRecord;
      expect(body.metadata.skills).toEqual(["review", "executor"]);
    });

    it("creates agent without skills", async () => {
      const response = await request(
        app,
        "POST",
        "/api/agents",
        JSON.stringify({
          name: "Plain Agent",
          role: "executor",
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Plain Agent",
          role: "executor",
        }),
      );
      const body = response.body as AgentRecord;
      expect(body.metadata).toEqual({});
      expect(body.metadata.skills).toBeUndefined();
    });
  });

  describe("PATCH /api/agents/:id", () => {
    it("updates agent skills", async () => {
      agents.set("agent-001", {
        id: "agent-001",
        name: "Agent One",
        role: "executor",
        state: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      });

      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001",
        JSON.stringify({
          metadata: { skills: ["triage"] },
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          metadata: { skills: ["triage"] },
        }),
      );
      const body = response.body as AgentRecord;
      expect(body.metadata.skills).toEqual(["triage"]);
    });

    it("clears agent skills", async () => {
      agents.set("agent-001", {
        id: "agent-001",
        name: "Agent One",
        role: "executor",
        state: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: { skills: ["review"] },
      });

      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001",
        JSON.stringify({
          metadata: { skills: [] },
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          metadata: { skills: [] },
        }),
      );
      const body = response.body as AgentRecord;
      expect(body.metadata.skills).toEqual([]);
    });

    it("accepts invalid skills type and persists as-is", async () => {
      // Document the actual behavior: the route validates metadata is an object
      // but does not deeply validate skills, so a string is accepted
      agents.set("agent-001", {
        id: "agent-001",
        name: "Agent One",
        role: "executor",
        state: "idle",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      });

      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001",
        JSON.stringify({
          metadata: { skills: "not-an-array" },
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        "agent-001",
        expect.objectContaining({
          metadata: { skills: "not-an-array" },
        }),
      );
      const body = response.body as AgentRecord;
      expect(body.metadata.skills).toBe("not-an-array");
    });

    it("returns 400 when metadata is an array", async () => {
      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001",
        JSON.stringify({
          metadata: [{ skills: ["review"] }],
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toBe("metadata must be an object");
      expect(mockUpdateAgent).not.toHaveBeenCalled();
    });

    it("returns 400 when metadata is a primitive", async () => {
      const response = await request(
        app,
        "PATCH",
        "/api/agents/agent-001",
        JSON.stringify({
          metadata: "just-a-string",
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toBe("metadata must be an object");
      expect(mockUpdateAgent).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/agents/import skills round-trip", () => {
    beforeEach(() => {
      // Reset import-specific mocks
      mockParseSingleAgentManifest.mockReset();
      mockPrepareAgentCompaniesImport.mockReset();
    });

    it("preserves skills from import payload through to created agent", async () => {
      mockParseSingleAgentManifest.mockReturnValue({
        manifest: {
          name: "Review Agent",
          title: "Code Reviewer",
          skills: ["review"],
          instructionBody: "Review code changes",
        },
      });

      mockPrepareAgentCompaniesImport.mockReturnValue({
        items: [
          {
            manifestKey: "review-agent",
            aliases: ["review-agent"],
            index: 0,
            input: {
              name: "Review Agent",
              role: "custom",
              title: "Code Reviewer",
              metadata: { skills: ["review"] },
            },
          },
        ],
        result: {
          created: ["Review Agent"],
          skipped: [],
          errors: [],
        },
      });

      const response = await request(
        app,
        "POST",
        "/api/agents/import",
        JSON.stringify({
          manifest: "---\nname: Review Agent\nskills:\n  - review\n---\nReview code changes",
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      const body = response.body as any;
      expect(body.created).toHaveLength(1);
      // The route returns only { id, name } for created agents
      expect(body.created[0].id).toBe("agent-Review Agent");
      expect(body.created[0].name).toBe("Review Agent");
      // Verify the agent was created with the correct metadata via the mock
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Review Agent",
          metadata: expect.objectContaining({ skills: ["review"] }),
        }),
      );
    });

    it("handles agents import with skills in array format", async () => {
      mockPrepareAgentCompaniesImport.mockReturnValue({
        items: [
          {
            manifestKey: "multi-skill-agent",
            aliases: ["multi-skill-agent"],
            index: 0,
            input: {
              name: "Multi Skill Agent",
              role: "executor",
              metadata: { skills: ["review", "executor", "triage"] },
            },
          },
        ],
        result: {
          created: ["Multi Skill Agent"],
          skipped: [],
          errors: [],
        },
      });

      const response = await request(
        app,
        "POST",
        "/api/agents/import",
        JSON.stringify({
          agents: [
            { name: "Multi Skill Agent", skills: ["review", "executor", "triage"] },
          ],
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(mockCreateAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ skills: ["review", "executor", "triage"] }),
        }),
      );
    });
  });
});

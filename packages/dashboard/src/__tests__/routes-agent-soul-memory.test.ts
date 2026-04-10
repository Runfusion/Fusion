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
  soul?: string;
  memory?: string;
};

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockGetAgent = vi.fn();
const mockUpdateAgent = vi.fn();
const mockGetAgentsByReportsTo = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      getAgent = mockGetAgent;
      updateAgent = mockUpdateAgent;
      getAgentsByReportsTo = mockGetAgentsByReportsTo;
      listAgents = mockListAgents;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
  };
});

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1171-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1171-test/.fusion";
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

function createAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-001",
    name: "Agent One",
    role: "executor",
    state: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("Agent soul/memory routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  let agents: Map<string, AgentRecord>;

  beforeEach(async () => {
    vi.clearAllMocks();
    agents = new Map<string, AgentRecord>();

    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);

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

    mockGetAgentsByReportsTo.mockImplementation(async (agentId: string) => {
      return Array.from(agents.values()).filter((agent) => agent.reportsTo === agentId);
    });

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/agents/:id/soul returns null when not set", async () => {
    agents.set("agent-001", createAgent());

    const response = await request(app, "GET", "/api/agents/agent-001/soul");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ soul: null });
  });

  it("GET /api/agents/:id/soul returns text when set", async () => {
    agents.set("agent-001", createAgent({ soul: "Calm, analytical, and direct." }));

    const response = await request(app, "GET", "/api/agents/agent-001/soul");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ soul: "Calm, analytical, and direct." });
  });

  it("PATCH /api/agents/:id/soul updates and returns agent", async () => {
    agents.set("agent-001", createAgent());

    const response = await request(
      app,
      "PATCH",
      "/api/agents/agent-001/soul",
      JSON.stringify({ soul: "Mentoring collaborator with concise feedback." }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((response.body as any).soul).toBe("Mentoring collaborator with concise feedback.");
    expect(mockUpdateAgent).toHaveBeenCalledWith("agent-001", {
      soul: "Mentoring collaborator with concise feedback.",
    });
  });

  it("PATCH /api/agents/:id/soul rejects strings longer than 10,000 chars", async () => {
    agents.set("agent-001", createAgent());

    const response = await request(
      app,
      "PATCH",
      "/api/agents/agent-001/soul",
      JSON.stringify({ soul: "x".repeat(10001) }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect((response.body as any).error).toBe("soul must be at most 10,000 characters");
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it("GET /api/agents/:id/memory returns null when not set", async () => {
    agents.set("agent-001", createAgent());

    const response = await request(app, "GET", "/api/agents/agent-001/memory");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ memory: null });
  });

  it("PATCH /api/agents/:id/memory updates and returns agent", async () => {
    agents.set("agent-001", createAgent());

    const response = await request(
      app,
      "PATCH",
      "/api/agents/agent-001/memory",
      JSON.stringify({ memory: "Prefers minimal examples, avoids long prose unless requested." }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((response.body as any).memory).toBe("Prefers minimal examples, avoids long prose unless requested.");
    expect(mockUpdateAgent).toHaveBeenCalledWith("agent-001", {
      memory: "Prefers minimal examples, avoids long prose unless requested.",
    });
  });

  it("PATCH /api/agents/:id/memory rejects strings longer than 50,000 chars", async () => {
    agents.set("agent-001", createAgent());

    const response = await request(
      app,
      "PATCH",
      "/api/agents/agent-001/memory",
      JSON.stringify({ memory: "x".repeat(50001) }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect((response.body as any).error).toBe("memory must be at most 50,000 characters");
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it("returns 404 for nonexistent agent on soul/memory endpoints", async () => {
    const missingGetSoul = await request(app, "GET", "/api/agents/agent-missing/soul");
    const missingPatchSoul = await request(
      app,
      "PATCH",
      "/api/agents/agent-missing/soul",
      JSON.stringify({ soul: "value" }),
      { "content-type": "application/json" },
    );
    const missingGetMemory = await request(app, "GET", "/api/agents/agent-missing/memory");
    const missingPatchMemory = await request(
      app,
      "PATCH",
      "/api/agents/agent-missing/memory",
      JSON.stringify({ memory: "value" }),
      { "content-type": "application/json" },
    );

    expect(missingGetSoul.status).toBe(404);
    expect(missingPatchSoul.status).toBe(404);
    expect(missingGetMemory.status).toBe(404);
    expect(missingPatchMemory.status).toBe(404);
  });

  it("GET /api/agents/:id/employees returns same payload as /children", async () => {
    agents.set("agent-parent", createAgent({ id: "agent-parent", name: "Parent" }));
    agents.set("agent-child-1", createAgent({ id: "agent-child-1", name: "Child One", reportsTo: "agent-parent" }));
    agents.set("agent-child-2", createAgent({ id: "agent-child-2", name: "Child Two", reportsTo: "agent-parent" }));

    const childrenResponse = await request(app, "GET", "/api/agents/agent-parent/children");
    const employeesResponse = await request(app, "GET", "/api/agents/agent-parent/employees");

    expect(childrenResponse.status).toBe(200);
    expect(employeesResponse.status).toBe(200);
    expect(employeesResponse.body).toEqual(childrenResponse.body);
    expect((employeesResponse.body as any[])).toHaveLength(2);
  });
});

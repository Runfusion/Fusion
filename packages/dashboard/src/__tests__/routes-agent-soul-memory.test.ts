import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");

  return {
    ...actual,
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
  constructor(private readonly rootDir: string) {
    super();
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getFusionDir(): string {
    return join(this.rootDir, ".fusion");
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
  let tempDir: string;

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

    tempDir = mkdtempSync(join(tmpdir(), "fn-2150-agent-memory-routes-"));
    await mkdir(join(tempDir, ".fusion"), { recursive: true });

    store = new MockStore(tempDir);
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  const agentMemoryPath = (agentId: string, fileName: string) => join(tempDir, ".fusion", "agent-memory", agentId, fileName);
  const agentMemoryDisplayPath = (agentId: string, fileName: string) => `.fusion/agent-memory/${agentId}/${fileName}`;

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

  it("GET /api/agents/:id/memory/files returns file list for existing agent", async () => {
    agents.set("agent-001", createAgent());

    const response = await request(app, "GET", "/api/agents/agent-001/memory/files");

    expect(response.status).toBe(200);
    expect((response.body as any).files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: agentMemoryDisplayPath("agent-001", "MEMORY.md"),
        layer: "long-term",
        label: "Long-term memory",
      }),
      expect.objectContaining({
        path: agentMemoryDisplayPath("agent-001", "DREAMS.md"),
        layer: "dreams",
        label: "Dreams",
      }),
      expect.objectContaining({
        path: expect.stringMatching(/^\.fusion\/agent-memory\/agent-001\/\d{4}-\d{2}-\d{2}\.md$/),
        layer: "daily",
      }),
    ]));
  });

  it("GET /api/agents/:id/memory/files returns 404 for nonexistent agent", async () => {
    const response = await request(app, "GET", "/api/agents/agent-missing/memory/files");
    expect(response.status).toBe(404);
  });

  it("GET /api/agents/:id/memory/file?path=... returns file content", async () => {
    agents.set("agent-001", createAgent());

    const filePath = agentMemoryDisplayPath("agent-001", "MEMORY.md");
    await mkdir(join(tempDir, ".fusion", "agent-memory", "agent-001"), { recursive: true });
    await writeFile(agentMemoryPath("agent-001", "MEMORY.md"), "# Agent Memory\n\nRoute read test", "utf-8");

    const response = await request(
      app,
      "GET",
      `/api/agents/agent-001/memory/file?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      path: filePath,
      content: "# Agent Memory\n\nRoute read test",
    });
  });

  it("GET /api/agents/:id/memory/file returns 400 without path param", async () => {
    agents.set("agent-001", createAgent());

    const response = await request(app, "GET", "/api/agents/agent-001/memory/file");

    expect(response.status).toBe(400);
    expect((response.body as any).error).toBe("path is required");
  });

  it("PUT /api/agents/:id/memory/file writes content successfully", async () => {
    agents.set("agent-001", createAgent());

    const path = agentMemoryDisplayPath("agent-001", "2026-04-19.md");
    const content = "# Agent Daily Memory 2026-04-19\n\nSaved via route";

    const response = await request(
      app,
      "PUT",
      "/api/agents/agent-001/memory/file",
      JSON.stringify({ path, content }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(readFileSync(agentMemoryPath("agent-001", "2026-04-19.md"), "utf-8")).toBe(content);
  });

  it("PUT /api/agents/:id/memory/file returns 400 without path or content", async () => {
    agents.set("agent-001", createAgent());

    const missingPath = await request(
      app,
      "PUT",
      "/api/agents/agent-001/memory/file",
      JSON.stringify({ content: "x" }),
      { "content-type": "application/json" },
    );

    const missingContent = await request(
      app,
      "PUT",
      "/api/agents/agent-001/memory/file",
      JSON.stringify({ path: agentMemoryDisplayPath("agent-001", "MEMORY.md") }),
      { "content-type": "application/json" },
    );

    expect(missingPath.status).toBe(400);
    expect((missingPath.body as any).error).toBe("path must be a string");
    expect(missingContent.status).toBe(400);
    expect((missingContent.body as any).error).toBe("content must be a string");
  });

  it("all agent memory file endpoints return 404 for nonexistent agent", async () => {
    const listResponse = await request(app, "GET", "/api/agents/agent-missing/memory/files");
    const getResponse = await request(
      app,
      "GET",
      `/api/agents/agent-missing/memory/file?path=${encodeURIComponent(agentMemoryDisplayPath("agent-missing", "MEMORY.md"))}`,
    );
    const putResponse = await request(
      app,
      "PUT",
      "/api/agents/agent-missing/memory/file",
      JSON.stringify({
        path: agentMemoryDisplayPath("agent-missing", "MEMORY.md"),
        content: "missing",
      }),
      { "content-type": "application/json" },
    );

    expect(listResponse.status).toBe(404);
    expect(getResponse.status).toBe(404);
    expect(putResponse.status).toBe(404);
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

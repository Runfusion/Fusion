// @vitest-environment node

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  const agents = [
    { id: "agent-duplicate-b", name: "Workflow Merger", role: "merger", roles: ["merger"], state: "idle", metadata: {}, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    { id: "agent-duplicate-a", name: "Workflow Merger", role: "merger", roles: ["merger"], state: "idle", metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "agent-unique", name: "Unique Reviewer", role: "reviewer", roles: ["reviewer"], state: "idle", metadata: {}, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
  ];
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  class MockAgentStore {
    async init() {}
    async listAgents() { return agents; }
    async getAgent(id: string) { return agents.find((agent) => agent.id === id) ?? null; }
    async getAgentDetail(id: string) { return agents.find((agent) => agent.id === id) ?? null; }
    async resolveAgent(query: string) {
      const exact = await this.getAgent(query);
      if (exact) return exact;
      const normalizedName = normalize(query);
      const matches = agents.filter((agent) => normalize(agent.name) === normalizedName);
      if (matches.length > 1) {
        throw new actual.AmbiguousAgentNameError(query, normalizedName, matches.map((agent) => agent.id).sort());
      }
      return matches[0] ?? null;
    }
  }
  return { ...actual, AgentStore: MockAgentStore };
});

vi.mock("@fusion/engine", async () => {
  const { createEngineMock } = await import("../../test/mockCoreEngine.js");
  return createEngineMock({
    listCliAdapterDescriptors: () => [],
    createFnAgent: vi.fn(async () => ({ session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() } })),
    createResolvedAgentSession: vi.fn(async () => ({
      session: { state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn() },
      runtimeModel: undefined,
    })),
  });
});

function createStore() {
  return {
    getRootDir: vi.fn().mockReturnValue("/fake/project"),
    getFusionDir: vi.fn().mockReturnValue("/fake/project/.fusion"),
    getAsyncLayer: vi.fn().mockReturnValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getSettingsByScopeFast: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn(),
    getPluginStore: vi.fn().mockReturnValue({ init: vi.fn().mockResolvedValue(undefined), listPlugins: vi.fn().mockResolvedValue([]) }),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogCount: vi.fn().mockResolvedValue(0),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    getTaskDocuments: vi.fn().mockResolvedValue([]),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    getTaskDocumentRevisions: vi.fn().mockResolvedValue([]),
    getAllDocuments: vi.fn().mockResolvedValue([]),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    getMissionStore: vi.fn(),
  } as any;
}

describe("agent identity resolution routes", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(createStore()));
  });

  it("lists duplicate rows and keeps each exact-ID detail route authoritative", async () => {
    const list = await request(app, "GET", "/api/agents");
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string; name: string }>).filter((agent) => agent.name === "Workflow Merger")
      .map((agent) => agent.id).sort()).toEqual(["agent-duplicate-a", "agent-duplicate-b"]);

    for (const id of ["agent-duplicate-a", "agent-duplicate-b"]) {
      const detail = await request(app, "GET", `/api/agents/${id}`);
      expect(detail.status).toBe(200);
      expect((detail.body as { id: string }).id).toBe(id);
    }
  });

  it("returns unique and missing names normally and maps ambiguity to a deterministic 409", async () => {
    const unique = await request(app, "GET", "/api/agents/resolve/unique_reviewer");
    expect(unique.status).toBe(200);
    expect((unique.body as { agent: { id: string } }).agent.id).toBe("agent-unique");

    const missing = await request(app, "GET", "/api/agents/resolve/missing-agent");
    expect(missing.status).toBe(404);

    const ambiguous = await request(app, "GET", "/api/agents/resolve/workflow_merger");
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body).toEqual({
      error: "Ambiguous agent name",
      code: "AMBIGUOUS_AGENT_NAME",
      outcome: "ambiguous",
      query: "workflow_merger",
      normalizedName: "workflow-merger",
      candidateAgentIds: ["agent-duplicate-a", "agent-duplicate-b"],
    });
  });
});

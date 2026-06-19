/*
FNXC:DashboardTests 2026-06-14-09:58:
FN-6444 rescues this server route test from the curated skip-list; the fake SQLite statement returns better-sqlite-style mutation metadata so createServer boot sweeps exercise real startup paths.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";

const mockGetRunDetail = vi.fn();
const mockGetRunAuditEvents = vi.fn();

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    AgentStore: class MockAgentStore {
      init = vi.fn().mockResolvedValue(undefined);
      getRunDetail = mockGetRunDetail;
    },
    ChatStore: class MockChatStore {
      init = vi.fn().mockResolvedValue(undefined);
    },
    deterministicGuardLocks: new Map(),
  };
});

class MockStore {
  getRunAuditEvents = mockGetRunAuditEvents;
  getAgentLogsByTimeRange = vi.fn().mockResolvedValue([]);
  getMutationsForRun = vi.fn().mockResolvedValue([]);
  getRootDir() { return "/tmp/fn-5758-test"; }
  getFusionDir() { return "/tmp/fn-5758-test/.fusion"; }
  getDatabase() { return { exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }) }; }
}

describe("run cited goals route", () => {
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createServer } = await import("../server.js");
    app = createServer(new MockStore() as any);
  });

  it("returns aggregated cited goal ids for a run", async () => {
    mockGetRunDetail.mockResolvedValue({ id: "run-1", agentId: "agent-1", startedAt: "2026-01-01T00:00:00.000Z", status: "done", contextSnapshot: { taskId: "FN-1" } });
    mockGetRunAuditEvents.mockReturnValue([
      { id: "e1", timestamp: "2026-01-01T00:00:00.000Z", runId: "run-1", agentId: "agent-1", domain: "database", mutationType: "goal:injection-applied", target: "FN-1", metadata: { goalIds: ["G-A", "G-B"] } },
      { id: "e2", timestamp: "2026-01-01T00:00:01.000Z", runId: "run-1", agentId: "agent-1", domain: "database", mutationType: "goal:retrieval-invoked", target: "G-C", metadata: { goalIds: ["G-B"] } },
    ]);

    const response = await request(app, "GET", "/api/agents/agent-1/runs/run-1/cited-goals");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      runId: "run-1",
      taskId: "FN-1",
      injectedGoalIds: ["G-A", "G-B"],
      retrievedGoalIds: ["G-B", "G-C"],
      citedGoalIds: ["G-A", "G-B", "G-C"],
    });
  });

  it("returns empty arrays when no goal events exist", async () => {
    mockGetRunDetail.mockResolvedValue({ id: "run-1", agentId: "agent-1", startedAt: "2026-01-01T00:00:00.000Z", status: "done", contextSnapshot: {} });
    mockGetRunAuditEvents.mockReturnValue([]);

    const response = await request(app, "GET", "/api/agents/agent-1/runs/run-1/cited-goals");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      runId: "run-1",
      injectedGoalIds: [],
      retrievedGoalIds: [],
      citedGoalIds: [],
    });
  });

  it("returns 404 for unknown run", async () => {
    mockGetRunDetail.mockResolvedValue(null);
    const response = await request(app, "GET", "/api/agents/agent-1/runs/run-missing/cited-goals");
    expect(response.status).toBe(404);
  });
});

/*
FNXC:DashboardTests 2026-06-14-09:58:
FN-6444 rescues this server route test from the curated skip-list; the fake SQLite statement returns better-sqlite-style mutation metadata so createServer boot sweeps exercise real startup paths.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../test-request.js";

const mockGetRunDetail = vi.fn();
const mockGetRunAuditEvents = vi.fn();

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  AgentStore: class MockAgentStore {
    init = vi.fn().mockResolvedValue(undefined);
    getRunDetail = mockGetRunDetail;
  },
  ChatStore: class MockChatStore {
    init = vi.fn().mockResolvedValue(undefined);
  },
  deterministicGuardLocks: new Map(),
}));

class MockStore {
  getRunAuditEvents = mockGetRunAuditEvents;
  getAgentLogsByTimeRange = vi.fn().mockResolvedValue([]);
  getMutationsForRun = vi.fn().mockResolvedValue([]);
  getRootDir() { return "/tmp/fn-5655-test"; }
  getFusionDir() { return "/tmp/fn-5655-test/.fusion"; }
  getDatabase() { return { exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }) }; }
}

describe("run-audit goal event route filtering", () => {
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createServer } = await import("../server.js");
    app = createServer(new MockStore() as any);
    mockGetRunDetail.mockResolvedValue({ id: "run-1", agentId: "agent-1", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, status: "active", contextSnapshot: { taskId: "FN-1" } });

    const allEvents = [
      { id: "e1", timestamp: "2026-01-01T00:00:00.000Z", runId: "run-1", agentId: "agent-1", domain: "database", mutationType: "goal:injection-applied", target: "FN-1", metadata: { count: 2, lane: "heartbeat" } },
      { id: "e2", timestamp: "2026-01-01T00:05:00.000Z", runId: "run-1", agentId: "agent-1", domain: "database", mutationType: "goal:injection-skipped", target: "goals", metadata: { count: 0, lane: "executor" } },
      { id: "e3", timestamp: "2026-01-01T00:10:00.000Z", runId: "run-1", agentId: "agent-1", domain: "database", mutationType: "goal:retrieval-invoked", target: "goals", metadata: { count: 3, toolName: "fn_goal_list" } },
    ];

    mockGetRunAuditEvents.mockImplementation((filter: { startTime?: string; endTime?: string; domain?: string }) => {
      let events = allEvents;
      if (filter.domain) events = events.filter((event) => event.domain === filter.domain);
      if (filter.startTime) events = events.filter((event) => event.timestamp >= filter.startTime!);
      if (filter.endTime) events = events.filter((event) => event.timestamp <= filter.endTime!);
      return events;
    });
  });

  it("returns only goal events in requested database time window", async () => {
    const response = await request(
      app,
      "GET",
      "/api/agents/agent-1/runs/run-1/audit?domain=database&startTime=2026-01-01T00:04:00.000Z&endTime=2026-01-01T00:06:00.000Z",
    );

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0].mutationType).toBe("goal:injection-skipped");
  });

  it("returns all goal events with mutationType strings preserved", async () => {
    const response = await request(app, "GET", "/api/agents/agent-1/runs/run-1/audit?domain=database");
    expect(response.status).toBe(200);
    expect(response.body.events.map((event: { mutationType: string }) => event.mutationType)).toEqual([
      "goal:injection-applied",
      "goal:injection-skipped",
      "goal:retrieval-invoked",
    ]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

// ── Mock @fusion/core for agent runs ─────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockStartHeartbeatRun = vi.fn();
const mockSaveRun = vi.fn();
const mockGetRecentRuns = vi.fn();
const mockGetRunDetail = vi.fn();
const mockRecordHeartbeat = vi.fn();
const mockUpdateAgentState = vi.fn();
const mockGetAgent = vi.fn();
const mockEndHeartbeatRun = vi.fn();
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockGetActiveHeartbeatRun = vi.fn().mockResolvedValue(null);

// Mock ChatStore methods
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);

// Mock getRunAuditEvents
const mockGetRunAuditEvents = vi.fn().mockReturnValue([]);

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      startHeartbeatRun = mockStartHeartbeatRun;
      saveRun = mockSaveRun;
      getRecentRuns = mockGetRecentRuns;
      getRunDetail = mockGetRunDetail;
      recordHeartbeat = mockRecordHeartbeat;
      updateAgentState = mockUpdateAgentState;
      getAgent = mockGetAgent;
      endHeartbeatRun = mockEndHeartbeatRun;
      listAgents = mockListAgents;
      getActiveHeartbeatRun = mockGetActiveHeartbeatRun;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
  };
});

// ── Mock project-store-resolver ─────────────────────────────────────

const mockGetOrCreateProjectStore = vi.fn();

vi.mock("../project-store-resolver.js", () => ({
  getOrCreateProjectStore: mockGetOrCreateProjectStore,
}));

// ── Mock Store ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TaskStore = any;

class MockStore extends EventEmitter {
  // Mock methods for run-audit and mutations
  getRunAuditEvents = mockGetRunAuditEvents;
  getMutationsForRun = vi.fn().mockResolvedValue([]);
  getAgentLogsByTimeRange = vi.fn().mockResolvedValue([]);

  getRootDir(): string {
    return "/tmp/fn-1059-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1059-test/.fusion";
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

// ── Test helpers ──────────────────────────────────────────────────────

function createMockRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-001",
    agentId: "agent-001",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    status: "active",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Agent runs routes (without HeartbeatMonitor)", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);
    mockGetAgent.mockResolvedValue({ id: "agent-001", state: "running" });
    mockEndHeartbeatRun.mockResolvedValue(undefined);
    mockGetActiveHeartbeatRun.mockResolvedValue(null);

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /api/agents/:id/runs", () => {
    it("returns 201 with run record (fallback behavior without HeartbeatMonitor)", async () => {
      const mockRun = createMockRun();
      mockStartHeartbeatRun.mockResolvedValue(mockRun);
      mockSaveRun.mockResolvedValue(undefined);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/runs",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect((response.body as any).id).toBe("run-001");
      expect((response.body as any).invocationSource).toBe("on_demand");
    });

    it("enriches run with source and triggerDetail from body", async () => {
      const mockRun = createMockRun();
      mockStartHeartbeatRun.mockResolvedValue(mockRun);
      mockSaveRun.mockResolvedValue(undefined);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/runs",
        JSON.stringify({ source: "timer", triggerDetail: "Scheduled check" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect((response.body as any).invocationSource).toBe("timer");
    });

    it("returns 404 when agent not found", async () => {
      mockStartHeartbeatRun.mockRejectedValue(new Error("Agent agent-999 not found"));

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-999/runs",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("not found");
    });
  });

  describe("POST /api/agents/:id/runs/stop", () => {
    it("returns 200 with runId when a run is stopped", async () => {
      const activeRun = createMockRun({ id: "run-001" });
      mockGetActiveHeartbeatRun.mockResolvedValue(activeRun);
      mockGetRunDetail.mockResolvedValue(activeRun);
      mockSaveRun.mockResolvedValue(undefined);
      mockEndHeartbeatRun.mockResolvedValue(undefined);
      mockUpdateAgentState.mockResolvedValue({ id: "agent-001", state: "active" });

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/runs/stop",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, runId: "run-001" });
      expect(mockSaveRun).toHaveBeenCalledWith(expect.objectContaining({
        id: "run-001",
        status: "terminated",
        endedAt: expect.any(String),
      }));
      expect(mockEndHeartbeatRun).toHaveBeenCalledWith("run-001", "terminated");
      expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active");
    });

    it("returns 200 with no active run message when no run exists", async () => {
      mockGetActiveHeartbeatRun.mockResolvedValue(null);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/runs/stop",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, message: "No active run" });
      expect(mockSaveRun).not.toHaveBeenCalled();
      expect(mockEndHeartbeatRun).not.toHaveBeenCalled();
    });

    it("returns 404 when agent not found", async () => {
      mockGetAgent.mockResolvedValue(null);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-404/runs/stop",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("Agent not found");
    });

    it("falls back to direct AgentStore termination when HeartbeatMonitor is unavailable", async () => {
      const activeRun = createMockRun({ id: "run-002" });
      mockGetActiveHeartbeatRun.mockResolvedValue(activeRun);
      mockGetRunDetail.mockResolvedValue(activeRun);
      mockSaveRun.mockResolvedValue(undefined);
      mockEndHeartbeatRun.mockResolvedValue(undefined);
      mockUpdateAgentState.mockResolvedValue({ id: "agent-001", state: "active" });

      await request(
        app,
        "POST",
        "/api/agents/agent-001/runs/stop",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(mockSaveRun).toHaveBeenCalled();
      expect(mockEndHeartbeatRun).toHaveBeenCalledWith("run-002", "terminated");
      expect(mockUpdateAgentState).toHaveBeenCalledWith("agent-001", "active");
    });
  });

  describe("POST /api/agents/:id/heartbeat", () => {
    it("records heartbeat and returns event", async () => {
      const mockEvent = { id: "evt-001", agentId: "agent-001", status: "ok", timestamp: "2026-01-01T00:00:00.000Z" };
      mockRecordHeartbeat.mockResolvedValue(mockEvent);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/heartbeat",
        JSON.stringify({ status: "ok" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).id).toBe("evt-001");
      expect(mockRecordHeartbeat).toHaveBeenCalledWith("agent-001", "ok");
    });

    it("records heartbeat with default status when not provided", async () => {
      const mockEvent = { id: "evt-001", agentId: "agent-001", status: "ok", timestamp: "2026-01-01T00:00:00.000Z" };
      mockRecordHeartbeat.mockResolvedValue(mockEvent);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/heartbeat",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(mockRecordHeartbeat).toHaveBeenCalledWith("agent-001", "ok");
    });

    it("returns 404 when agent not found", async () => {
      mockRecordHeartbeat.mockRejectedValue(new Error("Agent not found"));

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-999/heartbeat",
        JSON.stringify({ status: "ok" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
    });

    it("without HeartbeatMonitor, triggerExecution does nothing extra", async () => {
      const mockEvent = { id: "evt-001", agentId: "agent-001", status: "ok", timestamp: "2026-01-01T00:00:00.000Z" };
      mockRecordHeartbeat.mockResolvedValue(mockEvent);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/heartbeat",
        JSON.stringify({ status: "ok", triggerExecution: true }),
        { "content-type": "application/json" },
      );

      // Returns just the event (no run since no HeartbeatMonitor)
      expect(response.status).toBe(200);
      expect((response.body as any).id).toBe("evt-001");
    });
  });

  describe("GET /api/agents/:id/runs", () => {
    it("returns run list", async () => {
      const mockRuns = [
        createMockRun({ id: "run-001", status: "completed", endedAt: "2026-01-01T00:05:00.000Z" }),
        createMockRun({ id: "run-002", status: "active" }),
      ];
      mockGetRecentRuns.mockResolvedValue(mockRuns);

      const response = await request(app, "GET", "/api/agents/agent-001/runs");

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect((response.body as any[]).length).toBe(2);
    });

    it("respects limit query parameter", async () => {
      mockGetRecentRuns.mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs?limit=5");

      expect(response.status).toBe(200);
      expect(mockGetRecentRuns).toHaveBeenCalledWith("agent-001", 5);
    });
  });

  describe("GET /api/agents/:id/runs/:runId", () => {
    it("returns detailed run", async () => {
      const mockRun = createMockRun({
        id: "run-001",
        status: "completed",
        endedAt: "2026-01-01T00:05:00.000Z",
        stdoutExcerpt: "Task completed successfully",
        usageJson: { inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
      });
      mockGetRunDetail.mockResolvedValue(mockRun);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001");

      expect(response.status).toBe(200);
      expect((response.body as any).id).toBe("run-001");
      expect((response.body as any).stdoutExcerpt).toBe("Task completed successfully");
    });

    it("returns 404 when run not found", async () => {
      mockGetRunDetail.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-999");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toBe("Run not found");
    });
  });
});

describe("Agent runs routes (with HeartbeatMonitor)", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  let mockExecuteHeartbeat: ReturnType<typeof vi.fn>;
  let mockStopRun: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);
    mockGetAgent.mockResolvedValue({ id: "agent-001", state: "running" });
    mockEndHeartbeatRun.mockResolvedValue(undefined);
    mockGetActiveHeartbeatRun.mockResolvedValue(null);

    mockExecuteHeartbeat = vi.fn();
    mockStopRun = vi.fn();

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any, {
      heartbeatMonitor: {
        executeHeartbeat: mockExecuteHeartbeat,
        stopRun: mockStopRun,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST /api/agents/:id/runs", () => {
    it("delegates to heartbeatMonitor.executeHeartbeat when available", async () => {
      const mockRun = createMockRun({ invocationSource: "on_demand", triggerDetail: "Triggered from dashboard" });
      mockExecuteHeartbeat.mockResolvedValue({ ...mockRun, status: "completed" });

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/runs",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect(mockExecuteHeartbeat).toHaveBeenCalledWith({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "Triggered from dashboard",
        taskId: undefined,
        contextSnapshot: {
          wakeReason: "on_demand",
          triggerDetail: "Triggered from dashboard",
        },
      });
    });

    it("passes custom source and triggerDetail to heartbeatMonitor", async () => {
      const mockRun = createMockRun();
      mockExecuteHeartbeat.mockResolvedValue(mockRun);

      await request(
        app,
        "POST",
        "/api/agents/agent-001/runs",
        JSON.stringify({ source: "timer", triggerDetail: "Scheduled run" }),
        { "content-type": "application/json" },
      );

      expect(mockExecuteHeartbeat).toHaveBeenCalledWith({
        agentId: "agent-001",
        source: "timer",
        triggerDetail: "Scheduled run",
        taskId: undefined,
        contextSnapshot: {
          wakeReason: "timer",
          triggerDetail: "Scheduled run",
        },
      });
    });
  });

  describe("POST /api/agents/:id/runs/stop", () => {
    it("calls heartbeatMonitor.stopRun when monitor is available", async () => {
      const activeRun = createMockRun({ id: "run-xyz" });
      mockGetActiveHeartbeatRun.mockResolvedValue(activeRun);
      mockStopRun.mockResolvedValue(undefined);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/runs/stop",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, runId: "run-xyz" });
      expect(mockStopRun).toHaveBeenCalledWith("agent-001");
      expect(mockSaveRun).not.toHaveBeenCalled();
      expect(mockEndHeartbeatRun).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/agents/:id/heartbeat with triggerExecution", () => {
    it("triggers execution when triggerExecution=true and HeartbeatMonitor available", async () => {
      const mockEvent = { id: "evt-001", agentId: "agent-001", status: "ok", timestamp: "2026-01-01T00:00:00.000Z" };
      mockRecordHeartbeat.mockResolvedValue(mockEvent);
      const mockRun = createMockRun({ invocationSource: "on_demand" });
      mockExecuteHeartbeat.mockResolvedValue(mockRun);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/heartbeat",
        JSON.stringify({ status: "ok", triggerExecution: true }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(mockExecuteHeartbeat).toHaveBeenCalledWith({
        agentId: "agent-001",
        source: "on_demand",
        triggerDetail: "Triggered from heartbeat",
        contextSnapshot: {
          wakeReason: "on_demand",
          triggerDetail: "Triggered from heartbeat",
        },
      });
      // Response should include both event and run
      expect((response.body as any).event).toBeDefined();
      expect((response.body as any).run).toBeDefined();
    });
  });

  describe("GET /api/agents/:id/runs/:runId/mutations", () => {
    it("returns mutation trail for a valid run", async () => {
      const mockRun = createMockRun();
      mockGetRunDetail.mockResolvedValue(mockRun);

      // Mock getMutationsForRun on the store
      const mockMutations = [
        { timestamp: "2026-01-01T00:01:00.000Z", action: "Action 1", runContext: { runId: "run-123", agentId: "agent-001" } },
        { timestamp: "2026-01-01T00:02:00.000Z", action: "Action 2", runContext: { runId: "run-123", agentId: "agent-001" } },
      ];
      store.getMutationsForRun = vi.fn().mockResolvedValue(mockMutations);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-123/mutations");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        runId: "run-123",
        mutations: mockMutations,
      });
      expect(store.getMutationsForRun).toHaveBeenCalledWith("run-123");
    });

    it("returns 404 for unknown run", async () => {
      mockGetRunDetail.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-unknown/mutations");

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty("error");
    });

    it("returns empty mutations array for run with no correlated entries", async () => {
      const mockRun = createMockRun();
      mockGetRunDetail.mockResolvedValue(mockRun);

      // Mock getMutationsForRun returning empty array
      store.getMutationsForRun = vi.fn().mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-empty/mutations");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        runId: "run-empty",
        mutations: [],
      });
    });
  });

  describe("GET /api/agents/:id/runs/:runId/audit", () => {
    it("returns normalized audit events for a valid run", async () => {
      const mockRun = createMockRun();
      mockGetRunDetail.mockResolvedValue(mockRun);

      // Mock getRunAuditEvents
      const mockAuditEvents = [
        {
          id: "audit-1",
          timestamp: "2026-01-01T00:01:00.000Z",
          agentId: "agent-001",
          runId: "run-001",
          domain: "database",
          mutationType: "task:update",
          target: "FN-001",
          taskId: "FN-001",
        },
        {
          id: "audit-2",
          timestamp: "2026-01-01T00:02:00.000Z",
          agentId: "agent-001",
          runId: "run-001",
          domain: "git",
          mutationType: "git:commit",
          target: "fusion/FN-001",
        },
      ];
      mockGetRunAuditEvents.mockReturnValue(mockAuditEvents);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/audit");

      expect(response.status).toBe(200);
      expect(response.body.runId).toBe("run-001");
      expect(Array.isArray(response.body.events)).toBe(true);
      expect(response.body.events.length).toBe(2);
      expect(response.body.totalCount).toBe(2);
      expect(response.body.hasMore).toBe(false);
      // Check normalized fields
      expect(response.body.events[0].summary).toBe("DB update (FN-001)");
      expect(response.body.events[1].summary).toBe("Git commit (fusion/FN-001)");
    });

    it("returns 404 for unknown run", async () => {
      mockGetRunDetail.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-unknown/audit");

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty("error");
    });

    it("returns empty events array when no audit events exist", async () => {
      const mockRun = createMockRun();
      mockGetRunDetail.mockResolvedValue(mockRun);
      mockGetRunAuditEvents.mockReturnValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/audit");

      expect(response.status).toBe(200);
      expect(response.body.events).toEqual([]);
      expect(response.body.totalCount).toBe(0);
    });

    it("applies domain filter correctly", async () => {
      const mockRun = createMockRun();
      mockGetRunDetail.mockResolvedValue(mockRun);
      mockGetRunAuditEvents.mockReturnValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/audit?domain=git");

      expect(response.status).toBe(200);
      expect(mockGetRunAuditEvents).toHaveBeenCalledWith(
        expect.objectContaining({ domain: "git" }),
      );
    });

    it("returns 400 for invalid domain filter", async () => {
      const mockRun = createMockRun();
      mockGetRunDetail.mockResolvedValue(mockRun);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/audit?domain=invalid");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("domain must be one of");
    });

    it("returns 400 for invalid limit", async () => {
      const mockRun = createMockRun();
      mockGetRunDetail.mockResolvedValue(mockRun);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/audit?limit=-1");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("limit must be a positive integer");
    });
  });

  describe("GET /api/agents/:id/runs/:runId/timeline", () => {
    it("returns correlated timeline with audit events and logs", async () => {
      const mockRun = createMockRun({
        status: "completed",
        endedAt: "2026-01-01T00:10:00.000Z",
        contextSnapshot: { taskId: "FN-001" },
      });
      mockGetRunDetail.mockResolvedValue(mockRun);

      // Mock audit events
      const mockAuditEvents = [
        {
          id: "audit-1",
          timestamp: "2026-01-01T00:01:00.000Z",
          agentId: "agent-001",
          runId: "run-001",
          domain: "database",
          mutationType: "task:update",
          target: "FN-001",
          taskId: "FN-001",
        },
      ];
      mockGetRunAuditEvents.mockReturnValue(mockAuditEvents);

      // Mock logs
      const mockLogs = [
        { id: "log-1", timestamp: "2026-01-01T00:00:30.000Z", type: "info", message: "Starting task" },
        { id: "log-2", timestamp: "2026-01-01T00:01:30.000Z", type: "info", message: "Task completed" },
      ];
      store.getAgentLogsByTimeRange = vi.fn().mockResolvedValue(mockLogs);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/timeline");

      expect(response.status).toBe(200);
      expect(response.body.run.id).toBe("run-001");
      expect(response.body.run.taskId).toBe("FN-001");
      expect(Array.isArray(response.body.auditByDomain.database)).toBe(true);
      expect(Array.isArray(response.body.auditByDomain.git)).toBe(true);
      expect(Array.isArray(response.body.auditByDomain.filesystem)).toBe(true);
      expect(response.body.auditByDomain.database.length).toBe(1);
      expect(response.body.counts.auditEvents).toBe(1);
      expect(response.body.counts.logEntries).toBe(2);
      expect(Array.isArray(response.body.timeline)).toBe(true);
      expect(response.body.timeline.length).toBe(3); // 1 audit + 2 logs
      // Timeline should be sorted by timestamp
      expect(response.body.timeline[0].type).toBe("log"); // Earlier log
      expect(response.body.timeline[1].type).toBe("audit"); // Audit event
      expect(response.body.timeline[2].type).toBe("log"); // Later log
    });

    it("returns 404 for unknown run", async () => {
      mockGetRunDetail.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-unknown/timeline");

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty("error");
    });

    it("respects includeLogs=false parameter", async () => {
      const mockRun = createMockRun({
        contextSnapshot: { taskId: "FN-001" },
      });
      mockGetRunDetail.mockResolvedValue(mockRun);
      mockGetRunAuditEvents.mockReturnValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/timeline?includeLogs=false");

      expect(response.status).toBe(200);
      expect(response.body.counts.logEntries).toBe(0);
    });

    it("handles empty audit and log results gracefully", async () => {
      const mockRun = createMockRun({
        status: "completed",
        endedAt: "2026-01-01T00:10:00.000Z",
        contextSnapshot: { taskId: "FN-001" },
      });
      mockGetRunDetail.mockResolvedValue(mockRun);
      mockGetRunAuditEvents.mockReturnValue([]);
      store.getAgentLogsByTimeRange = vi.fn().mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/timeline");

      expect(response.status).toBe(200);
      expect(response.body.auditByDomain.database).toEqual([]);
      expect(response.body.auditByDomain.git).toEqual([]);
      expect(response.body.auditByDomain.filesystem).toEqual([]);
      expect(response.body.counts.auditEvents).toBe(0);
      expect(response.body.counts.logEntries).toBe(0);
      expect(response.body.timeline).toEqual([]);
    });

    it("groups audit events by domain correctly", async () => {
      const mockRun = createMockRun();
      mockGetRunDetail.mockResolvedValue(mockRun);

      const mockAuditEvents = [
        {
          id: "audit-db",
          timestamp: "2026-01-01T00:01:00.000Z",
          agentId: "agent-001",
          runId: "run-001",
          domain: "database",
          mutationType: "task:update",
          target: "FN-001",
        },
        {
          id: "audit-git",
          timestamp: "2026-01-01T00:02:00.000Z",
          agentId: "agent-001",
          runId: "run-001",
          domain: "git",
          mutationType: "git:commit",
          target: "branch",
        },
        {
          id: "audit-fs",
          timestamp: "2026-01-01T00:03:00.000Z",
          agentId: "agent-001",
          runId: "run-001",
          domain: "filesystem",
          mutationType: "file:write",
          target: "src/main.ts",
        },
      ];
      mockGetRunAuditEvents.mockReturnValue(mockAuditEvents);
      store.getAgentLogsByTimeRange = vi.fn().mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-001/timeline");

      expect(response.status).toBe(200);
      expect(response.body.auditByDomain.database.length).toBe(1);
      expect(response.body.auditByDomain.git.length).toBe(1);
      expect(response.body.auditByDomain.filesystem.length).toBe(1);
      expect(response.body.counts.auditEvents).toBe(3);
    });

    it("returns 400 for blank runId (URL-encoded space)", async () => {
      const response = await request(app, "GET", "/api/agents/agent-001/runs/%20/audit");
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("runId is required");
    });

    it("returns 400 for whitespace-only runId", async () => {
      const response = await request(app, "GET", "/api/agents/agent-001/runs/%09%09/audit");
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("runId is required");
    });

    it("returns 404 with exact 'Run not found' message for unknown runId", async () => {
      mockGetRunDetail.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-nonexistent/audit");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("Run not found");
    });

    it("handles legacy/partial contextSnapshot (no taskId) without falling back to agent.taskId", async () => {
      // Create a run with no contextSnapshot (legacy/partial context)
      const mockRun = createMockRun({
        id: "run-legacy",
        contextSnapshot: undefined, // No contextSnapshot at all
      });
      mockGetRunDetail.mockResolvedValue(mockRun);
      mockGetRunAuditEvents.mockReturnValue([
        {
          id: "audit-legacy-1",
          timestamp: "2026-01-01T00:01:00.000Z",
          agentId: "agent-001",
          runId: "run-legacy",
          domain: "database",
          mutationType: "task:update",
          target: "FN-001",
          taskId: undefined, // No taskId in event either
        },
      ]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-legacy/audit");

      expect(response.status).toBe(200);
      expect(response.body.runId).toBe("run-legacy");
      expect(Array.isArray(response.body.events)).toBe(true);
      expect(response.body.events.length).toBe(1);
      // Verify the event has undefined taskId, not a fallback value
      expect(response.body.events[0].taskId).toBeUndefined();
      expect(response.body.filters.taskId).toBeUndefined();
    });

    it("handles empty contextSnapshot object (no taskId field) without falling back to agent.taskId", async () => {
      // Create a run with empty contextSnapshot object
      const mockRun = createMockRun({
        id: "run-empty-context",
        contextSnapshot: {}, // Empty object, no taskId
      });
      mockGetRunDetail.mockResolvedValue(mockRun);
      mockGetRunAuditEvents.mockReturnValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-empty-context/audit");

      expect(response.status).toBe(200);
      expect(response.body.runId).toBe("run-empty-context");
      expect(response.body.events).toEqual([]);
      expect(response.body.filters.taskId).toBeUndefined();
    });

    it("asserts deterministic ordering for timeline with duplicate timestamps using sortKey", async () => {
      const mockRun = createMockRun({
        id: "run-dup-ts",
        contextSnapshot: { taskId: "FN-001" },
      });
      mockGetRunDetail.mockResolvedValue(mockRun);

      // Create events with IDENTICAL millisecond timestamps but different IDs
      // This tests the sortKey tie-breaking logic
      const sameTimestamp = "2026-01-01T00:05:00.000Z";
      const mockAuditEvents = [
        {
          id: "audit-d-1",
          timestamp: sameTimestamp,
          agentId: "agent-001",
          runId: "run-dup-ts",
          domain: "database",
          mutationType: "task:update",
          target: "FN-001",
        },
        {
          id: "audit-d-2",
          timestamp: sameTimestamp,
          agentId: "agent-001",
          runId: "run-dup-ts",
          domain: "git",
          mutationType: "git:commit",
          target: "branch-name",
        },
        {
          id: "audit-d-3",
          timestamp: sameTimestamp,
          agentId: "agent-001",
          runId: "run-dup-ts",
          domain: "filesystem",
          mutationType: "file:write",
          target: "src/file.ts",
        },
      ];
      mockGetRunAuditEvents.mockReturnValue(mockAuditEvents);

      // Run multiple times to verify deterministic ordering
      const orderings: string[][] = [];
      for (let i = 0; i < 5; i++) {
        const response = await request(app, "GET", "/api/agents/agent-001/runs/run-dup-ts/timeline");
        expect(response.status).toBe(200);
        const ids = response.body.timeline.map((entry: { audit?: { id: string }; log?: unknown }) =>
          entry.audit?.id ?? "log"
        );
        orderings.push(ids);
      }

      // All orderings should be identical (deterministic)
      for (const ordering of orderings) {
        expect(ordering).toEqual(orderings[0]);
      }

      // Verify sortKey-based tie-breaking: audit events with same timestamp should sort by ID
      const timeline = orderings[0];
      const auditIds = timeline.filter((id: string) => id.startsWith("audit-d-"));
      expect(auditIds.length).toBe(3);
      // The IDs should be in ascending order based on the sortKey (A_timestamp_id format)
      expect(auditIds).toEqual(["audit-d-1", "audit-d-2", "audit-d-3"]);
    });

    it("traces filesystem/file-change audit records in correlated timeline response", async () => {
      const mockRun = createMockRun({
        id: "run-fs-trace",
        contextSnapshot: { taskId: "FN-001" },
      });
      mockGetRunDetail.mockResolvedValue(mockRun);

      // Filesystem event with metadata for traceability
      const mockAuditEvents = [
        {
          id: "audit-fs-1",
          timestamp: "2026-01-01T00:03:00.000Z",
          agentId: "agent-001",
          runId: "run-fs-trace",
          domain: "filesystem",
          mutationType: "file:write",
          target: "src/task-impl.ts",
          metadata: {
            filesChanged: 2,
            paths: ["src/task-impl.ts", "src/task-impl.test.ts"],
            operation: "create",
          },
        },
        {
          id: "audit-fs-2",
          timestamp: "2026-01-01T00:03:01.000Z",
          agentId: "agent-001",
          runId: "run-fs-trace",
          domain: "filesystem",
          mutationType: "file:modify",
          target: "src/task-impl.ts",
          metadata: {
            filesChanged: 1,
            paths: ["src/task-impl.ts"],
            operation: "modify",
          },
        },
      ];
      mockGetRunAuditEvents.mockReturnValue(mockAuditEvents);
      store.getAgentLogsByTimeRange = vi.fn().mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-fs-trace/timeline");

      expect(response.status).toBe(200);

      // Verify filesystem domain grouping
      expect(response.body.auditByDomain.filesystem.length).toBe(2);

      // Verify traceability: each filesystem event should have runId and domain in response
      const fsEntries = response.body.timeline.filter(
        (entry: { type: string; audit?: { domain: string; runId: string } }) =>
          entry.type === "audit" && entry.audit?.domain === "filesystem"
      );
      expect(fsEntries.length).toBe(2);

      // Verify metadata is preserved in the response
      const fsEntry1 = fsEntries.find(
        (entry: { audit?: { id: string } }) => entry.audit?.id === "audit-fs-1"
      );
      expect(fsEntry1).toBeDefined();
      expect(fsEntry1.audit.metadata).toEqual({
        filesChanged: 2,
        paths: ["src/task-impl.ts", "src/task-impl.test.ts"],
        operation: "create",
      });

      // Verify runId correlation is present
      expect(fsEntry1.audit.domain).toBe("filesystem");

      // Verify timeline ordering (filesystem events should be in correct order)
      expect(fsEntries[0].audit.id).toBe("audit-fs-1");
      expect(fsEntries[1].audit.id).toBe("audit-fs-2");
    });

    it("normalizes filesystem events with file-change mutation type", async () => {
      const mockRun = createMockRun({ id: "run-file-change" });
      mockGetRunDetail.mockResolvedValue(mockRun);

      const mockAuditEvents = [
        {
          id: "audit-filechange-1",
          timestamp: "2026-01-01T00:04:00.000Z",
          agentId: "agent-001",
          runId: "run-file-change",
          domain: "filesystem",
          mutationType: "file:change",
          target: "src/main.ts",
          taskId: "FN-001",
          metadata: {
            filesChanged: 5,
            paths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
            operation: "batch-modify",
          },
        },
      ];
      mockGetRunAuditEvents.mockReturnValue(mockAuditEvents);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-file-change/audit");

      expect(response.status).toBe(200);
      expect(response.body.events.length).toBe(1);
      expect(response.body.events[0].domain).toBe("filesystem");
      expect(response.body.events[0].mutationType).toBe("file:change");
      expect(response.body.events[0].metadata).toEqual({
        filesChanged: 5,
        paths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        operation: "batch-modify",
      });
      // Summary should include filesystem domain prefix
      expect(response.body.events[0].summary).toContain("FS");
      expect(response.body.events[0].summary).toContain("change");
    });
  });

  // ── Timeline endpoint additional tests ──────────────────────────────────

  describe("GET /api/agents/:id/runs/:runId/timeline (extended)", () => {
    it("returns 400 for blank runId (URL-encoded space)", async () => {
      const response = await request(app, "GET", "/api/agents/agent-001/runs/%20/timeline");
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("runId is required");
    });

    it("returns 404 with exact 'Run not found' message for unknown runId", async () => {
      mockGetRunDetail.mockResolvedValue(null);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-nonexistent/timeline");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("Run not found");
    });

    it("handles legacy/partial contextSnapshot (no taskId) without falling back to agent.taskId", async () => {
      // Create a run with no contextSnapshot - timeline should still work
      const mockRun = createMockRun({
        id: "run-legacy-tl",
        contextSnapshot: undefined,
      });
      mockGetRunDetail.mockResolvedValue(mockRun);
      mockGetRunAuditEvents.mockReturnValue([]);
      store.getAgentLogsByTimeRange = vi.fn().mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-legacy-tl/timeline");

      expect(response.status).toBe(200);
      expect(response.body.run.id).toBe("run-legacy-tl");
      // taskId should be undefined (no fallback to current agent state)
      expect(response.body.run.taskId).toBeUndefined();
      expect(response.body.timeline).toEqual([]);
    });

    it("verifies timeline sortKey tie-breaking with mixed audit and log entries at same timestamp", async () => {
      const sameTimestamp = "2026-01-01T00:06:00.000Z";
      const mockRun = createMockRun({
        id: "run-mixed-ts",
        startedAt: sameTimestamp,
        contextSnapshot: { taskId: "FN-001" },
      });
      mockGetRunDetail.mockResolvedValue(mockRun);

      // Audit event at timestamp
      const mockAuditEvents = [
        {
          id: "audit-mixed-a",
          timestamp: sameTimestamp,
          agentId: "agent-001",
          runId: "run-mixed-ts",
          domain: "database",
          mutationType: "task:update",
          target: "FN-001",
        },
      ];
      mockGetRunAuditEvents.mockReturnValue(mockAuditEvents);

      // Log entry at EXACT same timestamp (using timestamp as unique key)
      store.getAgentLogsByTimeRange = vi.fn().mockResolvedValue([
        { timestamp: sameTimestamp, type: "info", message: "Log at exact same time" },
      ]);

      const response = await request(app, "GET", "/api/agents/agent-001/runs/run-mixed-ts/timeline");

      expect(response.status).toBe(200);
      expect(response.body.timeline.length).toBe(2);

      // Verify deterministic ordering: audit (A prefix) should come before log (L prefix)
      // SortKey format: "A_timestamp_id" vs "L_timestamp_timestamp"
      // A < L alphabetically, so audit comes first at same timestamp
      expect(response.body.timeline[0].type).toBe("audit");
      expect(response.body.timeline[1].type).toBe("log");

      // Run multiple times to verify determinism
      for (let i = 0; i < 3; i++) {
        const response2 = await request(app, "GET", "/api/agents/agent-001/runs/run-mixed-ts/timeline");
        expect(response2.body.timeline[0].type).toBe("audit");
        expect(response2.body.timeline[1].type).toBe("log");
      }
    });
  });
});

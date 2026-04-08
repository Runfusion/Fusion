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
const mockListAgents = vi.fn().mockResolvedValue([]);
const mockGetActiveHeartbeatRun = vi.fn().mockResolvedValue(null);

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
      listAgents = mockListAgents;
      getActiveHeartbeatRun = mockGetActiveHeartbeatRun;
    },
  };
});

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
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

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockListAgents.mockResolvedValue([]);
    mockGetActiveHeartbeatRun.mockResolvedValue(null);

    mockExecuteHeartbeat = vi.fn();

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any, {
      heartbeatMonitor: {
        executeHeartbeat: mockExecuteHeartbeat,
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
});

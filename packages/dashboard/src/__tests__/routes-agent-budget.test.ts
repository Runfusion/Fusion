import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { get, request } from "../test-request.js";

// ── Mock @fusion/core for budget routes ─────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockGetAgent = vi.fn();
const mockGetBudgetStatus = vi.fn();
const mockResetBudgetUsage = vi.fn();

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      getAgent = mockGetAgent;
      getBudgetStatus = mockGetBudgetStatus;
      resetBudgetUsage = mockResetBudgetUsage;
    },
  };
});

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1265-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1265-test/.fusion";
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

function createMockBudgetStatus(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-001",
    currentUsage: 0,
    budgetLimit: 50000,
    usagePercent: 0,
    isOverBudget: false,
    isOverThreshold: false,
    budgetPeriod: "lifetime" as const,
    lastResetAt: "2026-01-01T00:00:00.000Z",
    nextResetAt: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Agent budget routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockGetAgent.mockResolvedValue({ id: "agent-001", state: "running" });
    mockGetBudgetStatus.mockResolvedValue(createMockBudgetStatus());
    mockResetBudgetUsage.mockResolvedValue(undefined);

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/agents/:id/budget", () => {
    it("returns budget status for agent", async () => {
      const mockStatus = createMockBudgetStatus({
        currentUsage: 40000,
        usagePercent: 80,
        isOverThreshold: true,
      });

      mockGetAgent.mockResolvedValueOnce({ id: "agent-001", state: "running" });
      mockGetBudgetStatus.mockResolvedValueOnce(mockStatus);

      const res = await get(app, "/api/agents/agent-001/budget");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        agentId: "agent-001",
        currentUsage: 40000,
        budgetLimit: 50000,
        usagePercent: 80,
        isOverThreshold: true,
        isOverBudget: false,
      });
    });

    it("returns 404 when agent not found", async () => {
      mockGetAgent.mockResolvedValueOnce(null);

      const res = await get(app, "/api/agents/nonexistent/budget");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: "Agent not found",
      });
    });

    it("returns 500 on unexpected error", async () => {
      mockGetAgent.mockRejectedValueOnce(new Error("Database error"));

      const res = await get(app, "/api/agents/agent-001/budget");

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    });

    it("returns budget status with over-budget flag", async () => {
      const mockStatus = createMockBudgetStatus({
        currentUsage: 55000,
        usagePercent: 110,
        isOverBudget: true,
        isOverThreshold: true,
      });

      mockGetAgent.mockResolvedValueOnce({ id: "agent-001", state: "running" });
      mockGetBudgetStatus.mockResolvedValueOnce(mockStatus);

      const res = await get(app, "/api/agents/agent-001/budget");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        isOverBudget: true,
        isOverThreshold: true,
        usagePercent: 110,
      });
    });

    it("returns budget status with no limit configured", async () => {
      const mockStatus = createMockBudgetStatus({
        budgetLimit: null,
        currentUsage: 10000,
        usagePercent: 0,
      });

      mockGetAgent.mockResolvedValueOnce({ id: "agent-001", state: "running" });
      mockGetBudgetStatus.mockResolvedValueOnce(mockStatus);

      const res = await get(app, "/api/agents/agent-001/budget");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        budgetLimit: null,
        currentUsage: 10000,
      });
    });
  });

  describe("POST /api/agents/:id/budget/reset", () => {
    it("resets budget and returns success", async () => {
      mockGetAgent.mockResolvedValueOnce({ id: "agent-001", state: "running" });
      mockResetBudgetUsage.mockResolvedValueOnce(undefined);

      const res = await request(app, "POST", "/api/agents/agent-001/budget/reset");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockResetBudgetUsage).toHaveBeenCalledWith("agent-001");
    });

    it("returns 404 when agent not found", async () => {
      mockGetAgent.mockResolvedValueOnce(null);

      const res = await request(app, "POST", "/api/agents/nonexistent/budget/reset");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: "Agent not found",
      });
    });

    it("returns 500 on unexpected error", async () => {
      mockGetAgent.mockRejectedValueOnce(new Error("Database error"));

      const res = await request(app, "POST", "/api/agents/agent-001/budget/reset");

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");
    });

    it("calls resetBudgetUsage with correct agent ID", async () => {
      mockGetAgent.mockResolvedValueOnce({ id: "agent-001", state: "running" });
      mockResetBudgetUsage.mockResolvedValueOnce(undefined);

      const res = await request(app, "POST", "/api/agents/agent-001/budget/reset");

      expect(res.status).toBe(200);
      expect(mockResetBudgetUsage).toHaveBeenCalledTimes(1);
      expect(mockResetBudgetUsage).toHaveBeenCalledWith("agent-001");
    });
  });
});

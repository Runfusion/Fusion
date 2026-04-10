import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

// ── Mock @fusion/core for agent ratings ─────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockAddRating = vi.fn();
const mockGetRatings = vi.fn();
const mockGetRatingSummary = vi.fn();
const mockDeleteRating = vi.fn();
const mockChatStoreInit = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", () => {
  return {
    AgentStore: class MockAgentStore {
      init = mockInit;
      addRating = mockAddRating;
      getRatings = mockGetRatings;
      getRatingSummary = mockGetRatingSummary;
      deleteRating = mockDeleteRating;
    },
    ChatStore: class MockChatStore {
      init = mockChatStoreInit;
    },
  };
});

// ── Mock Store ────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-1186-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-1186-test/.fusion";
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

function createMockRating(overrides: Record<string, unknown> = {}) {
  return {
    id: "rating-001",
    agentId: "agent-001",
    score: 5,
    category: "quality",
    comment: "Great work!",
    raterType: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockSummary(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-001",
    averageScore: 4.5,
    totalRatings: 10,
    categoryAverages: {
      quality: 4.8,
      speed: 4.2,
    },
    recentRatings: [],
    trend: "improving" as const,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Agent ratings routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);

    store = new MockStore();
    const { createServer } = await import("../server.js");
    app = createServer(store as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/agents/:id/ratings", () => {
    it("returns ratings array with 200", async () => {
      const mockRatings = [createMockRating(), createMockRating({ id: "rating-002", score: 4 })];
      mockGetRatings.mockResolvedValue(mockRatings);

      const response = await request(app, "GET", "/api/agents/agent-001/ratings");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockRatings);
      expect(mockGetRatings).toHaveBeenCalledWith("agent-001", { limit: 50, category: undefined });
    });

    it("passes limit and category query params to store", async () => {
      mockGetRatings.mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/ratings?limit=10&category=quality");

      expect(response.status).toBe(200);
      expect(mockGetRatings).toHaveBeenCalledWith("agent-001", { limit: 10, category: "quality" });
    });

    it("returns empty array when no ratings exist", async () => {
      mockGetRatings.mockResolvedValue([]);

      const response = await request(app, "GET", "/api/agents/agent-001/ratings");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe("POST /api/agents/:id/ratings", () => {
    it("creates rating with 201, returns the created rating", async () => {
      const mockRating = createMockRating();
      mockAddRating.mockResolvedValue(mockRating);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/ratings",
        JSON.stringify({ score: 5, category: "quality", comment: "Great work!" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect(response.body).toEqual(mockRating);
      expect(mockAddRating).toHaveBeenCalledWith("agent-001", {
        score: 5,
        category: "quality",
        comment: "Great work!",
        runId: undefined,
        taskId: undefined,
        raterType: "user",
      });
    });

    it("defaults raterType to 'user' when not provided in body", async () => {
      const mockRating = createMockRating({ raterType: "user" });
      mockAddRating.mockResolvedValue(mockRating);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/ratings",
        JSON.stringify({ score: 4 }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect(mockAddRating).toHaveBeenCalledWith("agent-001", {
        score: 4,
        category: undefined,
        comment: undefined,
        runId: undefined,
        taskId: undefined,
        raterType: "user",
      });
    });

    it("returns 400 when score is missing", async () => {
      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/ratings",
        JSON.stringify({ category: "quality" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("score is required");
    });

    it("returns 400 when score is not a number between 1 and 5", async () => {
      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/ratings",
        JSON.stringify({ score: 6 }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("score must be a number between 1 and 5");
    });

    it("returns 400 when score is below 1", async () => {
      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/ratings",
        JSON.stringify({ score: 0 }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("score must be a number between 1 and 5");
    });

    it("passes all optional fields through (category, comment, runId, taskId, raterType)", async () => {
      const mockRating = createMockRating();
      mockAddRating.mockResolvedValue(mockRating);

      const response = await request(
        app,
        "POST",
        "/api/agents/agent-001/ratings",
        JSON.stringify({
          score: 5,
          category: "speed",
          comment: "Very fast!",
          runId: "run-123",
          taskId: "task-456",
          raterType: "system",
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect(mockAddRating).toHaveBeenCalledWith("agent-001", {
        score: 5,
        category: "speed",
        comment: "Very fast!",
        runId: "run-123",
        taskId: "task-456",
        raterType: "system",
      });
    });
  });

  describe("GET /api/agents/:id/ratings/summary", () => {
    it("returns summary object with 200", async () => {
      const mockSummary = createMockSummary();
      mockGetRatingSummary.mockResolvedValue(mockSummary);

      const response = await request(app, "GET", "/api/agents/agent-001/ratings/summary");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockSummary);
      expect(mockGetRatingSummary).toHaveBeenCalledWith("agent-001");
    });

    it("returns 500 when store throws an error", async () => {
      mockGetRatingSummary.mockRejectedValue(new Error("Database error"));

      const response = await request(app, "GET", "/api/agents/agent-001/ratings/summary");

      expect(response.status).toBe(500);
    });
  });

  describe("DELETE /api/agents/:id/ratings/:ratingId", () => {
    it("returns 204 on successful deletion", async () => {
      mockDeleteRating.mockResolvedValue(undefined);

      const response = await request(app, "DELETE", "/api/agents/agent-001/ratings/rating-001");

      expect(response.status).toBe(204);
      expect(mockDeleteRating).toHaveBeenCalledWith("rating-001");
    });

    it("returns 500 when store throws an error", async () => {
      mockDeleteRating.mockRejectedValue(new Error("Database error"));

      const response = await request(app, "DELETE", "/api/agents/agent-001/ratings/rating-001");

      expect(response.status).toBe(500);
    });
  });
});

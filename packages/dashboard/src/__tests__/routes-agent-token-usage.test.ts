import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { get } from "../test-request.js";
import { createServer } from "../server.js";

const {
  mockInit,
  mockGetAgent,
  mockAggregateAgentTokenUsage,
  mockIsEphemeralAgent,
  mockChatStoreInit,
} = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockGetAgent: vi.fn(),
  mockAggregateAgentTokenUsage: vi.fn(),
  mockIsEphemeralAgent: vi.fn(),
  mockChatStoreInit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@fusion/core", () => ({
  AgentStore: class MockAgentStore {
    init = mockInit;
    getAgent = mockGetAgent;
  },
  aggregateAgentTokenUsage: mockAggregateAgentTokenUsage,
  isEphemeralAgent: mockIsEphemeralAgent,
  ChatStore: class MockChatStore {
    init = mockChatStoreInit;
  },
  deterministicGuardLocks: new Map(),
}));

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-4388-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-4388-test/.fusion";
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

describe("GET /api/agents/:id/token-usage", () => {
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgent.mockResolvedValue({ id: "agent-001", role: "executor", metadata: {} });
    mockIsEphemeralAgent.mockReturnValue(false);
    mockAggregateAgentTokenUsage.mockResolvedValue({
      agentId: "agent-001",
      role: "executor",
      last24h: { totalInputTokens: 0, totalCachedTokens: 0, totalCacheWriteTokens: 0, totalOutputTokens: 0, nTasks: 0, hitRatio: 0 },
      last7d: { totalInputTokens: 0, totalCachedTokens: 0, totalCacheWriteTokens: 0, totalOutputTokens: 0, nTasks: 0, hitRatio: 0 },
      allTime: { totalInputTokens: 0, totalCachedTokens: 0, totalCacheWriteTokens: 0, totalOutputTokens: 0, nTasks: 0, hitRatio: 0 },
    });

    app = createServer(new MockStore() as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns summary for an existing permanent agent", async () => {
    const res = await get(app, "/api/agents/agent-001/token-usage");
    expect(res.status).toBe(200);
    expect((res.body as any).agentId).toBe("agent-001");
  });

  it("returns 404 when agent is missing", async () => {
    mockGetAgent.mockResolvedValueOnce(null);
    const res = await get(app, "/api/agents/missing/token-usage");
    expect(res.status).toBe(404);
  });

  it("returns 400 for ephemeral agents", async () => {
    mockIsEphemeralAgent.mockReturnValueOnce(true);
    const res = await get(app, "/api/agents/agent-001/token-usage");
    expect(res.status).toBe(400);
    expect((res.body as any).error).toContain("ephemeral");
  });
});

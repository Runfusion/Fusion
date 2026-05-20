import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { get } from "../test-request.js";
import { createServer } from "../server.js";

const {
  mockInit,
  mockGetAgent,
  mockIsEphemeralAgent,
  mockChatStoreInit,
  mockAll,
} = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockGetAgent: vi.fn(),
  mockIsEphemeralAgent: vi.fn(),
  mockChatStoreInit: vi.fn().mockResolvedValue(undefined),
  mockAll: vi.fn(),
}));

vi.mock("@fusion/core", () => ({
  AgentStore: class MockAgentStore {
    init = mockInit;
    getAgent = mockGetAgent;
  },
  isEphemeralAgent: mockIsEphemeralAgent,
  ChatStore: class MockChatStore {
    init = mockChatStoreInit;
  },
  deterministicGuardLocks: new Map(),
}));

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-4400-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-4400-test/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: mockAll,
      }),
    };
  }
}

describe("GET /api/agents/:id/prompt-sizes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgent.mockResolvedValue({ id: "agent-001", role: "executor", metadata: {} });
    mockIsEphemeralAgent.mockReturnValue(false);
    mockAll.mockReturnValue([
      {
        runId: "run-1",
        createdAt: "2026-05-14T00:00:00.000Z",
        systemChars: 120,
        execChars: 880,
        totalChars: 1000,
      },
      {
        runId: "run-2",
        createdAt: "2026-05-13T23:00:00.000Z",
        systemChars: 0,
        execChars: 0,
        totalChars: 0,
      },
    ]);
  });

  it("returns recent prompt size rows", async () => {
    const app = createServer(new MockStore() as any);
    const res = await get(app, "/api/agents/agent-001/prompt-sizes");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ runId: "run-1", totalChars: 1000 }),
      expect.objectContaining({ runId: "run-2", systemChars: 0, execChars: 0, totalChars: 0 }),
    ]);
  });

  it("returns 404 when agent is missing", async () => {
    mockGetAgent.mockResolvedValueOnce(null);
    const app = createServer(new MockStore() as any);
    const res = await get(app, "/api/agents/missing/prompt-sizes");
    expect(res.status).toBe(404);
  });

  it("returns 400 for ephemeral agents", async () => {
    mockIsEphemeralAgent.mockReturnValueOnce(true);
    const app = createServer(new MockStore() as any);
    const res = await get(app, "/api/agents/agent-001/prompt-sizes");
    expect(res.status).toBe(400);
  });
});

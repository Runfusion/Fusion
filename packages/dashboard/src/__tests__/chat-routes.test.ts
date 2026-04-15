import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { request } from "../test-request.js";

// ── Mock Setup ──────────────────────────────────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);

// Create mock functions before vi.mock
const { mockCreateKbAgent, mockChatStreamManager, mockSendMessage } = vi.hoisted(() => {
  // Store subscribers per session for broadcast simulation
  const subscribers = new Map<string, Set<(event: any, eventId?: number) => void>>();

  const chatStreamManager = {
    subscribe: vi.fn((sessionId: string, callback: (event: any, eventId?: number) => void) => {
      if (!subscribers.has(sessionId)) {
        subscribers.set(sessionId, new Set());
      }
      subscribers.get(sessionId)!.add(callback);
      return () => {
        subscribers.get(sessionId)?.delete(callback);
      };
    }),
    broadcast: vi.fn((sessionId: string, event: any) => {
      const callbacks = subscribers.get(sessionId);
      if (callbacks) {
        let eventId = 1;
        for (const callback of callbacks) {
          callback(event, eventId++);
        }
      }
    }),
    getBufferedEvents: vi.fn(() => []),
    cleanupSession: vi.fn((sessionId: string) => {
      subscribers.delete(sessionId);
    }),
    reset: vi.fn(() => {
      subscribers.clear();
    }),
    hasSubscribers: vi.fn((sessionId: string) => {
      return (subscribers.get(sessionId)?.size ?? 0) > 0;
    }),
    getSubscriberCount: vi.fn((sessionId: string) => {
      return subscribers.get(sessionId)?.size ?? 0;
    }),
    // Helper to trigger done event for testing
    __triggerDone: (sessionId: string, messageId: string) => {
      const callbacks = subscribers.get(sessionId);
      if (callbacks) {
        for (const callback of callbacks) {
          callback({ type: "done", data: { messageId } }, 1);
        }
      }
    },
    __triggerError: (sessionId: string, error: string) => {
      const callbacks = subscribers.get(sessionId);
      if (callbacks) {
        for (const callback of callbacks) {
          callback({ type: "error", data: error }, 1);
        }
      }
    },
  };

  return {
    mockCreateKbAgent: vi.fn(),
    mockSendMessage: vi.fn(),
    mockChatStreamManager: chatStreamManager,
  };
});

// Mock @fusion/engine to prevent createKbAgent resolution
vi.mock("@fusion/engine", () => ({
  createKbAgent: mockCreateKbAgent,
}));

// Mock ChatStore
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockListSessions = vi.fn();
const mockUpdateSession = vi.fn();
const mockDeleteSession = vi.fn();
const mockAddMessage = vi.fn();
const mockGetMessages = vi.fn();
const mockGetMessage = vi.fn();

// Mock AgentStore
const mockAgentStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreGetAgent = vi.fn();

// Mock ChatStore class for vi.mock
vi.mock("@fusion/core", () => {
  return {
    ChatStore: class MockChatStore extends EventEmitter {
      init = mockInit;
      createSession = mockCreateSession;
      getSession = mockGetSession;
      listSessions = mockListSessions;
      updateSession = mockUpdateSession;
      deleteSession = mockDeleteSession;
      addMessage = mockAddMessage;
      getMessages = mockGetMessages;
      getMessage = mockGetMessage;
    },
    AgentStore: class MockAgentStore {
      init = mockAgentStoreInit;
      getAgent = mockAgentStoreGetAgent;
    },
  };
});

// Mock chat.js - must mock before importing server
vi.mock("../chat.js", () => {
  return {
    ChatManager: class MockChatManager {
      sendMessage = mockSendMessage;
    },
    chatStreamManager: mockChatStreamManager,
    __setCreateKbAgent: vi.fn(),
    __resetChatState: vi.fn(),
  };
});

// Mock planning.js to prevent initialization
vi.mock("../planning.js", () => {
  return {
    getSession: vi.fn(),
    cleanupSession: vi.fn(),
    __setCreateKbAgent: vi.fn(),
    __resetPlanningState: vi.fn(),
    setAiSessionStore: vi.fn(),
    rehydrateFromStore: vi.fn().mockReturnValue(0),
  };
});

// Mock subtask-breakdown.js
vi.mock("../subtask-breakdown.js", () => {
  return {
    getSubtaskSession: vi.fn(),
    cleanupSubtaskSession: vi.fn(),
    __resetSubtaskState: vi.fn(),
    setAiSessionStore: vi.fn(),
    rehydrateFromStore: vi.fn().mockReturnValue(0),
  };
});

// Mock mission-interview.js
vi.mock("../mission-interview.js", () => {
  return {
    getMissionInterviewSession: vi.fn(),
    cleanupMissionInterviewSession: vi.fn(),
    __resetMissionInterviewState: vi.fn(),
    setAiSessionStore: vi.fn(),
    rehydrateFromStore: vi.fn().mockReturnValue(0),
  };
});

// ── Mock Store ──────────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-chat-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-chat-test/.fusion";
  }

  getKbDir(): string {
    return "/tmp/fn-chat-test/.fusion";
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

// ── Test Helpers ─────────────────────────────────────────────────────────────

// Re-export the instance creator for use in beforeEach
const mockChatStoreInstance = {
  init: mockInit,
  createSession: mockCreateSession,
  getSession: mockGetSession,
  listSessions: mockListSessions,
  updateSession: mockUpdateSession,
  deleteSession: mockDeleteSession,
  addMessage: mockAddMessage,
  getMessages: mockGetMessages,
  getMessage: mockGetMessage,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

function createMockChatManager() {
  return { sendMessage: mockSendMessage };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Chat API Routes", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  let mockChatStore: typeof mockChatStoreInstance;
  let mockChatManager: ReturnType<typeof createMockChatManager>;

  const sampleSession = {
    id: "chat-abc123",
    agentId: "agent-001",
    title: "Test Chat",
    status: "active",
    projectId: null,
    modelProvider: null,
    modelId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const sampleMessage = {
    id: "msg-xyz789",
    sessionId: "chat-abc123",
    role: "user" as const,
    content: "Hello, how are you?",
    thinkingOutput: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
    mockCreateSession.mockReset();
    mockGetSession.mockReset();
    mockListSessions.mockReset();
    mockUpdateSession.mockReset();
    mockDeleteSession.mockReset();
    mockAddMessage.mockReset();
    mockGetMessages.mockReset();
    mockGetMessage.mockReset();
    mockSendMessage.mockReset();
    mockAgentStoreInit.mockResolvedValue(undefined);
    mockAgentStoreGetAgent.mockReset();

    // Setup default mocks
    mockListSessions.mockReturnValue([]);
    mockGetMessages.mockReturnValue([]);

    // Default agent mock - agent with model config
    mockAgentStoreGetAgent.mockResolvedValue({
      id: "agent-001",
      name: "Alpha",
      role: "executor",
      state: "idle",
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
      metadata: {},
      runtimeConfig: {
        model: "anthropic/claude-sonnet-4-5",
      },
    });

    store = new MockStore();
    // Reset and use the shared mock instance
    mockChatStore = mockChatStoreInstance;
    mockChatManager = createMockChatManager();

    const { createServer } = await import("../server.js");
    app = createServer(store as any, {
      chatStore: mockChatStore as any,
      chatManager: mockChatManager as any,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Session CRUD Tests ──────────────────────────────────────────────────────

  describe("GET /api/chat/sessions", () => {
    it("returns all sessions", async () => {
      mockListSessions.mockReturnValue([sampleSession]);

      const response = await request(app, "GET", "/api/chat/sessions");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions).toHaveLength(1);
      expect(mockListSessions).toHaveBeenCalledWith({});
    });

    it("filters by projectId", async () => {
      mockListSessions.mockReturnValue([sampleSession]);

      const response = await request(app, "GET", "/api/chat/sessions?projectId=proj-001");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions).toHaveLength(1);
      expect(mockListSessions).toHaveBeenCalledWith({
        projectId: "proj-001",
      });
    });

    it("filters by status", async () => {
      mockListSessions.mockReturnValue([sampleSession]);

      const response = await request(app, "GET", "/api/chat/sessions?status=archived");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions).toHaveLength(1);
      expect(mockListSessions).toHaveBeenCalledWith({
        status: "archived",
      });
    });

    it("filters by agentId", async () => {
      mockListSessions.mockReturnValue([sampleSession]);

      const response = await request(app, "GET", "/api/chat/sessions?agentId=agent-001");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions).toHaveLength(1);
      expect(mockListSessions).toHaveBeenCalledWith({
        agentId: "agent-001",
      });
    });

    it("returns empty array when no sessions exist", async () => {
      mockListSessions.mockReturnValue([]);

      const response = await request(app, "GET", "/api/chat/sessions");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions).toHaveLength(0);
    });
  });

  describe("POST /api/chat/sessions", () => {
    it("creates session with required fields and resolves model from agent config", async () => {
      mockCreateSession.mockReturnValue(sampleSession);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions",
        JSON.stringify({ agentId: "agent-001" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect((response.body as any).session.id).toBe("chat-abc123");
      // Model is resolved from agent's runtimeConfig.model
      expect(mockCreateSession).toHaveBeenCalledWith({
        agentId: "agent-001",
        title: null,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
    });

    it("creates session with title and resolves model from agent config", async () => {
      const sessionWithOptions = {
        ...sampleSession,
        title: "Custom Title",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      };
      mockCreateSession.mockReturnValue(sessionWithOptions);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions",
        JSON.stringify({
          agentId: "agent-001",
          title: "Custom Title",
        }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect((response.body as any).session.title).toBe("Custom Title");
    });

    it("returns 400 when agentId is missing", async () => {
      const response = await request(
        app,
        "POST",
        "/api/chat/sessions",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("agentId is required");
    });

    it("returns 400 when agentId is empty", async () => {
      const response = await request(
        app,
        "POST",
        "/api/chat/sessions",
        JSON.stringify({ agentId: "   " }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("agentId is required");
    });

    it("returns 404 when agent not found", async () => {
      mockAgentStoreGetAgent.mockResolvedValueOnce(undefined);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions",
        JSON.stringify({ agentId: "nonexistent" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("not found");
    });

    it("creates session with default model when agent has no model config", async () => {
      mockAgentStoreGetAgent.mockResolvedValueOnce({
        id: "agent-002",
        name: "Beta",
        role: "reviewer",
        state: "idle",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
        metadata: {},
        runtimeConfig: {},
      });

      const sessionNoModel = { ...sampleSession, agentId: "agent-002" };
      mockCreateSession.mockReturnValue(sessionNoModel);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions",
        JSON.stringify({ agentId: "agent-002" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      // No model resolved from agent config
      expect(mockCreateSession).toHaveBeenCalledWith({
        agentId: "agent-002",
        title: null,
        modelProvider: null,
        modelId: null,
      });
    });
  });

  describe("GET /api/chat/sessions/:id", () => {
    it("returns session details", async () => {
      mockGetSession.mockReturnValue(sampleSession);

      const response = await request(app, "GET", "/api/chat/sessions/chat-abc123");

      expect(response.status).toBe(200);
      expect((response.body as any).session.id).toBe("chat-abc123");
      expect(mockGetSession).toHaveBeenCalledWith("chat-abc123");
    });

    it("returns 404 when session not found", async () => {
      mockGetSession.mockReturnValue(undefined);

      const response = await request(app, "GET", "/api/chat/sessions/nonexistent");

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("not found");
    });
  });

  describe("PATCH /api/chat/sessions/:id", () => {
    it("updates session title", async () => {
      const updatedSession = { ...sampleSession, title: "Updated Title" };
      mockUpdateSession.mockReturnValue(updatedSession);

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123",
        JSON.stringify({ title: "Updated Title" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).session.title).toBe("Updated Title");
    });

    it("archives session", async () => {
      const archivedSession = { ...sampleSession, status: "archived" as const };
      mockUpdateSession.mockReturnValue(archivedSession);

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123",
        JSON.stringify({ status: "archived" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).session.status).toBe("archived");
    });

    it("returns 400 for invalid status", async () => {
      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123",
        JSON.stringify({ status: "invalid" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("status must be");
    });

    it("returns 404 when session not found", async () => {
      mockUpdateSession.mockReturnValue(undefined);

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/nonexistent",
        JSON.stringify({ title: "New Title" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/chat/sessions/:id", () => {
    it("deletes session", async () => {
      mockDeleteSession.mockReturnValue(true);

      const response = await request(app, "DELETE", "/api/chat/sessions/chat-abc123");

      expect(response.status).toBe(200);
      expect((response.body as any).success).toBe(true);
      expect(mockDeleteSession).toHaveBeenCalledWith("chat-abc123");
    });

    it("returns 404 when session not found", async () => {
      mockDeleteSession.mockReturnValue(false);

      const response = await request(app, "DELETE", "/api/chat/sessions/nonexistent");

      expect(response.status).toBe(404);
    });
  });

  // ── Message CRUD Tests ─────────────────────────────────────────────────────

  describe("GET /api/chat/sessions/:id/messages", () => {
    it("returns messages for session", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessages.mockReturnValue([sampleMessage]);

      const response = await request(app, "GET", "/api/chat/sessions/chat-abc123/messages");

      expect(response.status).toBe(200);
      expect((response.body as any).messages).toHaveLength(1);
      expect(mockGetMessages).toHaveBeenCalledWith("chat-abc123", {
        limit: 50,
        offset: 0,
      });
    });

    it("applies pagination parameters", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessages.mockReturnValue([sampleMessage]);

      const response = await request(
        app,
        "GET",
        "/api/chat/sessions/chat-abc123/messages?limit=10&offset=5",
      );

      expect(response.status).toBe(200);
      expect(mockGetMessages).toHaveBeenCalledWith("chat-abc123", {
        limit: 10,
        offset: 5,
      });
    });

    it("limits max limit to 200", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessages.mockReturnValue([]);

      const response = await request(
        app,
        "GET",
        "/api/chat/sessions/chat-abc123/messages?limit=500",
      );

      expect(response.status).toBe(200);
      expect(mockGetMessages).toHaveBeenCalledWith("chat-abc123", {
        limit: 200,
        offset: 0,
      });
    });

    it("returns 400 for invalid limit", async () => {
      mockGetSession.mockReturnValue(sampleSession);

      const response = await request(
        app,
        "GET",
        "/api/chat/sessions/chat-abc123/messages?limit=-1",
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("limit must be a positive integer");
    });

    it("returns 400 for invalid offset", async () => {
      mockGetSession.mockReturnValue(sampleSession);

      const response = await request(
        app,
        "GET",
        "/api/chat/sessions/chat-abc123/messages?offset=-5",
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("offset must be a non-negative integer");
    });

    it("returns 404 when session not found", async () => {
      mockGetSession.mockReturnValue(undefined);

      const response = await request(app, "GET", "/api/chat/sessions/nonexistent/messages");

      expect(response.status).toBe(404);
    });
  });

  describe("DELETE /api/chat/sessions/:id/messages/:messageId", () => {
    it("deletes message when session exists", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(sampleMessage);

      const response = await request(
        app,
        "DELETE",
        "/api/chat/sessions/chat-abc123/messages/msg-xyz789",
      );

      expect(response.status).toBe(200);
      expect((response.body as any).success).toBe(true);
    });

    it("returns 404 when session not found", async () => {
      mockGetSession.mockReturnValue(undefined);

      const response = await request(
        app,
        "DELETE",
        "/api/chat/sessions/nonexistent/messages/msg-xyz789",
      );

      expect(response.status).toBe(404);
    });

    it("returns 404 when message not found", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(undefined);

      const response = await request(
        app,
        "DELETE",
        "/api/chat/sessions/chat-abc123/messages/nonexistent",
      );

      expect(response.status).toBe(404);
    });
  });

  // ── SSE Streaming Tests ────────────────────────────────────────────────────

  describe("POST /api/chat/sessions/:id/messages (SSE)", () => {
    it("returns 404 when session not found", async () => {
      mockGetSession.mockReturnValue(undefined);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/nonexistent/messages",
        JSON.stringify({ content: "Hello" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
    });

    it("returns 400 when content is empty", async () => {
      mockGetSession.mockReturnValue(sampleSession);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        JSON.stringify({ content: "" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("content is required");
    });

    it("returns 400 when content is whitespace only", async () => {
      mockGetSession.mockReturnValue(sampleSession);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        JSON.stringify({ content: "   " }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("content is required");
    });

    // Skipped: SSE streaming tests require more complex test infrastructure
    // to properly handle SSE stream lifecycle (connect, stream events, disconnect)
    it.skip("returns 400 when modelProvider without modelId (SSE)", async () => {
      mockGetSession.mockReturnValue(sampleSession);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        JSON.stringify({
          content: "Hello",
          modelProvider: "anthropic",
        }),
        { "content-type": "application/json" },
      );

      // SSE stream established with error event
      expect(response.status).toBe(200);
    });

    it.skip("sends message successfully when valid (SSE)", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockAddMessage.mockReturnValue(sampleMessage);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        JSON.stringify({ content: "Hello, how are you?" }),
        { "content-type": "application/json" },
      );

      // SSE stream established with connected event
      expect(response.status).toBe(200);
      expect(mockSendMessage).toHaveBeenCalledWith(
        "chat-abc123",
        "Hello, how are you?",
        undefined,
        undefined,
      );
    });
  });

  // ── Error Handling Tests ───────────────────────────────────────────────────

  describe("Error handling", () => {
    // Skipped: server.ts creates its own ChatStore when none is provided
    // via: const chatStore = options?.chatStore ?? new ChatStore(...)
    it.skip("returns 500 when chat store is not available", async () => {
      const storeWithoutChat = new MockStore();
      const { createServer } = await import("../server.js");
      const appWithoutChat = createServer(storeWithoutChat as any);

      const response = await request(appWithoutChat, "GET", "/api/chat/sessions");

      expect(response.status).toBe(500);
      expect((response.body as any).error).toContain("Chat store not available");
    });
  });
});

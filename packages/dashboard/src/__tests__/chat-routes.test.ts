import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { request } from "../test-request.js";
import { createCoreMock, createEngineMock } from "../test/mockCoreEngine.js";

// ── SSE Test Helpers ────────────────────────────────────────────────────────

/** Create a mock Express request that can fire 'close'. */
function createSSERequest(): Request {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  (emitter as any).query = {};  // required: routes read req.query.projectId
  (emitter as any).headers = {};  // required: routes read req.headers["last-event-id"]
  return emitter as unknown as Request;
}

/** Create a mock Express response with SSE streaming capabilities. */
function createSSEResponse(): {
  res: Response;
  chunks: string[];
} {
  const chunks: string[] = [];
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    end: vi.fn(),
    writableEnded: false,
    destroyed: false,
    getHeaders: vi.fn(() => ({})),
    statusCode: 200,
  } as unknown as Response;

  // Simulate end marking writableEnded
  const originalEnd = res.end;
  res.end = vi.fn((...args: unknown[]) => {
    (res as { writableEnded: boolean }).writableEnded = true;
    return originalEnd.apply(res, args as Parameters<typeof originalEnd>);
  });

  return { res, chunks };
}

// ── Mock Setup ──────────────────────────────────────────────────────────────

const mockInit = vi.fn().mockResolvedValue(undefined);

// Create mock functions before vi.mock
const {
  mockCreateFnAgent,
  mockChatStreamManager,
  mockSendMessage,
  mockCancelGeneration,
  mockBeginGeneration,
  mockIsGenerating,
  mockGetActiveGenerationId,
  mockRewindSessionForEdit,
} = vi.hoisted(() => {
  // Store subscribers per session for broadcast simulation
  const subscribers = new Map<string, Set<{ callback: (event: any, eventId?: number) => void; generationId?: number }>>();

  const chatStreamManager = {
    subscribe: vi.fn((sessionId: string, callback: (event: any, eventId?: number) => void, options?: { generationId?: number }) => {
      if (!subscribers.has(sessionId)) {
        subscribers.set(sessionId, new Set());
      }
      const entry = { callback, generationId: options?.generationId };
      subscribers.get(sessionId)!.add(entry);
      return () => {
        subscribers.get(sessionId)?.delete(entry);
      };
    }),
    broadcast: vi.fn((sessionId: string, event: any, options?: { generationId?: number }) => {
      const callbacks = subscribers.get(sessionId);
      if (callbacks) {
        let eventId = 1;
        for (const { callback, generationId } of callbacks) {
          if (options?.generationId !== undefined && generationId !== undefined && options.generationId !== generationId) {
            continue;
          }
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
        for (const { callback } of callbacks) {
          callback({ type: "done", data: { messageId } }, 1);
        }
      }
    },
    __triggerError: (sessionId: string, error: string) => {
      const callbacks = subscribers.get(sessionId);
      if (callbacks) {
        for (const { callback } of callbacks) {
          callback({ type: "error", data: error }, 1);
        }
      }
    },
  };

  return {
    mockCreateFnAgent: vi.fn(),
    mockSendMessage: vi.fn(),
    mockCancelGeneration: vi.fn(),
    mockBeginGeneration: vi.fn(() => ({ generationId: 1, abortController: new AbortController() })),
    mockIsGenerating: vi.fn(() => false),
    mockGetActiveGenerationId: vi.fn(() => undefined),
    mockRewindSessionForEdit: vi.fn(),
    mockChatStreamManager: chatStreamManager,
  };
});

// Mock @fusion/engine to prevent createFnAgent resolution
vi.mock("@fusion/engine", () => createEngineMock({
  createFnAgent: mockCreateFnAgent,
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
const mockGetLastMessageForSessions = vi.fn().mockReturnValue(new Map());
const mockSearchSessionsByMessageContent = vi.fn().mockReturnValue(new Map());
const mockFindLatestActiveSessionForTarget = vi.fn();
const mockDeleteMessage = vi.fn();
const mockDeleteSessionsForAgentId = vi.fn();

// Mock AgentStore
const mockAgentStoreInit = vi.fn().mockResolvedValue(undefined);
const mockAgentStoreGetAgent = vi.fn();

// Mock ChatStore class for vi.mock
vi.mock("@fusion/core", async (importOriginal) => createCoreMock(
  () => importOriginal<typeof import("@fusion/core")>(),
  {
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
      getLastMessageForSessions = mockGetLastMessageForSessions;
      findLatestActiveSessionForTarget = mockFindLatestActiveSessionForTarget;
      deleteMessage = mockDeleteMessage;
      deleteSessionsForAgentId = mockDeleteSessionsForAgentId;
    },
    AgentStore: class MockAgentStore {
      init = mockAgentStoreInit;
      getAgent = mockAgentStoreGetAgent;
    },
  },
));

// Mock chat.js - must mock before importing server
vi.mock("../chat.js", () => {
  return {
    ChatManager: class MockChatManager {
      sendMessage = mockSendMessage;
      cancelGeneration = mockCancelGeneration;
      beginGeneration = mockBeginGeneration;
      isGenerating = mockIsGenerating;
      getActiveGenerationId = mockGetActiveGenerationId;
      rewindSessionForEdit = mockRewindSessionForEdit;
    },
    chatStreamManager: mockChatStreamManager,
    TASK_PLANNER_CHAT_AGENT_ID_PREFIX: "task-planner:",
    checkRateLimit: vi.fn().mockReturnValue(true),
    getRateLimitResetTime: vi.fn().mockReturnValue(null),
    __setCreateFnAgent: vi.fn(),
    __resetChatState: vi.fn(),
  };
});

// Mock planning.js to prevent initialization
vi.mock("../planning.js", () => {
  return {
    getSession: vi.fn(),
    cleanupSession: vi.fn(),
    __setCreateFnAgent: vi.fn(),
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

// Mock project-store-resolver.js
const mockGetOrCreateProjectStore = vi.fn();
vi.mock("../project-store-resolver.js", () => ({
  getOrCreateProjectStore: mockGetOrCreateProjectStore,
  invalidateAllGlobalSettingsCaches: vi.fn(),
}));

// ── Mock Store ──────────────────────────────────────────────────────────────

class MockStore extends EventEmitter {
  settings = { showTaskChatsInCommonFeed: false };

  async getSettings() {
    return this.settings;
  }

  getRootDir(): string {
    return "/tmp/fn-chat-test";
  }

  getFusionDir(): string {
    return "/tmp/fn-chat-test/.fusion";
  }

  getKbDir(): string {
    return "/tmp/fn-chat-test/.fusion";
  }

  async getTask(id: string) {
    if (id === "FN-MISSING") {
      throw new Error("Task FN-MISSING not found");
    }
    return {
      id,
      title: "Planner task",
      description: "Task description",
      column: "todo",
      status: "planning",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    };
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
  getLastMessageForSessions: mockGetLastMessageForSessions,
  searchSessionsByMessageContent: mockSearchSessionsByMessageContent,
  findLatestActiveSessionForTarget: mockFindLatestActiveSessionForTarget,
  deleteMessage: mockDeleteMessage,
  deleteSessionsForAgentId: mockDeleteSessionsForAgentId,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

function createMockChatManager() {
  return {
    sendMessage: mockSendMessage,
    cancelGeneration: mockCancelGeneration,
    beginGeneration: mockBeginGeneration,
    isGenerating: mockIsGenerating,
    getActiveGenerationId: mockGetActiveGenerationId,
    rewindSessionForEdit: mockRewindSessionForEdit,
  };
}

function makeMultipartMessageRequest(options: {
  fields?: Record<string, string>;
  files?: Array<{ fieldName: string; filename: string; contentType: string; body: Buffer }>;
}): { payload: Buffer; boundary: string } {
  const boundary = `----fn-chat-${Date.now()}`;
  const parts: Buffer[] = [];

  for (const [fieldName, value] of Object.entries(options.fields ?? {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n`));
  }

  for (const file of options.files ?? []) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    parts.push(file.body);
    parts.push(Buffer.from("\r\n"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), boundary };
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
    mockGetLastMessageForSessions.mockReset();
    mockFindLatestActiveSessionForTarget.mockReset();
    mockDeleteMessage.mockReset();
    mockSendMessage.mockReset();
    mockCancelGeneration.mockReset();
    mockIsGenerating.mockReset();
    mockGetActiveGenerationId.mockReset();
    mockRewindSessionForEdit.mockReset();
    mockAgentStoreInit.mockResolvedValue(undefined);
    mockAgentStoreGetAgent.mockReset();
    mockGetOrCreateProjectStore.mockReset();

    // Setup default mocks
    mockListSessions.mockReturnValue([]);
    mockFindLatestActiveSessionForTarget.mockReturnValue(null);
    mockGetMessages.mockReturnValue([]);
    mockGetLastMessageForSessions.mockReturnValue(new Map());
    mockCancelGeneration.mockReturnValue(false);
    mockIsGenerating.mockReturnValue(false);
    mockGetActiveGenerationId.mockReturnValue(undefined);
    mockRewindSessionForEdit.mockResolvedValue({ retained: [] });

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

    // Setup project-store-resolver mock to return the mock store
    mockGetOrCreateProjectStore.mockResolvedValue(store);

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

  describe("POST /api/chat/task-planner/:taskId/session", () => {
    it("creates a task-scoped planner chat session with the planning model override", async () => {
      const created = {
        ...sampleSession,
        id: "chat-planner-001",
        agentId: "task-planner:FN-7310",
        title: "FN-7310 planner chat",
        modelProvider: "anthropic",
        modelId: "claude-plan",
      };
      mockCreateSession.mockReturnValue(created);

      const response = await request(
        app,
        "POST",
        "/api/chat/task-planner/FN-7310/session",
        JSON.stringify({ modelProvider: "anthropic", modelId: "claude-plan" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect((response.body as any).session).toEqual(created);
      expect(mockFindLatestActiveSessionForTarget).toHaveBeenCalledWith({ agentId: "task-planner:FN-7310" });
      expect(mockCreateSession).toHaveBeenCalledWith({
        agentId: "task-planner:FN-7310",
        title: "FN-7310 planner chat",
        projectId: null,
        modelProvider: "anthropic",
        modelId: "claude-plan",
      });
    });

    it("resumes and updates an existing planner chat session", async () => {
      const existing = { ...sampleSession, id: "chat-existing", agentId: "task-planner:FN-7310", modelProvider: null, modelId: null };
      const updated = { ...existing, modelProvider: "openai", modelId: "gpt-plan" };
      mockFindLatestActiveSessionForTarget.mockReturnValue(existing);
      mockUpdateSession.mockReturnValue(updated);

      const response = await request(
        app,
        "POST",
        "/api/chat/task-planner/FN-7310/session?projectId=proj-001",
        JSON.stringify({ modelProvider: "openai", modelId: "gpt-plan" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).session).toEqual(updated);
      expect(mockFindLatestActiveSessionForTarget).toHaveBeenCalledWith({ agentId: "task-planner:FN-7310", projectId: "proj-001" });
      expect(mockUpdateSession).toHaveBeenCalledWith("chat-existing", { modelProvider: "openai", modelId: "gpt-plan" });
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("does not resume another task's planner chat session", async () => {
      const created = {
        ...sampleSession,
        id: "chat-planner-7312",
        agentId: "task-planner:FN-7312",
        title: "FN-7312 planner chat",
      };
      mockFindLatestActiveSessionForTarget.mockImplementation((input: { agentId: string }) => {
        return input.agentId === "task-planner:FN-7311"
          ? { ...sampleSession, id: "chat-planner-7311", agentId: "task-planner:FN-7311" }
          : null;
      });
      mockCreateSession.mockReturnValue(created);

      const response = await request(
        app,
        "POST",
        "/api/chat/task-planner/FN-7312/session",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect((response.body as any).session).toEqual(created);
      expect(mockFindLatestActiveSessionForTarget).toHaveBeenCalledWith({ agentId: "task-planner:FN-7312" });
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        agentId: "task-planner:FN-7312",
        title: "FN-7312 planner chat",
      }));
      expect(mockUpdateSession).not.toHaveBeenCalled();
    });

    it("rejects incomplete model override pairs", async () => {
      const response = await request(
        app,
        "POST",
        "/api/chat/task-planner/FN-7310/session",
        JSON.stringify({ modelProvider: "anthropic" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("Both modelProvider and modelId");
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("returns not found for missing tasks in the scoped project store", async () => {
      const response = await request(
        app,
        "POST",
        "/api/chat/task-planner/FN-MISSING/session",
        JSON.stringify({ modelProvider: "anthropic", modelId: "claude-plan" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
      expect((response.body as any).error).toContain("Task FN-MISSING not found");
    });

    it("resumes an existing planner chat for a done task without creating a new one", async () => {
      vi.spyOn(store, "getTask").mockResolvedValueOnce({
        id: "FN-DONE",
        title: "Done planner task",
        description: "Task description",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      } as any);
      const existing = { ...sampleSession, id: "chat-done-planner", agentId: "task-planner:FN-DONE" };
      mockFindLatestActiveSessionForTarget.mockReturnValue(existing);

      const response = await request(
        app,
        "POST",
        "/api/chat/task-planner/FN-DONE/session",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).session).toEqual(existing);
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("creates a new planner chat for a done task without existing history", async () => {
      vi.spyOn(store, "getTask").mockResolvedValueOnce({
        id: "FN-DONE-EMPTY",
        title: "Done planner task",
        description: "Task description",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      } as any);
      const created = { ...sampleSession, id: "chat-done-created", agentId: "task-planner:FN-DONE-EMPTY", title: "FN-DONE-EMPTY planner chat" };
      mockFindLatestActiveSessionForTarget.mockReturnValue(null);
      mockCreateSession.mockReturnValue(created);

      const doneResponse = await request(
        app,
        "POST",
        "/api/chat/task-planner/FN-DONE-EMPTY/session",
        JSON.stringify({ modelProvider: "anthropic", modelId: "claude-plan" }),
        { "content-type": "application/json" },
      );

      expect(doneResponse.status).toBe(201);
      expect((doneResponse.body as any).session).toEqual(created);
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        agentId: "task-planner:FN-DONE-EMPTY",
        title: "FN-DONE-EMPTY planner chat",
        modelProvider: "anthropic",
        modelId: "claude-plan",
      }));
    });

    it("continues to reject starting a new planner chat for archived tasks", async () => {
      vi.spyOn(store, "getTask").mockResolvedValueOnce({
        id: "FN-ARCHIVED-EMPTY",
        title: "Archived planner task",
        description: "Task description",
        column: "archived",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      } as any);
      mockFindLatestActiveSessionForTarget.mockReturnValue(null);

      const archivedResponse = await request(
        app,
        "POST",
        "/api/chat/task-planner/FN-ARCHIVED-EMPTY/session",
        JSON.stringify({}),
        { "content-type": "application/json" },
      );

      expect(archivedResponse.status).toBe(400);
      expect((archivedResponse.body as any).error).toContain("planner chat cannot be started for archived tasks");
      expect(mockCreateSession).not.toHaveBeenCalled();
    });
  });

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

    it("enriches sessions with lastMessagePreview and lastMessageAt", async () => {
      const sessionWithId = { ...sampleSession, id: "chat-abc123" };
      mockListSessions.mockReturnValue([sessionWithId]);

      // Mock last message for the session
      const mockLastMessage = {
        id: "msg-001",
        sessionId: "chat-abc123",
        role: "assistant",
        content: "Hello, how can I help you?",
        thinkingOutput: null,
        metadata: null,
        createdAt: "2026-04-15T10:00:00.000Z",
      };
      mockGetLastMessageForSessions.mockReturnValue(
        new Map([["chat-abc123", mockLastMessage]]),
      );

      const response = await request(app, "GET", "/api/chat/sessions");

      expect(response.status).toBe(200);
      expect(mockGetLastMessageForSessions).toHaveBeenCalledWith(["chat-abc123"]);
      const enrichedSession = (response.body as any).sessions[0];
      expect(enrichedSession.lastMessagePreview).toBe("Hello, how can I help you?");
      expect(enrichedSession.lastMessageAt).toBe("2026-04-15T10:00:00.000Z");
    });

    it("truncates long lastMessagePreview to 100 chars", async () => {
      const sessionWithId = { ...sampleSession, id: "chat-abc123" };
      mockListSessions.mockReturnValue([sessionWithId]);

      // Mock a long message
      const longContent = "A".repeat(150);
      const mockLastMessage = {
        id: "msg-001",
        sessionId: "chat-abc123",
        role: "assistant",
        content: longContent,
        thinkingOutput: null,
        metadata: null,
        createdAt: "2026-04-15T10:00:00.000Z",
      };
      mockGetLastMessageForSessions.mockReturnValue(
        new Map([["chat-abc123", mockLastMessage]]),
      );

      const response = await request(app, "GET", "/api/chat/sessions");

      expect(response.status).toBe(200);
      const enrichedSession = (response.body as any).sessions[0];
      expect(enrichedSession.lastMessagePreview).toBe("A".repeat(100) + "…");
      expect(enrichedSession.lastMessagePreview).toHaveLength(101);
    });

    it("does not add lastMessagePreview when session has no messages", async () => {
      const sessionWithId = { ...sampleSession, id: "chat-abc123" };
      mockListSessions.mockReturnValue([sessionWithId]);

      // No messages for this session
      mockGetLastMessageForSessions.mockReturnValue(new Map());

      const response = await request(app, "GET", "/api/chat/sessions");

      expect(response.status).toBe(200);
      const enrichedSession = (response.body as any).sessions[0];
      expect(enrichedSession.lastMessagePreview).toBeUndefined();
      expect(enrichedSession.lastMessageAt).toBeUndefined();
    });

    it("hides empty planner-chat sessions but keeps normal direct sessions in the global list", async () => {
      const normalSession = { ...sampleSession, id: "chat-normal", agentId: "agent-001" };
      const emptyPlanner = { ...sampleSession, id: "chat-empty-planner", agentId: "task-planner:FN-7337" };
      mockListSessions.mockReturnValue([normalSession, emptyPlanner]);
      mockGetLastMessageForSessions.mockReturnValue(new Map());

      const response = await request(app, "GET", "/api/chat/sessions");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions.map((session: any) => session.id)).toEqual(["chat-normal"]);
    });

    it("hides populated planner-chat sessions in the global list by default", async () => {
      const normalSession = { ...sampleSession, id: "chat-normal", agentId: "agent-001" };
      const populatedPlanner = { ...sampleSession, id: "chat-planner", agentId: "task-planner:FN-7337" };
      const plannerMessage = {
        id: "msg-planner",
        sessionId: "chat-planner",
        role: "user",
        content: "What should happen next?",
        thinkingOutput: null,
        metadata: null,
        createdAt: "2026-06-30T18:35:00.000Z",
      };
      mockListSessions.mockReturnValue([normalSession, populatedPlanner]);
      mockGetLastMessageForSessions.mockReturnValue(new Map([["chat-planner", plannerMessage]]));

      const response = await request(app, "GET", "/api/chat/sessions");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions.map((session: any) => session.id)).toEqual(["chat-normal"]);
    });

    it("shows populated planner-chat sessions in the global list only when the project opts in", async () => {
      store.settings.showTaskChatsInCommonFeed = true;
      const normalSession = { ...sampleSession, id: "chat-normal", agentId: "agent-001" };
      const populatedPlanner = { ...sampleSession, id: "chat-planner", agentId: "task-planner:FN-7337" };
      const duplicatePlanner = { ...sampleSession, id: "chat-planner-older", agentId: "task-planner:FN-7337" };
      const emptyPlanner = { ...sampleSession, id: "chat-empty-planner", agentId: "task-planner:FN-7338" };
      const plannerMessage = {
        id: "msg-planner",
        sessionId: "chat-planner",
        role: "user",
        content: "What should happen next?",
        thinkingOutput: null,
        metadata: null,
        createdAt: "2026-06-30T18:35:00.000Z",
      };
      const duplicateMessage = {
        ...plannerMessage,
        id: "msg-planner-older",
        sessionId: "chat-planner-older",
        content: "Earlier planning note",
      };
      mockListSessions.mockReturnValue([normalSession, populatedPlanner, duplicatePlanner, emptyPlanner]);
      mockGetLastMessageForSessions.mockReturnValue(new Map([
        ["chat-planner", plannerMessage],
        ["chat-planner-older", duplicateMessage],
      ]));

      const response = await request(app, "GET", "/api/chat/sessions");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions.map((session: any) => session.id)).toEqual(["chat-normal", "chat-planner", "chat-planner-older"]);
      expect((response.body as any).sessions[1].lastMessagePreview).toBe("What should happen next?");
      expect((response.body as any).sessions[2].lastMessagePreview).toBe("Earlier planning note");
    });

    it("uses the requested project's setting when deciding whether planner-chat sessions appear", async () => {
      const { createServer } = await import("../server.js");
      const populatedPlanner = { ...sampleSession, id: "chat-planner", agentId: "task-planner:FN-7337", projectId: "proj-secondary" };
      const plannerMessage = {
        id: "msg-planner",
        sessionId: "chat-planner",
        role: "user",
        content: "Project scoped planning",
        thinkingOutput: null,
        metadata: null,
        createdAt: "2026-06-30T18:35:00.000Z",
      };
      const engineListSessions = vi.fn().mockReturnValue([populatedPlanner]);
      const engineChatStore = {
        ...mockChatStoreInstance,
        listSessions: engineListSessions,
        getLastMessageForSessions: vi.fn().mockReturnValue(new Map([["chat-planner", plannerMessage]])),
      };
      const secondaryStore = new MockStore();
      secondaryStore.settings.showTaskChatsInCommonFeed = true;
      const mockEngine = { getTaskStore: () => secondaryStore, getChatStore: () => engineChatStore };
      const mockEngineManager = {
        getEngine: vi.fn((id: string) => (id === "proj-secondary" ? mockEngine : undefined)),
        getAllEngines: vi.fn().mockReturnValue(new Map([["proj-secondary", mockEngine]])),
      };
      const appWithEngine = createServer(store as any, {
        chatStore: mockChatStore as any,
        chatManager: mockChatManager as any,
        engineManager: mockEngineManager as any,
      });

      const response = await request(appWithEngine, "GET", "/api/chat/sessions?projectId=proj-secondary");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions.map((session: any) => session.id)).toEqual(["chat-planner"]);
      expect(engineListSessions).toHaveBeenCalledWith({ projectId: "proj-secondary" });
    });

    it("preserves explicit planner resume lookup even when the session has no messages", async () => {
      const emptyPlanner = { ...sampleSession, id: "chat-empty-planner", agentId: "task-planner:FN-7337" };
      mockFindLatestActiveSessionForTarget.mockReturnValue(emptyPlanner);
      mockGetLastMessageForSessions.mockReturnValue(new Map());

      const response = await request(app, "GET", "/api/chat/sessions?lookup=resume&agentId=task-planner%3AFN-7337");

      expect(response.status).toBe(200);
      expect((response.body as any).sessions.map((session: any) => session.id)).toEqual(["chat-empty-planner"]);
    });

    it("uses engine chatStore when engineManager is configured for requested projectId", async () => {
      const { createServer } = await import("../server.js");

      // Engine-scoped chatStore — simulates a secondary project's DB
      const engineListSessions = vi.fn().mockReturnValue([sampleSession]);
      const engineChatStore = {
        ...mockChatStoreInstance,
        listSessions: engineListSessions,
        getLastMessageForSessions: vi.fn().mockReturnValue(new Map()),
      };
      const mockEngine = { getChatStore: () => engineChatStore };
      const mockEngineManager = {
        getEngine: vi.fn((id: string) => (id === "proj-secondary" ? mockEngine : undefined)),
        getAllEngines: vi.fn().mockReturnValue(new Map([["proj-secondary", mockEngine]])),
      };

      const appWithEngine = createServer(store as any, {
        chatStore: mockChatStore as any,
        chatManager: mockChatManager as any,
        engineManager: mockEngineManager as any,
      });

      const response = await request(appWithEngine, "GET", "/api/chat/sessions?projectId=proj-secondary");

      expect(response.status).toBe(200);
      // Engine chatStore was used, not the default one
      expect(engineListSessions).toHaveBeenCalled();
      expect(mockListSessions).not.toHaveBeenCalled();
    });

    it("falls back to default chatStore when no engineManager is configured", async () => {
      mockListSessions.mockReturnValue([sampleSession]);

      // app has no engineManager (the default setup)
      const response = await request(app, "GET", "/api/chat/sessions?projectId=proj-001");

      expect(response.status).toBe(200);
      expect(mockListSessions).toHaveBeenCalledWith({ projectId: "proj-001" });
    });

    describe("content search (q / titleOnly)", () => {
      it("narrows results to content-matched sessions and attaches matchedMessagePreview", async () => {
        const matchSession = { ...sampleSession, id: "chat-match" };
        const noMatchSession = { ...sampleSession, id: "chat-no-match" };
        mockListSessions.mockReturnValue([matchSession, noMatchSession]);
        mockGetLastMessageForSessions.mockReturnValue(new Map());
        mockSearchSessionsByMessageContent.mockReturnValue(new Map([["chat-match", "found the roadmap here"]]));

        const response = await request(app, "GET", "/api/chat/sessions?q=roadmap");

        expect(response.status).toBe(200);
        expect(mockSearchSessionsByMessageContent).toHaveBeenCalledWith("roadmap", ["chat-match", "chat-no-match"]);
        const body = (response.body as any).sessions;
        expect(body.map((s: any) => s.id)).toEqual(["chat-match"]);
        expect(body[0].matchedMessagePreview).toBe("found the roadmap here");
      });

      it("ignores content search and preserves current behavior when titleOnly=true", async () => {
        mockListSessions.mockReturnValue([sampleSession]);
        mockGetLastMessageForSessions.mockReturnValue(new Map());

        const response = await request(app, "GET", "/api/chat/sessions?q=roadmap&titleOnly=true");

        expect(response.status).toBe(200);
        expect(mockSearchSessionsByMessageContent).not.toHaveBeenCalled();
        expect((response.body as any).sessions).toHaveLength(1);
      });

      it("performs no content search when q is absent (unchanged default behavior)", async () => {
        mockListSessions.mockReturnValue([sampleSession]);
        mockGetLastMessageForSessions.mockReturnValue(new Map());

        const response = await request(app, "GET", "/api/chat/sessions");

        expect(response.status).toBe(200);
        expect(mockSearchSessionsByMessageContent).not.toHaveBeenCalled();
        expect((response.body as any).sessions).toHaveLength(1);
      });

      it("keeps task-planner sessions excluded from content matches when the setting is off", async () => {
        const plannerMatch = { ...sampleSession, id: "chat-planner", agentId: "task-planner:FN-7337" };
        mockListSessions.mockReturnValue([plannerMatch]);
        mockGetLastMessageForSessions.mockReturnValue(new Map());
        mockSearchSessionsByMessageContent.mockReturnValue(new Map([["chat-planner", "secret plan"]]));

        const response = await request(app, "GET", "/api/chat/sessions?q=secret");

        expect(response.status).toBe(200);
        // Task-planner filter runs before content search narrowing, so the planner session
        // never reaches searchSessionsByMessageContent and is excluded from the response.
        expect((response.body as any).sessions).toHaveLength(0);
      });

      it("handles injection-style q values (%, ') safely and passes them through verbatim", async () => {
        mockListSessions.mockReturnValue([sampleSession]);
        mockGetLastMessageForSessions.mockReturnValue(new Map());
        mockSearchSessionsByMessageContent.mockReturnValue(new Map());

        const response = await request(app, "GET", `/api/chat/sessions?q=${encodeURIComponent("50%' OR 1=1--")}`);

        expect(response.status).toBe(200);
        expect(mockSearchSessionsByMessageContent).toHaveBeenCalledWith("50%' OR 1=1--", [sampleSession.id]);
        expect((response.body as any).sessions).toHaveLength(0);
      });

      it("does not run content search for lookup=resume", async () => {
        mockFindLatestActiveSessionForTarget.mockReturnValue(sampleSession);
        mockGetLastMessageForSessions.mockReturnValue(new Map());

        const response = await request(app, "GET", "/api/chat/sessions?lookup=resume&agentId=agent-001&q=roadmap");

        expect(response.status).toBe(200);
        expect(mockSearchSessionsByMessageContent).not.toHaveBeenCalled();
      });
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
      // projectId is null when no projectId query param is provided
      expect(mockCreateSession).toHaveBeenCalledWith({
        agentId: "agent-001",
        title: null,
        projectId: null,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
    });

    it("creates session with projectId when projectId query param is provided", async () => {
      const sessionWithProject = {
        ...sampleSession,
        projectId: "proj-001",
      };
      mockCreateSession.mockReturnValue(sessionWithProject);

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions?projectId=proj-001",
        JSON.stringify({ agentId: "agent-001" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect((response.body as any).session.projectId).toBe("proj-001");
      // Verify projectId is passed to createSession
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-001",
        }),
      );
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
      // projectId is null when no projectId query param is provided
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Custom Title",
          projectId: null,
        }),
      );
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
      // projectId is null when no projectId query param is provided
      expect(mockCreateSession).toHaveBeenCalledWith({
        agentId: "agent-002",
        title: null,
        projectId: null,
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

    it("uses engine chatStore to find session when projectId is provided", async () => {
      const { createServer } = await import("../server.js");

      const engineSession = { ...sampleSession, id: "chat-engine-456", projectId: "proj-secondary" };
      const engineGetSession = vi.fn((id: string) => (id === "chat-engine-456" ? engineSession : undefined));
      const engineChatStore = { ...mockChatStoreInstance, getSession: engineGetSession };
      const mockEngine = { getChatStore: () => engineChatStore };
      const mockEngineManager = {
        getEngine: vi.fn((id: string) => (id === "proj-secondary" ? mockEngine : undefined)),
        getAllEngines: vi.fn().mockReturnValue(new Map([["proj-secondary", mockEngine]])),
      };

      // Default chatStore does NOT have this session
      mockGetSession.mockReturnValue(undefined);

      const appWithEngine = createServer(store as any, {
        chatStore: mockChatStore as any,
        chatManager: mockChatManager as any,
        engineManager: mockEngineManager as any,
      });

      const response = await request(appWithEngine, "GET", "/api/chat/sessions/chat-engine-456?projectId=proj-secondary");

      expect(response.status).toBe(200);
      expect((response.body as any).session.id).toBe("chat-engine-456");
      expect(engineGetSession).toHaveBeenCalledWith("chat-engine-456");
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

    it("passes order=desc to getMessages when query param is provided", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessages.mockReturnValue([sampleMessage]);

      const response = await request(
        app,
        "GET",
        "/api/chat/sessions/chat-abc123/messages?order=desc",
      );

      expect(response.status).toBe(200);
      expect(mockGetMessages).toHaveBeenCalledWith("chat-abc123", expect.objectContaining({
        order: "desc",
      }));
    });

    it("returns 400 for invalid order value", async () => {
      mockGetSession.mockReturnValue(sampleSession);

      const response = await request(
        app,
        "GET",
        "/api/chat/sessions/chat-abc123/messages?order=invalid",
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toMatch(/order/i);
    });
  });

  describe("POST /api/chat/sessions/:id/cancel", () => {
    it("returns success true when generation is cancelled", async () => {
      mockCancelGeneration.mockReturnValue(true);

      const response = await request(app, "POST", "/api/chat/sessions/chat-abc123/cancel");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(mockCancelGeneration).toHaveBeenCalledWith("chat-abc123");
    });

    it("returns success false when no active generation exists", async () => {
      mockCancelGeneration.mockReturnValue(false);

      const response = await request(app, "POST", "/api/chat/sessions/chat-abc123/cancel");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: false });
      expect(mockCancelGeneration).toHaveBeenCalledWith("chat-abc123");
    });

    it("returns 503 when chat manager is unavailable", async () => {
      const express = await import("express");
      const { createApiRoutes } = await import("../routes.js");

      const appWithoutManager = express.default();
      appWithoutManager.use(express.json());
      appWithoutManager.use("/api", createApiRoutes(store as any, {
        chatStore: mockChatStore as any,
        chatManager: undefined,
      }));

      const response = await request(appWithoutManager as any, "POST", "/api/chat/sessions/chat-abc123/cancel");

      expect(response.status).toBe(503);
      expect((response.body as any).error).toContain("Chat manager not available");
    });
  });

  describe("DELETE /api/chat/sessions/:id/messages/:messageId", () => {
    it("deletes message when session exists", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(sampleMessage);
      mockDeleteMessage.mockReturnValue(true);

      const response = await request(
        app,
        "DELETE",
        "/api/chat/sessions/chat-abc123/messages/msg-xyz789",
      );

      expect(response.status).toBe(200);
      expect((response.body as any).success).toBe(true);
      expect(mockDeleteMessage).toHaveBeenCalledWith("msg-xyz789");
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

    it("returns 404 when deleteMessage returns false", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(sampleMessage);
      mockDeleteMessage.mockReturnValue(false);

      const response = await request(
        app,
        "DELETE",
        "/api/chat/sessions/chat-abc123/messages/msg-xyz789",
      );

      expect(response.status).toBe(404);
      expect(mockDeleteMessage).toHaveBeenCalledWith("msg-xyz789");
    });
  });

  describe("PATCH /api/chat/sessions/:id/messages/:messageId", () => {
    it("truncates from the target message and returns retained history", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(sampleMessage);
      mockIsGenerating.mockReturnValue(false);
      const retained = [{ ...sampleMessage, id: "msg-earlier", content: "earlier turn" }];
      mockRewindSessionForEdit.mockResolvedValue({ retained });

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123/messages/msg-xyz789",
        JSON.stringify({ content: "edited content" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).retained).toEqual(retained);
      expect(mockRewindSessionForEdit).toHaveBeenCalledWith("chat-abc123", "msg-xyz789");
    });

    it("allows editing the first message in a thread", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(sampleMessage);
      mockIsGenerating.mockReturnValue(false);
      mockRewindSessionForEdit.mockResolvedValue({ retained: [] });

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123/messages/msg-xyz789",
        JSON.stringify({ content: "edited first message" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect((response.body as any).retained).toEqual([]);
    });

    it("returns 400 when the target message is not a user message", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue({ ...sampleMessage, role: "assistant" as const });

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123/messages/msg-xyz789",
        JSON.stringify({ content: "edited content" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect(mockRewindSessionForEdit).not.toHaveBeenCalled();
    });

    it("returns 400 for empty content", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(sampleMessage);

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123/messages/msg-xyz789",
        JSON.stringify({ content: "   " }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect(mockRewindSessionForEdit).not.toHaveBeenCalled();
    });

    it("returns 404 when session not found", async () => {
      mockGetSession.mockReturnValue(undefined);

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/nonexistent/messages/msg-xyz789",
        JSON.stringify({ content: "edited content" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
    });

    it("returns 404 when message not found", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(undefined);

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123/messages/nonexistent",
        JSON.stringify({ content: "edited content" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(404);
    });

    it("rejects the edit while a generation is in flight for the session", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockGetMessage.mockReturnValue(sampleMessage);
      mockIsGenerating.mockReturnValue(true);

      const response = await request(
        app,
        "PATCH",
        "/api/chat/sessions/chat-abc123/messages/msg-xyz789",
        JSON.stringify({ content: "edited content" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect(mockRewindSessionForEdit).not.toHaveBeenCalled();
    });
  });

  // ── SSE Streaming Tests ────────────────────────────────────────────────────

  describe("POST /api/chat/sessions/:id/messages (SSE)", () => {
    it("creates a fresh backend send for second turn on same session", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockSendMessage.mockImplementation(async (sessionId: string) => {
        mockChatStreamManager.broadcast(sessionId, {
          type: "done",
          data: { messageId: `msg-${Date.now()}` },
        });
      });

      const first = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        JSON.stringify({ content: "Turn 1" }),
        { "content-type": "application/json" },
      );

      const second = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        JSON.stringify({ content: "Turn 2" }),
        { "content-type": "application/json" },
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

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

    it("rejects a taskId that does not match a task-planner chat session", async () => {
      mockGetSession.mockReturnValue({ ...sampleSession, agentId: "task-planner:FN-7312" });

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        JSON.stringify({ content: "What is the status?", taskId: "FN-OTHER" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("taskId does not match");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("accepts matching taskId metadata while preserving the clean user content sent to ChatManager", async () => {
      mockGetSession.mockReturnValue({ ...sampleSession, agentId: "task-planner:FN-7312" });
      mockSendMessage.mockImplementation(async (sessionId: string) => {
        mockChatStreamManager.broadcast(sessionId, {
          type: "done",
          data: { messageId: "msg-task-planner" },
        });
      });

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        JSON.stringify({ content: "What is the status?", taskId: "FN-7312" }),
        { "content-type": "application/json" },
      );

      expect(response.status).toBe(200);
      expect(mockSendMessage).toHaveBeenCalledWith(
        "chat-abc123",
        "What is the status?",
        undefined,
        undefined,
        undefined,
        { generationId: expect.any(Number) },
      );
    });

    it("accepts multipart content with attachments without crashing", async () => {
      mockGetSession.mockReturnValue(sampleSession);
      mockSendMessage.mockImplementation(async (sessionId: string) => {
        mockChatStreamManager.broadcast(sessionId, {
          type: "done",
          data: { messageId: "msg-multipart" },
        });
      });

      const { payload, boundary } = makeMultipartMessageRequest({
        fields: { content: "Hello with attachment" },
        files: [{
          fieldName: "attachments",
          filename: "note.txt",
          contentType: "text/plain",
          body: Buffer.from("hello"),
        }],
      });

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        payload,
        { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      );

      expect(response.status).toBe(200);
      expect(String(response.body)).not.toContain("Cannot destructure property 'content'");
    });

    it("returns 400 for multipart requests missing content instead of crashing", async () => {
      mockGetSession.mockReturnValue(sampleSession);

      /**
       * FNXC:Chat 2026-06-18-06:34:
       * FN-6637 keeps this regression test aligned with the register-chat-routes.ts FNXC:Chat 2026-06-17-02:12 invariant: attachment-only multipart sends are valid, so the 400 no-SSE path must omit both text content and files.
       */
      const { payload, boundary } = makeMultipartMessageRequest({});

      const response = await request(
        app,
        "POST",
        "/api/chat/sessions/chat-abc123/messages",
        payload,
        { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      );

      expect(response.status).toBe(400);
      expect((response.body as any).error).toContain("content is required");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    describe("SSE stream lifecycle", () => {
      beforeEach(() => {
        mockSendMessage.mockResolvedValue(undefined);
        mockChatStreamManager.reset();
        mockChatStreamManager.getBufferedEvents.mockClear();
        mockChatStreamManager.subscribe.mockClear();
        mockChatStreamManager.broadcast.mockClear();
        mockChatStreamManager.cleanupSession.mockClear();
      });

      /**
       * Helper to invoke the chat SSE route handler directly.
       * Tests the SSE route behavior by calling the handler with mock req/res.
       */
      async function invokeSSEHandler(
        req: Request,
        res: Response,
        store: any,
        chatStore: any,
        chatManager: any,
        routePath = "/chat/sessions/:id/messages",
        method: "get" | "post" = "post",
      ): Promise<void> {
        const { createApiRoutes } = await import("../routes.js");
        const router = createApiRoutes(store, {
          chatStore,
          chatManager,
        });

        const stack = router.stack || [];
        const handler = stack.find(
          (layer: any) =>
            layer.route?.path === routePath &&
            layer.route?.methods?.[method],
        );

        if (!handler) {
          throw new Error(`SSE route handler not found (${method.toUpperCase()} ${routePath}). Stack has ${stack.length} layers.`);
        }

        const routeHandler = handler.route.stack[handler.route.stack.length - 1].handle;
        const next = vi.fn();
        await routeHandler(req, res, next);
      }

      it("handler is found in router stack", async () => {
        mockGetSession.mockReturnValue(sampleSession);

        const { createApiRoutes } = await import("../routes.js");
        const router = createApiRoutes(store, {
          chatStore: mockChatStore,
          chatManager: mockChatManager,
        });

        const stack = router.stack || [];
        const handler = stack.find(
          (layer: any) =>
            layer.route?.path === "/chat/sessions/:id/messages" &&
            layer.route?.methods?.post,
        );

        expect(handler).toBeDefined();
      });

      it("handler can be invoked", async () => {
        mockGetSession.mockReturnValue(sampleSession);

        const req = createSSERequest();
        const { res } = createSSEResponse();

        req.body = { content: "Hello" };
        req.params = { id: "chat-abc123" };
        req.ip = "127.0.0.1";
        req.socket = { remoteAddress: "127.0.0.1" } as any;

        // Get the router and find handler
        const { createApiRoutes } = await import("../routes.js");
        const router = createApiRoutes(store, {
          chatStore: mockChatStore,
          chatManager: mockChatManager,
        });

        const stack = router.stack || [];
        const handler = stack.find(
          (layer: any) =>
            layer.route?.path === "/chat/sessions/:id/messages" &&
            layer.route?.methods?.post,
        );

        expect(handler).toBeDefined();

        // Invoke the handler - handler should execute without error
        const next = vi.fn();
        const routeHandler = handler.route.stack[handler.route.stack.length - 1].handle;
        const result = routeHandler(req, res, next);

        // If it returns a promise, await it
        if (result && typeof result.then === "function") {
          await result;
        }

        // Handler executed without throwing
        expect(true).toBe(true);
      });


      it("attach stream returns 404 for unknown session", async () => {
        mockGetSession.mockReturnValue(null);

        const response = await request(
          app,
          "GET",
          "/api/chat/sessions/chat-missing/stream",
        );

        expect(response.status).toBe(404);
      });

      it("attach stream replays buffered events and ends when not generating", async () => {
        mockGetSession.mockReturnValue(sampleSession);
        mockIsGenerating.mockReturnValue(false);
        mockChatStreamManager.getBufferedEvents.mockReturnValue([
          { id: 2, event: "text", data: JSON.stringify("hello") },
          { id: 3, event: "done", data: JSON.stringify({ messageId: "msg-1" }) },
        ]);

        const req = createSSERequest();
        const { res, chunks } = createSSEResponse();
        req.params = { id: "chat-abc123" };
        req.query = {} as any;
        req.headers = {} as any;

        await invokeSSEHandler(req, res, store, mockChatStore, mockChatManager, "/chat/sessions/:id/stream", "get");

        const output = chunks.join("");
        expect(output).toContain("id: 2");
        expect(output).toContain("event: text");
        expect(output).toContain("id: 3");
        expect(output).toContain("event: done");
        expect(res.end).toHaveBeenCalled();
        expect(mockChatStreamManager.subscribe).not.toHaveBeenCalled();
      });

      it("attach stream replays buffered events and receives live generation events", async () => {
        mockGetSession.mockReturnValue(sampleSession);
        mockIsGenerating.mockReturnValue(true);
        mockGetActiveGenerationId.mockReturnValue(42);
        mockChatStreamManager.getBufferedEvents.mockReturnValue([
          { id: 5, event: "text", data: JSON.stringify("buffer") },
        ]);

        const req = createSSERequest();
        const { res, chunks } = createSSEResponse();
        req.params = { id: "chat-abc123" };
        req.query = {} as any;
        req.headers = {} as any;

        await invokeSSEHandler(req, res, store, mockChatStore, mockChatManager, "/chat/sessions/:id/stream", "get");
        expect(mockChatStreamManager.subscribe).toHaveBeenCalledWith(
          "chat-abc123",
          expect.any(Function),
          { generationId: 42 },
        );

        const subscriber = mockChatStreamManager.subscribe.mock.calls.at(-1)?.[1] as ((event: any, id?: number) => void);
        subscriber({ type: "text", data: "live" }, 6);
        subscriber({ type: "done", data: { messageId: "msg-2" } }, 7);

        const output = chunks.join("");
        expect(output).toContain("id: 5");
        expect(output).toContain("data: \"buffer\"");
        expect(output).toContain("data: \"live\"");
      });

      it("attach stream honors Last-Event-ID replay cutoff", async () => {
        mockGetSession.mockReturnValue(sampleSession);
        mockIsGenerating.mockReturnValue(false);

        const req = createSSERequest();
        const { res } = createSSEResponse();
        req.params = { id: "chat-abc123" };
        req.query = {} as any;
        req.headers = { "last-event-id": "9" } as any;

        await invokeSSEHandler(req, res, store, mockChatStore, mockChatManager, "/chat/sessions/:id/stream", "get");

        expect(mockChatStreamManager.getBufferedEvents).toHaveBeenCalledWith("chat-abc123", 9);
      });

      it("attach stream filters out events from a different generation", async () => {
        mockGetSession.mockReturnValue(sampleSession);
        mockIsGenerating.mockReturnValue(true);
        mockGetActiveGenerationId.mockReturnValue(7);
        mockChatStreamManager.getBufferedEvents.mockReturnValue([]);

        const req = createSSERequest();
        const { res, chunks } = createSSEResponse();
        req.params = { id: "chat-abc123" };
        req.query = {} as any;
        req.headers = {} as any;

        await invokeSSEHandler(req, res, store, mockChatStore, mockChatManager, "/chat/sessions/:id/stream", "get");
        mockChatStreamManager.broadcast("chat-abc123", { type: "text", data: "wrong" }, { generationId: 8 });
        const subscriber = mockChatStreamManager.subscribe.mock.calls.at(-1)?.[1] as ((event: any, id?: number) => void);
        subscriber({ type: "text", data: "right" }, 3);
        subscriber({ type: "done", data: { messageId: "msg-3" } }, 4);

        const output = chunks.join("");
        expect(mockChatStreamManager.subscribe).toHaveBeenCalledWith(
          "chat-abc123",
          expect.any(Function),
          { generationId: 7 },
        );
        expect(output).toContain("right");
        expect(output).not.toContain("wrong");
      });

      it("SSE route passes through tool_start and tool_end events", async () => {
        mockGetSession.mockReturnValue(sampleSession);

        const chatModule = await import("../chat.js");
        vi.mocked(chatModule.checkRateLimit).mockReturnValue(true);

        mockSendMessage.mockImplementation(async (sessionId: string) => {
          mockChatStreamManager.broadcast(sessionId, {
            type: "tool_start",
            data: {
              toolName: "read",
              args: { path: "/foo.ts" },
            },
          });
          mockChatStreamManager.broadcast(sessionId, {
            type: "tool_end",
            data: {
              toolName: "read",
              isError: false,
              result: "file contents",
            },
          });
          mockChatStreamManager.broadcast(sessionId, {
            type: "done",
            data: { messageId: "msg-tool" },
          });
        });

        const req = createSSERequest();
        const { res, chunks } = createSSEResponse();

        req.body = { content: "Read #foo.ts" };
        req.params = { id: "chat-abc123" };
        req.query = {} as any;
        req.headers = {} as any;
        req.ip = "127.0.0.1";
        req.socket = { remoteAddress: "127.0.0.1" } as any;

        await invokeSSEHandler(req, res, store, mockChatStore, mockChatManager);

        const output = chunks.join("");
        expect(output).toContain("event: tool_start");
        expect(output).toContain("event: tool_end");

        expect(output).toContain('data: {"toolName":"read","args":{"path":"/foo.ts"}}');
        expect(output).toContain('data: {"toolName":"read","isError":false,"result":"file contents"}');
      });

      it("SSE route forwards done payload with assistant snapshot", async () => {
        mockGetSession.mockReturnValue(sampleSession);

        const chatModule = await import("../chat.js");
        vi.mocked(chatModule.checkRateLimit).mockReturnValue(true);

        mockSendMessage.mockImplementation(async (sessionId: string) => {
          mockChatStreamManager.broadcast(sessionId, {
            type: "done",
            data: {
              messageId: "msg-final",
              message: {
                id: "msg-final",
                sessionId,
                role: "assistant",
                content: "Final reply",
                thinkingOutput: null,
                metadata: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
          });
        });

        const req = createSSERequest();
        const { res, chunks } = createSSEResponse();

        req.body = { content: "Hello" };
        req.params = { id: "chat-abc123" };
        req.query = {} as any;
        req.headers = {} as any;
        req.ip = "127.0.0.1";
        req.socket = { remoteAddress: "127.0.0.1" } as any;

        await invokeSSEHandler(req, res, store, mockChatStore, mockChatManager);

        const output = chunks.join("");
        expect(output).toContain("event: done");
        expect(output).toContain('"messageId":"msg-final"');
        expect(output).toContain('"content":"Final reply"');
      });

      it("SSE route forwards structured error payloads", async () => {
        mockGetSession.mockReturnValue(sampleSession);

        const chatModule = await import("../chat.js");
        vi.mocked(chatModule.checkRateLimit).mockReturnValue(true);

        mockSendMessage.mockImplementation(async (sessionId: string) => {
          mockChatStreamManager.broadcast(sessionId, {
            type: "error",
            data: {
              summary: "Model request failed",
              errorClass: "ProviderError",
              code: "E_MODEL",
              detail: "ProviderError: Model request failed",
            },
          });
        });

        const req = createSSERequest();
        const { res, chunks } = createSSEResponse();

        req.body = { content: "Hello" };
        req.params = { id: "chat-abc123" };
        req.query = {} as any;
        req.headers = {} as any;
        req.ip = "127.0.0.1";
        req.socket = { remoteAddress: "127.0.0.1" } as any;

        await invokeSSEHandler(req, res, store, mockChatStore, mockChatManager);

        const output = chunks.join("");
        expect(output).toContain("event: error");
        expect(output).toContain('"summary":"Model request failed"');
        expect(output).toContain('"errorClass":"ProviderError"');
        expect(output).toContain('"code":"E_MODEL"');
      });

      it("uses the same generation id for subscription and sendMessage", async () => {
        mockGetSession.mockReturnValue(sampleSession);

        const chatModule = await import("../chat.js");
        vi.mocked(chatModule.checkRateLimit).mockReturnValue(true);
        mockBeginGeneration.mockReturnValueOnce({
          generationId: 42,
          abortController: new AbortController(),
        });

        mockSendMessage.mockImplementation(async (sessionId: string) => {
          mockChatStreamManager.broadcast(sessionId, {
            type: "done",
            data: { messageId: "msg-final" },
          });
        });

        const req = createSSERequest();
        const { res } = createSSEResponse();

        req.body = { content: "Hello" };
        req.params = { id: "chat-abc123" };
        req.query = {} as any;
        req.headers = {} as any;
        req.ip = "127.0.0.1";
        req.socket = { remoteAddress: "127.0.0.1" } as any;

        await invokeSSEHandler(req, res, store, mockChatStore, mockChatManager);

        expect(mockBeginGeneration).toHaveBeenCalledWith("chat-abc123");
        expect(mockChatStreamManager.subscribe).toHaveBeenCalledWith(
          "chat-abc123",
          expect.any(Function),
          { generationId: 42 },
        );
        expect(mockSendMessage).toHaveBeenCalledWith(
          "chat-abc123",
          "Hello",
          undefined,
          undefined,
          undefined,
          { generationId: 42 },
        );
      });
    });
  });

  // ── Error Handling Tests ───────────────────────────────────────────────────

  // Note: The "returns 500 when chat store is not available" test was skipped
  // because server.ts creates its own ChatStore when none is provided via:
  //   const chatStore = options?.chatStore ?? new ChatStore(...)
  // This means the route won't fail when chatStore is undefined in tests.
});

// ── multi-project chat routing ──────────────────────────────────────────────

describe("multi-project chat routing", () => {
  let store: MockStore;
  let app: ReturnType<typeof import("../server.js").createServer>;
  let mockChatStore: typeof mockChatStoreInstance;
  let mockChatManager: ReturnType<typeof createMockChatManager>;

  const secondarySession = {
    id: "secondary-session-1",
    agentId: "agent-001",
    title: "Secondary Chat",
    status: "active",
    projectId: "secondary-proj-id",
    modelProvider: null,
    modelId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset per-project caches to ensure no cross-test pollution
    const { __resetScopedChatManagerCache, __resetScopedChatStoreCache } = await import("../chat-project-services.js");
    __resetScopedChatManagerCache();
    __resetScopedChatStoreCache();

    mockInit.mockResolvedValue(undefined);
    mockGetSession.mockReset();
    mockListSessions.mockReset();
    mockGetLastMessageForSessions.mockReset();
    mockSendMessage.mockReset();
    mockCancelGeneration.mockReset();
    mockBeginGeneration.mockReturnValue({ generationId: 1, abortController: new AbortController() });
    mockIsGenerating.mockReturnValue(false);
    mockGetActiveGenerationId.mockReturnValue(undefined);
    mockGetOrCreateProjectStore.mockReset();

    // Default list/message mocks
    mockListSessions.mockReturnValue([]);
    mockGetLastMessageForSessions.mockReturnValue(new Map());
    mockCancelGeneration.mockReturnValue(false);

    store = new MockStore();
    mockChatStore = mockChatStoreInstance;
    mockChatManager = createMockChatManager();

    // Secondary project store resolves to same MockStore for simplicity
    mockGetOrCreateProjectStore.mockResolvedValue(store);

    const { createServer } = await import("../server.js");
    app = createServer(store as any, {
      chatStore: mockChatStore as any,
      chatManager: mockChatManager as any,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST /cancel uses scoped ChatManager when projectId is provided", async () => {
    mockCancelGeneration.mockReturnValue(false);

    const response = await request(
      app,
      "POST",
      `/api/chat/sessions/${secondarySession.id}/cancel?projectId=${secondarySession.projectId}`,
    );

    expect(response.status).toBe(200);
    expect((response.body as any).success).toBe(false);
    // Scoped path: getOrCreateProjectStore is called with the secondary projectId
    expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith(secondarySession.projectId);
    // cancelGeneration was called on the scoped manager
    expect(mockCancelGeneration).toHaveBeenCalledWith(secondarySession.id);
  });

  it("POST /cancel falls back to global ChatManager when no projectId", async () => {
    mockCancelGeneration.mockReturnValue(false);

    const response = await request(
      app,
      "POST",
      `/api/chat/sessions/${secondarySession.id}/cancel`,
    );

    expect(response.status).toBe(200);
    expect((response.body as any).success).toBe(false);
    // Global path: getOrCreateProjectStore is NOT called
    expect(mockGetOrCreateProjectStore).not.toHaveBeenCalled();
    // cancelGeneration was called on the global manager
    expect(mockCancelGeneration).toHaveBeenCalledWith(secondarySession.id);
  });

  it("GET /sessions uses scoped ChatManager for isGenerating when projectId is provided", async () => {
    mockListSessions.mockReturnValue([secondarySession]);
    mockGetLastMessageForSessions.mockReturnValue(new Map());

    const response = await request(
      app,
      "GET",
      `/api/chat/sessions?projectId=${secondarySession.projectId}`,
    );

    expect(response.status).toBe(200);
    expect((response.body as any).sessions).toHaveLength(1);
    // Scoped path: getOrCreateProjectStore is called for isGenerating resolution
    expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith(secondarySession.projectId);
    // isGenerating defaults to false (MockChatManager has no getGeneratingSessionIds)
    expect((response.body as any).sessions[0].isGenerating).toBe(false);
  });
});

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import type { ChatMessage, ChatSession } from "@fusion/core";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([
    { id: "agent-001", name: "Alpha", role: "executor", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
  fetchModels: vi.fn().mockResolvedValue({
    models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 }],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

vi.mock("../../hooks/useChatRooms", () => ({
  useChatRooms: vi.fn(),
}));

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

import * as apiModule from "../../api";
import * as projectStorageModule from "../../utils/projectStorage";
import * as useChatRoomsModule from "../../hooks/useChatRooms";

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockAttachChatStream = vi.mocked(apiModule.attachChatStream);
const mockGetScopedItem = vi.mocked(projectStorageModule.getScopedItem);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

const defaultRoomsState: UseChatRoomsResult = {
  rooms: [],
  roomsLoading: false,
  roomsError: null,
  activeRoom: null,
  activeRoomMembers: [],
  messages: [],
  messagesLoading: false,
  selectRoom: vi.fn(),
  createRoom: vi.fn(),
  deleteRoom: vi.fn(),
  sendRoomMessage: vi.fn(),
  refreshRooms: vi.fn(),
};

function makeSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id" | "agentId">): ChatSession {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    status: overrides.status ?? "active",
    title: overrides.title ?? null,
    projectId: overrides.projectId ?? null,
    modelProvider: overrides.modelProvider ?? null,
    modelId: overrides.modelId ?? null,
    createdAt: overrides.createdAt ?? "2026-04-08T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-08T00:00:00.000Z",
    isGenerating: overrides.isGenerating,
    inFlightGeneration: overrides.inFlightGeneration,
  };
}

function makeMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "sessionId" | "role" | "content">): ChatMessage {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId,
    role: overrides.role,
    content: overrides.content,
    thinkingOutput: overrides.thinkingOutput ?? null,
    metadata: overrides.metadata ?? null,
    createdAt: overrides.createdAt ?? "2026-04-08T00:00:00.000Z",
  };
}

describe("FN-6599 ChatView streaming prior thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseChatRooms.mockReturnValue(defaultRoomsState);
    mockGetScopedItem.mockReturnValue(undefined);
    mockFetchChatSession.mockResolvedValue({ session: makeSession({ id: "session-001", agentId: "agent-001" }) });
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["desktop", 1280],
    ["mobile", 390],
  ])("FN-6599 renders the restored main-chat prior thread while the assistant bubble streams on %s", async (_label, width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
    const generatingSession = makeSession({
      id: "session-restored-streaming",
      agentId: "agent-001",
      title: "Restored streaming",
      isGenerating: true,
      inFlightGeneration: {
        status: "generating" as const,
        streamingText: "live partial response",
        streamingThinking: "thinking",
        toolCalls: [],
        replayFromEventId: 101,
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    });
    const priorThreadNewestFirst = [
      makeMessage({ id: "msg-004", sessionId: generatingSession.id, role: "assistant", content: "Second answer" }),
      makeMessage({ id: "msg-003", sessionId: generatingSession.id, role: "user", content: "Second question" }),
      makeMessage({ id: "msg-002", sessionId: generatingSession.id, role: "assistant", content: "First answer" }),
      makeMessage({ id: "msg-001", sessionId: generatingSession.id, role: "user", content: "First question" }),
    ];

    mockGetScopedItem.mockImplementation((key) => key === "kb-chat-active-session" ? generatingSession.id : undefined);
    mockFetchChatSessions.mockResolvedValue({ sessions: [generatingSession] });
    mockFetchChatMessages.mockResolvedValue({ messages: priorThreadNewestFirst });

    await act(async () => {
      render(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });

    await waitFor(() => {
      expect(screen.getByText("live partial response")).toBeInTheDocument();
    });

    expect(await screen.findByText("First question")).toBeInTheDocument();
    expect(screen.getByText("First answer")).toBeInTheDocument();
    expect(screen.getByText("Second question")).toBeInTheDocument();
    expect(screen.getByText("Second answer")).toBeInTheDocument();
  });
});

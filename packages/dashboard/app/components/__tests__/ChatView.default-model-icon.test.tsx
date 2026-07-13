import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { ChatView, resolveSessionProvider } from "../ChatView";
import type { UseChatReturn, ChatMessageInfo, ChatSessionInfo } from "../../hooks/useChat";
import type { Agent } from "@fusion/core";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import * as useChatModule from "../../hooks/useChat";
import * as apiModule from "../../api";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms", () => ({
  useChatRooms: () => ({
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
  }),
}));
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../../hooks/useNavigationHistory", () => ({
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  updateGlobalSettings: vi.fn(),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Bot: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-bot"} {...props} />,
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockFetchModels = vi.mocked(apiModule.fetchModels);
const mockFetchAgents = vi.mocked(apiModule.fetchAgents);

const assistantMessage: ChatMessageInfo = {
  id: "msg-1",
  role: "assistant",
  content: "hello",
  createdAt: "2026-05-19T00:00:00.000Z",
};

const baseSession: ChatSessionInfo = {
  id: "session-1",
  agentId: "agent-1",
  status: "active",
  title: "Session",
  createdAt: "2026-05-19T00:00:00.000Z",
  updatedAt: "2026-05-19T00:00:00.000Z",
};

function setupMockChat(session: ChatSessionInfo): void {
  const state: UseChatReturn = {
    sessions: [session],
    activeSession: session,
    sessionsLoading: false,
    messages: [assistantMessage],
    messagesLoading: false,
    isStreaming: false,
    streamingText: "",
    streamingThinking: "",
    streamingToolCalls: [],
    selectSession: vi.fn(),
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    editMessageAndResend: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessages: [],
    clearPendingMessage: vi.fn(),
    loadMoreMessages: vi.fn(),
    hasMoreMessages: false,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    filteredSessions: [session],
    refreshSessions: vi.fn(),
    agentsMap: new Map(),
  };
  mockUseChat.mockReturnValue(state);
}

function renderView() {
  return render(
    <FileBrowserProvider>
      <ChatView addToast={vi.fn()} />
    </FileBrowserProvider>,
  );
}

describe("resolveSessionProvider", () => {
  it("resolves precedence and edge cases", () => {
    const defaults = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
    const agent = { runtimeConfig: { modelProvider: "google", modelId: "gemini-2.5-pro" } } as Agent;

    expect(resolveSessionProvider({ modelProvider: "openai", modelId: "gpt-4o" }, agent, defaults)).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(resolveSessionProvider({}, agent, defaults)).toEqual({ provider: "google", modelId: "gemini-2.5-pro" });
    expect(resolveSessionProvider({}, { runtimeConfig: { modelProvider: "google" } } as Agent, defaults)).toEqual(defaults);
    expect(resolveSessionProvider({}, { runtimeConfig: { modelId: "gemini-2.5-pro" } } as Agent, defaults)).toEqual(defaults);
    expect(resolveSessionProvider({}, { runtimeConfig: "bad" as unknown as Record<string, unknown> } as Agent, defaults)).toEqual(defaults);
    expect(resolveSessionProvider({}, undefined, { provider: null, modelId: null })).toBeNull();
  });
});

describe("ChatView default model icon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchModels.mockResolvedValue({
      models: [],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });
  });

  it("uses default provider icon when no session/agent override exists", async () => {
    setupMockChat(baseSession);
    mockFetchAgents.mockResolvedValue([{ ...baseSession, id: "agent-1", name: "Agent One", role: "executor", state: "idle" } as unknown as Agent]);

    renderView();

    await waitFor(() => expect(screen.getAllByTestId("anthropic-icon").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("icon-bot")).not.toBeInTheDocument();
  });

  it("uses per-session override icon", async () => {
    setupMockChat({ ...baseSession, modelProvider: "openai", modelId: "gpt-4o" });
    mockFetchAgents.mockResolvedValue([]);

    renderView();

    await waitFor(() => expect(screen.getAllByTestId("openai-icon").length).toBeGreaterThan(0));
  });

  it("uses per-agent runtime override over default", async () => {
    setupMockChat(baseSession);
    mockFetchAgents.mockResolvedValue([
      {
        id: "agent-1",
        name: "Agent One",
        role: "executor",
        state: "idle",
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
        metadata: {},
        runtimeConfig: { modelProvider: "google", modelId: "gemini-2.5-pro" },
      } as Agent,
    ]);

    renderView();

    await waitFor(() => expect(screen.getAllByTestId("gemini-icon").length).toBeGreaterThan(0));
  });

  it("falls back to Bot when defaults cannot be resolved", async () => {
    setupMockChat(baseSession);
    mockFetchAgents.mockResolvedValue([]);
    mockFetchModels.mockRejectedValue(new Error("boom"));

    renderView();

    await waitFor(() => expect(screen.getAllByTestId("icon-bot").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("anthropic-icon")).not.toBeInTheDocument();
  });
});

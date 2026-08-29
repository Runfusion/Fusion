// ChatView CLI-backed mount test (CLI Agent Executor, U12 completion).
//
// Asserts ChatView delegates the message-pane + composer region to
// <CliChatSurface> when the active chat session carries a `cliExecutorAdapterId`,
// and falls back to the normal provider composer for a regular session.
//
// SessionTerminal is mocked (no xterm / no WS / no PTY / no port 4040) because
// CliChatSurface renders it under the hood.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../SessionTerminal", () => ({
  SessionTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-terminal" data-session-id={sessionId}>
      terminal
    </div>
  ),
}));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
    fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  };
});

async function renderWithAct(ui: Parameters<typeof rtlRender>[0]) {
  let result: ReturnType<typeof rtlRender> | undefined;
  await act(async () => {
    result = rtlRender(ui);
  });
  return result!;
}

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

function makeSession(overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    id: "sess-1",
    agentId: "agent-1",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function chatState(session: ChatSessionInfo): UseChatReturn {
  return {
    sessions: [session],
    activeSession: session,
    sessionsLoading: false,
    messages: [],
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
}

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
  sendRoomMessage: vi.fn().mockResolvedValue(undefined),
  refreshRooms: vi.fn(),
};

/*
FNXC:ChatNavigation 2026-08-23-18:05:
FN-054 made Chat list-first: the transcript/terminal region mounts only inside an explicitly opened
conversation, so each case drills in from the conversation list before asserting on the CLI surface.
*/
function openDirectDetail(sessionId = "sess-1") {
  fireEvent.click(screen.getByTestId(`chat-session-${sessionId}`));
}

describe("ChatView CLI-backed session mount", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    vi.clearAllMocks();
    mockUseChatRooms.mockReturnValue(defaultRoomsState);
  });

  it("renders CliChatSurface (transcript/terminal toggle) for a cli-backed session", async () => {
    mockUseChat.mockReturnValue(
      chatState(makeSession({ cliExecutorAdapterId: "claude-code", cliSessionFile: "cli-native-1" })),
    );
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    openDirectDetail();

    // CliChatSurface renders the transcript/terminal toggle tablist.
    expect(screen.getByRole("tab", { name: /transcript/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /terminal/i })).toBeInTheDocument();
    // The standard provider send button is NOT rendered as a top-level composer
    // affordance for the cli surface's default (transcript) view it wraps the
    // existing composer, but the distinguishing CLI toggle is present.
  });

  it("attaches the terminal to the native cli session id linkage", async () => {
    mockUseChat.mockReturnValue(
      chatState(makeSession({ cliExecutorAdapterId: "claude-code", cliSessionFile: "cli-native-1" })),
    );
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    openDirectDetail();
    // Switch to the terminal tab to mount SessionTerminal.
    fireEvent.click(screen.getByRole("tab", { name: /terminal/i }));
    expect(screen.getByTestId("session-terminal").getAttribute("data-session-id")).toBe("cli-native-1");
  });

  it("generic-tier cli session renders terminal-only (no toggle)", async () => {
    mockUseChat.mockReturnValue(chatState(makeSession({ cliExecutorAdapterId: "generic" })));
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    openDirectDetail();
    expect(screen.getByTestId("session-terminal")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /transcript/i })).toBeNull();
  });

  it("renders the normal provider composer for a regular (non-cli) session", async () => {
    mockUseChat.mockReturnValue(chatState(makeSession({ cliExecutorAdapterId: null })));
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    openDirectDetail();
    // Normal composer present, CLI toggle absent.
    expect(screen.getByPlaceholderText("Type a message...")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /transcript/i })).toBeNull();
    expect(screen.queryByTestId("session-terminal")).toBeNull();
  });
});

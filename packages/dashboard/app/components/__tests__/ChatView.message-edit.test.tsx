/*
FNXC:ChatMessageEdit 2026-07-07-09:00:
Covers the FN-7628 chat message edit affordance across the surfaces enumerated in
PROMPT.md: renders only for user messages in direct/model-loop chat, is absent for
assistant messages, CLI-agent-backed sessions, and Rooms, and is disabled while
streaming. Also covers the inline editor save/cancel interaction and the
editMessageAndResend wiring.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { ChatView } from "../ChatView";
import { StandardChatMessageItem } from "../StandardChatSurface";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

Element.prototype.scrollIntoView = vi.fn();
const chatViewCss = readFileSync(resolve(__dirname, "../ChatView.css"), "utf8");

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
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Pencil: (props: any) => <svg data-testid="icon-pencil" {...props} />,
  };
});

async function renderWithAct(ui: Parameters<typeof rtlRender>[0]) {
  let result: ReturnType<typeof rtlRender> | undefined;
  await act(async () => {
    result = rtlRender(ui);
  });
  return result!;
}

/*
FNXC:ChatNavigation 2026-08-23-17:55:
FN-054 made Chat list-first: the transcript and composer render only inside an explicitly opened
conversation, so every ChatView-level case must drill in from the conversation list first. Without
this the absence assertions below would pass vacuously against an empty detail pane.
*/
function openDirectDetail(sessionId = "session-001") {
  fireEvent.click(screen.getByTestId(`chat-session-${sessionId}`));
}

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

function makeSession(overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    id: "session-001",
    agentId: "agent-001",
    status: "active",
    title: "Test Chat",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    ...overrides,
  };
}

const roomA = {
  id: "room-a",
  name: "Room A",
  slug: "room-a",
  description: null,
  projectId: "proj-123",
  createdBy: "agent-1",
  status: "active" as const,
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

function baseRoomsState(overrides: Partial<UseChatRoomsResult> = {}): UseChatRoomsResult {
  return {
    rooms: [roomA],
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
    clearRoom: vi.fn(),
    refreshRooms: vi.fn(),
    ...overrides,
  };
}

function baseChatState(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  const session = overrides.activeSession ?? makeSession();
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
    renameSession: vi.fn(),
    setSessionThinkingLevel: vi.fn(),
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
    ...overrides,
  };
}

describe("ChatView message edit affordance", () => {
  it("uses controller-owned overflow instead of a native resize grip", () => {
    const textareaRule = chatViewCss.match(/\.chat-message-edit-textarea\s*\{[^}]*\}/)?.[0] ?? "";
    expect(textareaRule).toContain("resize: none");
    expect(textareaRule).toContain("overflow-y: hidden");
    expect(textareaRule).not.toContain("resize: vertical");
  });

  beforeEach(() => {
    localStorage.clear();
    mockUseChatRooms.mockReturnValue(baseRoomsState());
  });

  it("renders the edit affordance only on user messages in a direct chat session", async () => {
    mockUseChat.mockReturnValue(baseChatState({
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "assistant-1", sessionId: "session-001", role: "assistant", content: "hi there", createdAt: "2026-04-08T00:00:01.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);
    openDirectDetail();

    const editButton = screen.getByTestId("chat-message-edit-user-1");
    const userMessage = screen.getByTestId("chat-message-user-1");
    const timeRow = userMessage.querySelector(".chat-message-time-row");

    expect(editButton).toHaveAttribute("aria-label", "Edit message");
    expect(editButton).toHaveClass("chat-message-edit-action--inline");
    expect(timeRow).toContainElement(userMessage.querySelector(".chat-message-time") as HTMLElement);
    expect(timeRow).toContainElement(editButton);
    expect(userMessage.querySelector(".chat-message-actions--user")).toBeNull();
    expect(screen.queryByTestId("chat-message-edit-assistant-1")).toBeNull();
  });

  it("is absent for CLI-agent-backed sessions", async () => {
    mockUseChat.mockReturnValue(baseChatState({
      activeSession: makeSession({ cliExecutorAdapterId: "claude-code", cliSessionFile: "cli-native-1" }),
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);
    openDirectDetail();

    expect(screen.queryByTestId("chat-message-edit-user-1")).toBeNull();
  });

  it("is absent for Rooms messages", async () => {
    mockUseChat.mockReturnValue(baseChatState({ messages: [] }));
    mockUseChatRooms.mockReturnValue(baseRoomsState({
      activeRoom: roomA,
      messages: [
        { id: "room-user-1", roomId: roomA.id, role: "user", content: "hey room", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    fireEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    fireEvent.click(screen.getByTestId(`chat-room-item-${roomA.slug}`));

    expect(screen.queryByTestId("chat-message-edit-room-user-1")).toBeNull();
  });

  it("is absent while a generation is streaming", async () => {
    mockUseChat.mockReturnValue(baseChatState({
      isStreaming: true,
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);
    openDirectDetail();

    expect(screen.queryByTestId("chat-message-edit-user-1")).toBeNull();
  });

  it("swaps to an inline editor and saves via editMessageAndResend", async () => {
    const editMessageAndResend = vi.fn();
    mockUseChat.mockReturnValue(baseChatState({
      editMessageAndResend,
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);
    openDirectDetail();

    fireEvent.click(screen.getByTestId("chat-message-edit-user-1"));

    const editor = screen.getByTestId("chat-message-edit-editor-user-1");
    const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello");

    expect(screen.getByTestId("chat-message-edit-save-user-1")).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "hello, edited" } });
    fireEvent.click(screen.getByTestId("chat-message-edit-save-user-1"));

    expect(editMessageAndResend).toHaveBeenCalledWith("user-1", "hello, edited");
    await waitFor(() => {
      expect(screen.queryByTestId("chat-message-edit-editor-user-1")).toBeNull();
    });
  });

  it("does not treat unchanged trailing whitespace as an edit", async () => {
    const editMessageAndResend = vi.fn();
    await renderWithAct(
      <StandardChatMessageItem
        message={{ id: "whitespace-user-1", sessionId: "session-001", role: "user", content: "hello ", createdAt: "2026-04-08T00:00:00.000Z" }}
        forcePlain={false}
        agentName="Fusion"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
        activeSessionId="session-001"
        onEditMessage={editMessageAndResend}
        canEdit
      />,
    );

    fireEvent.click(screen.getByTestId("chat-message-edit-whitespace-user-1"));
    expect(screen.getByTestId("chat-message-edit-save-whitespace-user-1")).toBeDisabled();
  });

  it("cancel restores the original content without calling editMessageAndResend", async () => {
    const editMessageAndResend = vi.fn();
    mockUseChat.mockReturnValue(baseChatState({
      editMessageAndResend,
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);
    openDirectDetail();

    fireEvent.click(screen.getByTestId("chat-message-edit-user-1"));
    const editor = screen.getByTestId("chat-message-edit-editor-user-1");
    const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "changed but cancelled" } });

    fireEvent.click(screen.getByTestId("chat-message-edit-cancel-user-1"));

    expect(editMessageAndResend).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-message-edit-editor-user-1")).toBeNull();
    expect(screen.getByTestId("chat-message-user-1")).toHaveTextContent("hello");
  });

  it("keeps the correction visible when an edit handler rejects", async () => {
    const editMessageAndResend = vi.fn().mockRejectedValueOnce(new Error("PATCH failed"));
    await renderWithAct(
      <StandardChatMessageItem
        message={{ id: "failed-user-1", sessionId: "session-001", role: "user", content: "original", createdAt: "2026-04-08T00:00:00.000Z" }}
        forcePlain={false}
        agentName="Fusion"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
        activeSessionId="session-001"
        onEditMessage={editMessageAndResend}
        canEdit
      />,
    );

    fireEvent.click(screen.getByTestId("chat-message-edit-failed-user-1"));
    const textarea = screen.getByTestId("chat-message-edit-editor-failed-user-1").querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "corrected" } });
    fireEvent.click(screen.getByTestId("chat-message-edit-save-failed-user-1"));

    await act(async () => undefined);
    expect(editMessageAndResend).toHaveBeenCalledWith("failed-user-1", "corrected");
    expect(screen.getByTestId("chat-message-edit-editor-failed-user-1")).toBeInTheDocument();
    expect(textarea).not.toBeDisabled();
  });

  it("renders inline edit without a go-to-top control for non-scroll-to-top consumers", () => {
    rtlRender(
      <StandardChatMessageItem
        message={{ id: "planner-user-1", sessionId: "task-planner:FN-1", role: "user", content: "planner request", createdAt: "2026-04-08T00:00:00.000Z" }}
        forcePlain={false}
        agentName="Planner"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
        activeSessionId="task-planner:FN-1"
        onEditMessage={vi.fn()}
        canEdit={true}
      />,
    );

    const editButton = screen.getByTestId("chat-message-edit-planner-user-1");
    const message = screen.getByTestId("chat-message-planner-user-1");
    expect(editButton).toHaveClass("chat-message-edit-action--inline");
    expect(message.querySelector(".chat-message-time-row")).toContainElement(editButton);
    expect(message.querySelector("[data-testid^='chat-message-scroll-to-top-']")).toBeNull();
  });

  it("does not leave an empty edit-action shell for assistant messages", async () => {
    mockUseChat.mockReturnValue(baseChatState({
      messages: [
        { id: "assistant-1", sessionId: "session-001", role: "assistant", content: "hi there", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);
    openDirectDetail();

    const assistantMessage = screen.getByTestId("chat-message-assistant-1");
    expect(assistantMessage.querySelector("[aria-label='Edit message']")).toBeNull();
  });
});

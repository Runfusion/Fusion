import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import * as api from "../../api";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";

Element.prototype.scrollIntoView = vi.fn();

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
    fetchSettings: vi.fn().mockResolvedValue({}),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
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
const mockFetchSettings = vi.mocked(api.fetchSettings);

const sessionOne: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Session One",
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const sessionTwo: ChatSessionInfo = {
  ...sessionOne,
  id: "session-002",
  title: "Session Two",
};

const roomOne = {
  id: "room-001",
  name: "Room One",
  slug: "room-one",
  description: null,
  projectId: "proj-123",
  createdBy: "agent-001",
  status: "active" as const,
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const defaultChatState: UseChatReturn = {
  sessions: [sessionOne, sessionTwo],
  activeSession: sessionOne,
  sessionsLoading: false,
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamingText: "",
  streamingThinking: "",
  streamingToolCalls: [],
  selectSession: vi.fn(),
  createSession: vi.fn().mockResolvedValue(sessionTwo),
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
  filteredSessions: [sessionOne, sessionTwo],
  refreshSessions: vi.fn(),
  agentsMap: new Map(),
};

const defaultRoomsState: UseChatRoomsResult = {
  rooms: [roomOne],
  roomsLoading: false,
  roomsError: null,
  activeRoom: roomOne,
  activeRoomMembers: [],
  messages: [],
  messagesLoading: false,
  selectRoom: vi.fn(),
  createRoom: vi.fn(),
  deleteRoom: vi.fn(),
  sendRoomMessage: vi.fn().mockResolvedValue(undefined),
  refreshRooms: vi.fn(),
};

function setup(chatOverrides: Partial<UseChatReturn> = {}, roomsOverrides: Partial<UseChatRoomsResult> = {}) {
  mockUseChat.mockReturnValue({ ...defaultChatState, ...chatOverrides });
  mockUseChatRooms.mockReturnValue({ ...defaultRoomsState, ...roomsOverrides });
}

function mockDesktopViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

async function renderChatView() {
  return await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
}

describe("ChatView draft persistence", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    vi.clearAllMocks();
    localStorage.clear();
    mockDesktopViewport();
    setup();
    mockFetchSettings.mockResolvedValue({} as Awaited<ReturnType<typeof api.fetchSettings>>);
  });

  it("writes direct-session drafts to localStorage while typing", async () => {
    await renderChatView();

    await userEvent.type(screen.getByPlaceholderText("Type a message..."), "hello draft");

    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBe("hello draft");
    });
  });

  it("restores the persisted direct-session draft when remounted", async () => {
    localStorage.setItem("fusion:chat-draft:direct:session-001", "saved draft");

    const { unmount } = await renderChatView();
    expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("saved draft");

    unmount();
    await renderChatView();

    expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("saved draft");
  });

  it("swaps the visible draft when the active direct session changes", async () => {
    localStorage.setItem("fusion:chat-draft:direct:session-002", "session two draft");

    const { rerender } = await renderChatView();
    expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("");

    setup({
      activeSession: sessionTwo,
      sessions: [sessionOne, sessionTwo],
      filteredSessions: [sessionOne, sessionTwo],
    });
    rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("session two draft");
    });
  });

  it("clears the composer and removes the direct-session draft after send", async () => {
    const sendMessage = vi.fn();
    setup({ sendMessage });

    await renderChatView();

    await userEvent.type(screen.getByPlaceholderText("Type a message..."), "send me");
    await userEvent.click(screen.getAllByTestId("chat-send-btn")[0]);

    await waitFor(() => {
      // FNXC:ChatAttachments 2026-07-23-23:59:
      // FN-8502 (1cd06746f) added the delivery-callback bag as sendMessage's third argument.
      expect(sendMessage).toHaveBeenCalledWith("send me", [], expect.objectContaining({ onDelivered: expect.any(Function), onFailed: expect.any(Function) }));
      expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("");
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBeNull();
    });
  });

  it("removes the storage key when the draft becomes empty", async () => {
    await renderChatView();

    const textarea = screen.getByPlaceholderText("Type a message...");
    await userEvent.type(textarea, "temporary");
    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBe("temporary");
    });

    await userEvent.clear(textarea);

    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBeNull();
    });
  });

  it("seeds and focuses a direct composer when an external nonce is provided", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    const { rerender } = await renderWithAct(
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        experimentalFeatures={{ chatRooms: true }}
        initialComposerDraft={"https://github.com/owner/repo/issues/42\n\n"}
        initialComposerDraftNonce={1}
      />,
    );

    const textarea = screen.getByPlaceholderText("Type a message...");
    await waitFor(() => expect(textarea).toHaveValue("https://github.com/owner/repo/issues/42\n\n"));
    expect(textarea).toHaveFocus();
    expect(screen.getByRole("tab", { name: /Direct/i })).toHaveAttribute("aria-selected", "true");

    rerender(
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        experimentalFeatures={{ chatRooms: true }}
        initialComposerDraft={"https://github.com/owner/repo/pull/42\n\n"}
        initialComposerDraftNonce={2}
      />,
    );
    await waitFor(() => expect(textarea).toHaveValue("https://github.com/owner/repo/pull/42\n\n"));
  });

  it("restores another session's draft after an always-default prefill session fails", async () => {
    localStorage.setItem("fusion:chat-scope", "direct");
    localStorage.setItem("fusion:chat-draft:direct:session-002", "session two draft");
    const createSession = vi.fn().mockRejectedValue(new Error("creation failed"));
    setup({ createSession });
    mockFetchSettings.mockResolvedValue({
      chatNewSessionMode: "always-default",
      chatDefaultKind: "agent",
      chatDefaultAgentId: "agent-001",
    } as Awaited<ReturnType<typeof api.fetchSettings>>);

    const view = await renderChatView();
    await waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());

    view.rerender(
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        experimentalFeatures={{ chatRooms: true }}
        initialComposerDraft={"https://github.com/owner/repo/issues/42\n\n"}
        initialComposerDraftNonce={1}
      />,
    );

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("https://github.com/owner/repo/issues/42\n\n"));

    setup({ activeSession: sessionTwo, sessions: [sessionOne, sessionTwo], filteredSessions: [sessionOne, sessionTwo], createSession });
    view.rerender(
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        experimentalFeatures={{ chatRooms: true }}
        initialComposerDraft={"https://github.com/owner/repo/issues/42\n\n"}
        initialComposerDraftNonce={1}
      />,
    );

    await waitFor(() => expect(screen.getByPlaceholderText("Type a message...")).toHaveValue("session two draft"));
  });

  it("uses room-scoped draft keys and keeps them isolated from direct drafts", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    localStorage.setItem("fusion:chat-draft:direct:session-001", "direct draft");
    localStorage.setItem("fusion:chat-draft:rooms:room-001", "room draft");

    await renderChatView();

    const textarea = screen.getByPlaceholderText("Type a message...");
    expect(textarea).toHaveValue("room draft");

    await userEvent.clear(textarea);
    await userEvent.type(textarea, "updated room draft");

    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:rooms:room-001")).toBe("updated room draft");
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBe("direct draft");
    });
  });
});

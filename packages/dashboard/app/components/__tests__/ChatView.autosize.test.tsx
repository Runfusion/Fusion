import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView, clampChatInputHeight } from "../ChatView";
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
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

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
  searchInTitleOnly: false,
  setSearchInTitleOnly: vi.fn(),
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

function renderChatView() {
  return render(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
}

describe("ChatView composer autosize", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    vi.clearAllMocks();
    localStorage.clear();
    mockDesktopViewport();
    setup();
  });

  it("resets composer height after send clears messageInput", async () => {
    const sendMessage = vi.fn();
    setup({ sendMessage });
    renderChatView();

    const textarea = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => (textarea.value.length > 0 ? 900 : 24),
    });

    await userEvent.type(textarea, "line one\nline two\nline three");
    const expandedHeight = Number.parseInt(textarea.style.height, 10);

    await userEvent.click(screen.getAllByTestId("chat-send-btn")[0]);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith("line one\nline two\nline three", []);
      expect(textarea).toHaveValue("");
      const resetHeight = Number.parseInt(textarea.style.height, 10);
      expect(resetHeight).toBeLessThan(expandedHeight);
      expect(resetHeight).toBe(clampChatInputHeight(24));
    });
  });

  it("recomputes height when draft restore switches to a shorter draft", async () => {
    localStorage.setItem("fusion:chat-draft:direct:session-001", "long long long long long");
    localStorage.setItem("fusion:chat-draft:direct:session-002", "ok");

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return (this as HTMLTextAreaElement).value.length > 4 ? 640 : 20;
      },
    });

    const { rerender } = renderChatView();
    const textarea = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;

    await waitFor(() => {
      expect(textarea).toHaveValue("long long long long long");
      expect(textarea.style.height).toBe(`${clampChatInputHeight(640)}px`);
    });

    setup({
      activeSession: sessionTwo,
      sessions: [sessionOne, sessionTwo],
      filteredSessions: [sessionOne, sessionTwo],
    });
    rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await waitFor(() => {
      expect(textarea).toHaveValue("ok");
      expect(textarea.style.height).toBe(`${clampChatInputHeight(20)}px`);
    });

    if (originalScrollHeight) {
      Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", originalScrollHeight);
    }
  });

  it("grows composer height as direct-chat content grows below cap", async () => {
    renderChatView();

    const textarea = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 40 + textarea.value.split("\n").length * 20,
    });

    await userEvent.type(textarea, "one");
    const oneLineHeight = Number.parseInt(textarea.style.height, 10);

    await userEvent.type(textarea, "\nTwo\nThree");
    const threeLineHeight = Number.parseInt(textarea.style.height, 10);

    expect(threeLineHeight).toBe(clampChatInputHeight(textarea.scrollHeight));
    expect(threeLineHeight).toBeGreaterThan(oneLineHeight);
  });

  it("keeps direct-chat text visible for growth between old and new caps", async () => {
    renderChatView();

    const textarea = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 500,
    });

    await userEvent.type(textarea, "large draft");

    expect(textarea.style.height).toBe("500px");
  });

  it("grows composer height in rooms scope", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    renderChatView();

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 40 + textarea.value.length,
    });

    await userEvent.type(textarea, "line one\nline two\nline three");

    expect(textarea.style.height).toBe(`${clampChatInputHeight(textarea.scrollHeight)}px`);
    expect(Number.parseInt(textarea.style.height, 10)).toBeGreaterThan(clampChatInputHeight(40));
  });

  it("keeps rooms text visible for growth between old and new caps", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    renderChatView();

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 500,
    });

    await userEvent.type(textarea, "room draft");

    expect(textarea.style.height).toBe("500px");
  });

  it("recomputes rooms composer height on room switch", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    const roomTwo = { ...roomOne, id: "room-002", name: "Room Two", slug: "room-two" };
    localStorage.setItem("fusion:chat-draft:rooms:room-001", "this is a much longer room draft");
    localStorage.setItem("fusion:chat-draft:rooms:room-002", "ok");

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return (this as HTMLTextAreaElement).value.length > 6 ? 220 : 60;
      },
    });

    setup({}, { rooms: [roomOne, roomTwo], activeRoom: roomOne });
    const { rerender } = renderChatView();
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;

    await waitFor(() => {
      expect(textarea).toHaveValue("this is a much longer room draft");
      expect(textarea.style.height).toBe(`${clampChatInputHeight(220)}px`);
    });

    setup({}, { rooms: [roomOne, roomTwo], activeRoom: roomTwo });
    rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await waitFor(() => {
      expect(textarea).toHaveValue("ok");
      expect(textarea.style.height).toBe(`${clampChatInputHeight(60)}px`);
    });

    if (originalScrollHeight) {
      Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", originalScrollHeight);
    }
  });

  it("uses the same clamp for direct typing and programmatic resets", async () => {
    const sendMessage = vi.fn();
    setup({ sendMessage });
    renderChatView();

    const textarea = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });

    await userEvent.type(textarea, "oversized");

    const typingHeight = textarea.style.height;
    expect(typingHeight).toBe(`${clampChatInputHeight(2000)}px`);

    await userEvent.click(screen.getAllByTestId("chat-send-btn")[0]);

    await waitFor(() => {
      expect(textarea).toHaveValue("");
      expect(textarea.style.height).toBe(`${clampChatInputHeight(2000)}px`);
      expect(textarea.style.height).toBe(typingHeight);
    });
  });
});

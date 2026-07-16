import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";
import { RoomMessageDeliveredButReplyFailedError, type UseChatRoomsResult } from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useMobileScrollLock", () => ({
  useMobileScrollLock: vi.fn(),
  useMobileKeyboardViewportLock: vi.fn(),
  useMobileViewportRestoreReset: vi.fn(),
  isIOS: () => true,
  _resetLockState: vi.fn(),
}));
vi.mock("../../hooks/useChatRooms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useChatRooms")>();
  return {
    ...actual,
    useChatRooms: vi.fn(),
  };
});
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
    fetchAgents: vi.fn().mockResolvedValue([
      { id: "agent-1", name: "Alpha", role: "executor", state: "idle", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
    ]),
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

const activeSession: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Test Chat",
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const defaultChatState: UseChatReturn = {
  sessions: [activeSession],
  activeSession,
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
  editMessageAndResend: vi.fn(),
  stopStreaming: vi.fn(),
  pendingMessages: [],
  clearPendingMessage: vi.fn(),
  loadMoreMessages: vi.fn(),
  hasMoreMessages: false,
  searchQuery: "",
  setSearchQuery: vi.fn(),
  filteredSessions: [activeSession],
  refreshSessions: vi.fn(),
  agentsMap: new Map(),
};

const roomA = {
  id: "room-a",
  name: "Room A",
  slug: "room-a",
  description: null,
  projectId: "proj-123",
  createdBy: "agent-1",
  status: "active" as const,
  thinkingLevel: null,
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const defaultRoomsState: UseChatRoomsResult = {
  rooms: [roomA],
  roomsLoading: false,
  roomsError: null,
  activeRoom: roomA,
  activeRoomMembers: [],
  messages: [{ id: "rmsg-1", roomId: "room-a", role: "user", content: "Room hello", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: null, mentions: [] }],
  messagesLoading: false,
  selectRoom: vi.fn(),
  createRoom: vi.fn(),
  updateRoomSettings: vi.fn(),
  deleteRoom: vi.fn(),
  sendRoomMessage: vi.fn(),
  clearRoom: vi.fn(),
  refreshRooms: vi.fn(),
};

function setup(chatOverrides: Partial<UseChatReturn> = {}, roomsOverrides: Partial<UseChatRoomsResult> = {}) {
  mockUseChat.mockReturnValue({ ...defaultChatState, ...chatOverrides });
  mockUseChatRooms.mockReturnValue({ ...defaultRoomsState, ...roomsOverrides });
}

function mockMobileViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mockMobileVisualViewport({ innerHeight, vvHeight }: { innerHeight: number; vvHeight: number }) {
  const resizeListeners = new Set<() => void>();
  const scrollListeners = new Set<() => void>();

  const mockVV = {
    height: vvHeight,
    offsetTop: 0,
    addEventListener: vi.fn((event: string, cb: () => void) => {
      if (event === "resize") resizeListeners.add(cb);
      if (event === "scroll") scrollListeners.add(cb);
    }),
    removeEventListener: vi.fn((event: string, cb: () => void) => {
      if (event === "resize") resizeListeners.delete(cb);
      if (event === "scroll") scrollListeners.delete(cb);
    }),
  };

  Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true, writable: true });
  Object.defineProperty(window, "visualViewport", { value: mockVV, configurable: true, writable: true });

  return { mockVV, listeners: { resize: resizeListeners, scroll: scrollListeners } };
}

function mockDesktopViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
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

function mockMessagesContainerMetrics({
  scrollHeight,
  clientHeight = 200,
  initialScrollTop = 0,
}: {
  scrollHeight: number;
  clientHeight?: number;
  initialScrollTop?: number;
}) {
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
  let scrollTopValue = initialScrollTop;

  Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrollTopValue,
    set: (value: number) => {
      scrollTopValue = value;
    },
  });

  return {
    getScrollTop: () => scrollTopValue,
    setScrollTop: (value: number) => {
      scrollTopValue = value;
    },
    restore: () => {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", scrollHeightDescriptor);
      } else {
        delete (HTMLDivElement.prototype as Partial<HTMLDivElement>).scrollHeight;
      }
      if (clientHeightDescriptor) {
        Object.defineProperty(HTMLDivElement.prototype, "clientHeight", clientHeightDescriptor);
      } else {
        delete (HTMLDivElement.prototype as Partial<HTMLDivElement>).clientHeight;
      }
      if (scrollTopDescriptor) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollTop", scrollTopDescriptor);
      } else {
        delete (HTMLDivElement.prototype as Partial<HTMLDivElement>).scrollTop;
      }
    },
  };
}

describe("ChatView — rooms (FN-3805..FN-3811 contract)", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    vi.clearAllMocks();
    localStorage.clear();
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
    }
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
    localStorage.setItem("fusion:chat-scope", "rooms");
    setup();
  });

  it.each([
    ["desktop", () => mockDesktopViewport(), {}],
    ["mobile/narrow", () => mockMobileViewport(), {}],
    ["floating/compact", () => mockDesktopViewport(), { floating: true, compactLayout: true }],
  ])("renders normalized room transcript oldest-first in the %s host", async (_host, setViewport, hostProps) => {
    setViewport();
    // This state is the ascending result of the newest-first API fixture covered by useChatRooms.
    setup({}, {
      messages: [
        { id: "room-user-hi", roomId: roomA.id, role: "user", content: "Old user Hi", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: null, mentions: [] },
        { id: "room-cto-reply", roomId: roomA.id, role: "assistant", content: "Newer CTO reply", createdAt: "2026-04-08T00:02:00.000Z", senderAgentId: "cto", mentions: [] },
        { id: "room-pm-reply", roomId: roomA.id, role: "assistant", content: "Newest PM reply", createdAt: "2026-04-08T00:02:01.000Z", senderAgentId: "pm", mentions: [] },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} {...hostProps} />);

    const rendered = [
      screen.getByText("Old user Hi"),
      screen.getByText("Newer CTO reply"),
      screen.getByText("Newest PM reply"),
    ];
    expect(rendered[0]!.compareDocumentPosition(rendered[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(rendered[1]!.compareDocumentPosition(rendered[2]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("renders Direct/Rooms toggle and allows room selection without message leakage", async () => {
    const selectRoom = vi.fn();
    const roomB = { ...roomA, id: "room-b", name: "Room B", slug: "room-b" };
    setup({}, { rooms: [roomA, roomB], selectRoom });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.getByTestId("chat-sidebar-scope-direct")).toBeInTheDocument();
    expect(screen.getByTestId("chat-sidebar-scope-rooms")).toBeInTheDocument();
    expect(screen.getByText("Room hello")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("chat-room-item-room-b"));
    expect(selectRoom).toHaveBeenCalledWith("room-b");
  });

  it("filters room messages that are trimmed-exact skip sentinels", async () => {
    setup({}, {
      messages: [
        { id: "rmsg-skip", roomId: "room-a", role: "assistant", content: "  __SKIP__  ", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] },
        { id: "rmsg-token", roomId: "room-a", role: "assistant", content: "use __SKIP__ as a token", createdAt: "2026-04-08T00:01:00.000Z", senderAgentId: "agent-1", mentions: [] },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await waitFor(() => {
      expect(screen.queryByTestId("chat-message-rmsg-skip")).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-message-rmsg-token")).toBeInTheDocument();
    });
  });

  it("shows Create room in mobile footer for Rooms scope and hides New Chat + rooms header", async () => {
    const viewportSpy = mockMobileViewport();

    const { container } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const createRoomButton = screen.getByTestId("chat-create-room-btn");
    expect(createRoomButton.closest(".chat-sidebar-footer")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-new-btn")).not.toBeInTheDocument();
    expect(container.querySelector(".chat-sidebar-rooms-header")).not.toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it("keeps Create room in rooms header on desktop and omits rooms footer", async () => {
    const viewportSpy = mockDesktopViewport();

    const { container } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const createRoomButton = screen.getByTestId("chat-create-room-btn");
    expect(createRoomButton.closest(".chat-sidebar-rooms-header")).toBeInTheDocument();
    expect(container.querySelector(".chat-sidebar-footer")).not.toBeInTheDocument();

    viewportSpy.mockRestore();
  });

  it.each([
    { memberCount: 1, expectedText: "1 member" },
    { memberCount: 2, expectedText: "2 members" },
  ])("shows active room member count ($expectedText) and hides inactive meta", async ({ memberCount, expectedText }) => {
    const roomB = { ...roomA, id: "room-b", name: "Room B", slug: "room-b" };
    const activeMembers = Array.from({ length: memberCount }, (_, index) => ({
      roomId: roomA.id,
      agentId: `agent-${index + 1}`,
      role: "member" as const,
      addedAt: "2026-04-08T00:00:00.000Z",
    }));

    setup({}, { rooms: [roomA, roomB], activeRoom: roomA, activeRoomMembers: activeMembers });

    const { container } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const activeRow = screen.getByTestId("chat-room-item-room-a");
    const inactiveRow = screen.getByTestId("chat-room-item-room-b");

    expect(within(activeRow).getByText(expectedText)).toBeInTheDocument();
    expect(within(activeRow).queryByText("— members")).not.toBeInTheDocument();
    expect(within(inactiveRow).getByText("#Room B")).toBeInTheDocument();
    expect(inactiveRow.querySelector(".chat-room-item-meta")).toBeNull();
    expect(container.textContent).not.toContain("— members");
  });

  it("creates room via modal and sends room message on Enter", async () => {
    const createRoom = vi.fn().mockResolvedValue({ ...roomA, id: "room-new", name: "Room New", slug: "room-new" });
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { createRoom, sendRoomMessage });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-create-room-btn"));
    await userEvent.type(screen.getByLabelText("Room name"), "room-new");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/i }));
    const modal = screen.getByRole("dialog", { name: "Create room" });
    await userEvent.click(within(modal).getByRole("button", { name: "Create room" }));

    await waitFor(() => {
      expect(createRoom).toHaveBeenCalledWith({ name: "room-new", memberAgentIds: ["agent-1"] });
    });

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Hello room{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Hello room", { files: [] });
    });
    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("renders the room composer thinking control beside attach and updates room settings", async () => {
    const updateRoomSettings = vi.fn().mockResolvedValue({ ...roomA, thinkingLevel: "high" });
    setup({}, { activeRoom: { ...roomA, thinkingLevel: "medium" }, updateRoomSettings });

    const { container } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const header = container.querySelector(".chat-room-thread-header");
    expect(header?.querySelector("[data-testid='chat-room-thinking-level']")).toBeNull();
    expect(header?.querySelector("label[for='chat-room-thinking-level']")).toBeNull();
    expect(header?.querySelector(".chat-room-thinking-level-field")).toBeNull();

    const attachButton = screen.getByTestId("chat-attach-btn");
    const thinkingButton = screen.getByTestId("chat-thinking-btn");
    expect(attachButton.nextElementSibling).toContainElement(thinkingButton);

    await userEvent.click(thinkingButton);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByTestId("chat-thinking-option-default")).toHaveTextContent(/Default/);
    for (const label of ["Off", "Minimal", "Low", "Medium", "High", "Very High"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByTestId("chat-thinking-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-model-picker")).toBeNull();

    await userEvent.click(screen.getByTestId("chat-thinking-option-high"));
    expect(updateRoomSettings).toHaveBeenCalledWith("room-a", { thinkingLevel: "high" });

    await userEvent.click(thinkingButton);
    await userEvent.click(screen.getByTestId("chat-thinking-option-default"));
    expect(updateRoomSettings).toHaveBeenCalledWith("room-a", { thinkingLevel: null });
  });

  it("shows a room thinking update failure toast", async () => {
    const addToast = vi.fn();
    const updateRoomSettings = vi.fn().mockRejectedValue(new Error("update failed"));
    setup({}, { updateRoomSettings });

    await renderWithAct(<ChatView projectId="proj-123" addToast={addToast} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-thinking-btn"));
    await userEvent.click(screen.getByTestId("chat-thinking-option-high"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Failed to update room thinking effort", "error");
    });
  });

  it("keeps the level-only thinking control reachable beside attach on mobile", async () => {
    const viewportSpy = mockMobileViewport();

    const { container } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const header = container.querySelector(".chat-room-thread-header");
    expect(header).toBeNull();
    expect(container.querySelector("[data-testid='chat-room-thinking-level']")).toBeNull();
    expect(container.querySelector("label[for='chat-room-thinking-level']")).toBeNull();
    expect(container.querySelector(".chat-room-thinking-level-field")).toBeNull();

    const attachButton = screen.getByTestId("chat-attach-btn");
    const thinkingButton = screen.getByTestId("chat-thinking-btn");
    expect(attachButton.nextElementSibling).toContainElement(thinkingButton);
    await userEvent.click(thinkingButton);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-thinking-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("chat-thinking-model-picker")).toBeNull();

    viewportSpy.mockRestore();
  });

  it("omits the room composer thinking control when no room is active", async () => {
    setup({}, { activeRoom: null });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.queryByTestId("chat-thinking-btn")).toBeNull();
  });

  it("passes attachment file list shape to room sends", async () => {
    const addToast = vi.fn();
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={addToast} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Room upload{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Room upload", { files: [] });
    });
    expect(addToast).not.toHaveBeenCalledWith(expect.stringMatching(/attach/i), "warning");
  });

  it("blocks concurrent room send dispatches while send is in flight", async () => {
    let resolveSend: () => void;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const sendRoomMessage = vi.fn().mockReturnValue(sendPromise);
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "single send");

    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledTimes(1);
      expect(sendRoomMessage).toHaveBeenCalledWith("single send", { files: [] });
    });

    resolveSend!();
    await act(async () => {
      await sendPromise;
    });
  });

  it("FN-5360 keeps room composer cleared when delivery succeeded but reply generation failed", async () => {
    const addToast = vi.fn();
    const sendRoomMessage = vi
      .fn()
      .mockRejectedValueOnce(new RoomMessageDeliveredButReplyFailedError("No active room responders available", "room-a"));
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={addToast} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Will retry{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Will retry", { files: [] });
    });
    await waitFor(() => {
      expect(textarea.value).toBe("");
    });
    expect(addToast).toHaveBeenCalledWith("Message sent, but assistant reply failed: No active room responders available", "error");
  });

  it("FN-5360 restores room composer when delivery fails", async () => {
    const addToast = vi.fn();
    const sendRoomMessage = vi.fn().mockRejectedValueOnce(new Error("POST failed"));
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={addToast} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Will retry{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Will retry", { files: [] });
    });
    await waitFor(() => {
      expect(textarea.value).toBe("Will retry");
    });
    expect(addToast).toHaveBeenCalledWith("POST failed", "error");
  });

  it("clears room composer on Enter when room send succeeds", async () => {
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Delivered{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Delivered", { files: [] });
    });
    await waitFor(() => {
      expect(textarea.value).toBe("");
    });
  });

  it("clears room composer optimistically before send resolves", async () => {
    let resolveSend: () => void;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const sendRoomMessage = vi.fn().mockReturnValue(sendPromise);
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "Optimistic clear{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("Optimistic clear", { files: [] });
    });
    expect(textarea.value).toBe("");

    resolveSend!();

    await waitFor(() => {
      expect(textarea.value).toBe("");
    });
  });

  it("intercepts exact /clear in rooms scope and clears active room", async () => {
    const clearRoom = vi.fn().mockResolvedValue(undefined);
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { clearRoom, sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "  /clear  {enter}");

    await waitFor(() => {
      expect(clearRoom).toHaveBeenCalledWith("room-a");
    });
    expect(sendRoomMessage).not.toHaveBeenCalled();
  });

  it("intercepts exact /new in rooms scope and clears active room", async () => {
    const clearRoom = vi.fn().mockResolvedValue(undefined);
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { clearRoom, sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "  /new  {enter}");

    await waitFor(() => {
      expect(clearRoom).toHaveBeenCalledWith("room-a");
    });
    expect(sendRoomMessage).not.toHaveBeenCalled();
  });

  it("does not intercept /clear substring commands in rooms scope", async () => {
    const clearRoom = vi.fn().mockResolvedValue(undefined);
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { clearRoom, sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "/clear now{enter}");

    await waitFor(() => {
      expect(sendRoomMessage).toHaveBeenCalledWith("/clear now", { files: [] });
    });
    expect(clearRoom).not.toHaveBeenCalled();
  });

  it("toasts error when room clear command fails", async () => {
    const addToast = vi.fn();
    const clearRoom = vi.fn().mockRejectedValue(new Error("clear failed"));
    setup({}, { clearRoom, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={addToast} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    await userEvent.type(textarea, "/clear{enter}");

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Failed to clear room conversation", "error");
    });
  });

  it("supports delete-room confirm/cancel and rerenders messages from hook state", async () => {
    const deleteRoom = vi.fn().mockResolvedValue(undefined);
    const rerenderedRooms = {
      ...defaultRoomsState,
      messages: [{ id: "rmsg-2", roomId: "room-a", role: "assistant", content: "Updated room reply", createdAt: "2026-04-08T00:00:10.000Z", senderAgentId: "agent-2", mentions: [] }],
      deleteRoom,
    };

    mockUseChat.mockReturnValue(defaultChatState);
    mockUseChatRooms
      .mockReturnValueOnce({ ...defaultRoomsState, deleteRoom })
      .mockReturnValue(rerenderedRooms);

    const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.click(screen.getByTestId("chat-room-delete-room-a"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteRoom).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("chat-room-delete-room-a"));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(deleteRoom).toHaveBeenCalledWith("room-a");
    });

    rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
    expect(screen.getByText("Updated room reply")).toBeInTheDocument();
  });

  it("shows mobile back button in room thread view", async () => {
    const mediaSpy = mockMobileViewport();
    setup();

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-room-item-room-a"));

    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    mediaSpy.mockRestore();
  });

  it("keeps room composer touch-focus behavior in parity with direct chat on mobile", async () => {
    const mediaSpy = mockMobileViewport();
    setup(
      {
        activeSession,
        messages: [{ id: "msg-1", sessionId: activeSession.id, role: "assistant", content: "Direct hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      },
      {
        activeRoom: roomA,
        messages: [{ id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "Room hello", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] }],
      },
    );

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const roomInput = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    const roomTouchEvent = new TouchEvent("touchstart", { bubbles: true, cancelable: true });
    const roomPreventDefaultSpy = vi.spyOn(roomTouchEvent, "preventDefault");
    await act(async () => {
      fireEvent(roomInput, roomTouchEvent);
      if (!roomTouchEvent.defaultPrevented) {
        roomInput.focus();
      }
    });
    expect(roomPreventDefaultSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(roomInput);

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-direct"));

    const directInput = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    const directTouchEvent = new TouchEvent("touchstart", { bubbles: true, cancelable: true });
    const directPreventDefaultSpy = vi.spyOn(directTouchEvent, "preventDefault");
    await act(async () => {
      fireEvent(directInput, directTouchEvent);
      if (!directTouchEvent.defaultPrevented) {
        directInput.focus();
      }
    });
    expect(directPreventDefaultSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(directInput);

    mediaSpy.mockRestore();
  });

  it("FN-6563 sends a room message exactly once when iOS suppresses the trailing click", async () => {
    const mediaSpy = mockMobileViewport();
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.type(screen.getByTestId("chat-input"), "Room iOS tap");
    const sendButton = screen.getByTestId("chat-send-btn");
    await act(async () => {
      sendButton.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" }));
    });

    await waitFor(() => expect(sendRoomMessage).toHaveBeenCalledTimes(1));
    expect(sendRoomMessage).toHaveBeenCalledWith("Room iOS tap", { files: [] });
    mediaSpy.mockRestore();
  });

  it("FN-6576 sends each of two consecutive room iOS taps within the click-latch window", async () => {
    const mediaSpy = mockMobileViewport();
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Room first" } });
    const firstSendButton = screen.getByTestId("chat-send-btn");
    await act(async () => {
      firstSendButton.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" }));
    });
    await waitFor(() => expect(sendRoomMessage).toHaveBeenCalledTimes(1));
    expect(sendRoomMessage).toHaveBeenLastCalledWith("Room first", { files: [] });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Room second" } });
    const secondSendButton = screen.getByTestId("chat-send-btn");
    await act(async () => {
      secondSendButton.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" }));
    });

    await waitFor(() => expect(sendRoomMessage).toHaveBeenCalledTimes(2));
    expect(sendRoomMessage).toHaveBeenLastCalledWith("Room second", { files: [] });
    mediaSpy.mockRestore();
  });

  it("FN-6563 sends a room message exactly once for a full Android tap sequence", async () => {
    const mediaSpy = mockMobileViewport();
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.type(screen.getByTestId("chat-input"), "Room Android tap");
    const sendButton = screen.getByTestId("chat-send-btn");
    await act(async () => {
      sendButton.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" }));
      sendButton.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
      sendButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(sendRoomMessage).toHaveBeenCalledTimes(1));
    expect(sendRoomMessage).toHaveBeenCalledWith("Room Android tap", { files: [] });
    mediaSpy.mockRestore();
  });

  it("FN-6563 sends a room message exactly once for a desktop mouse click sequence", async () => {
    const mediaSpy = mockDesktopViewport();
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({}, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.type(screen.getByTestId("chat-input"), "Room desktop tap");
    const sendButton = screen.getByTestId("chat-send-btn");
    await act(async () => {
      sendButton.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "mouse" }));
      sendButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(sendRoomMessage).toHaveBeenCalledTimes(1));
    expect(sendRoomMessage).toHaveBeenCalledWith("Room desktop tap", { files: [] });
    mediaSpy.mockRestore();
  });

  it("FN-6563 keeps direct send routing single-fired after a room mobile gesture", async () => {
    const mediaSpy = mockMobileViewport();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    setup({ sendMessage, activeSession }, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    await userEvent.type(screen.getByTestId("chat-input"), "Room first");
    const roomSendButton = screen.getByTestId("chat-send-btn");
    await act(async () => {
      roomSendButton.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" }));
      roomSendButton.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
      roomSendButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(sendRoomMessage).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByTestId("chat-sidebar-scope-direct"));
    await userEvent.type(screen.getByTestId("chat-input"), "Direct second");
    const directSendButton = screen.getByTestId("chat-send-btn");
    await act(async () => {
      directSendButton.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" }));
      directSendButton.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
      directSendButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith("Direct second", []);
    expect(sendRoomMessage).toHaveBeenCalledTimes(1);
    mediaSpy.mockRestore();
  });

  it("applies keyboard-active thread layout in room mode on mobile and preserves direct-chat parity", async () => {
    const mediaSpy = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({ innerHeight: 800, vvHeight: 800 });
    const originalVisualViewport = window.visualViewport;
    const originalInnerHeight = window.innerHeight;

    try {
      setup(
        {
          activeSession: activeSession,
          messages: [{ id: "msg-1", sessionId: activeSession.id, role: "assistant", content: "Direct hello", createdAt: "2026-04-08T00:00:00.000Z" }],
        },
        {
          activeRoom: roomA,
          messages: [{ id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "Room hello", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] }],
        },
      );

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        input.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", { value: 560, configurable: true, writable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });

      const roomThread = document.querySelector(".chat-thread") as HTMLDivElement;
      await waitFor(() => {
        expect(roomThread.classList.contains("chat-thread--keyboard-active")).toBe(true);
        expect(roomThread.style.getPropertyValue("--keyboard-overlap")).toBe("240px");
      });

      await userEvent.click(screen.getByTestId("chat-sidebar-scope-direct"));
      const directInput = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        directInput.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      const directThread = document.querySelector(".chat-thread") as HTMLDivElement;
      await waitFor(() => {
        expect(directThread.classList.contains("chat-thread--keyboard-active")).toBe(true);
        expect(directThread.style.getPropertyValue("--keyboard-overlap")).toBe("240px");
      });
    } finally {
      Object.defineProperty(window, "visualViewport", { value: originalVisualViewport, configurable: true, writable: true });
      Object.defineProperty(window, "innerHeight", { value: originalInnerHeight, configurable: true, writable: true });
      mediaSpy.mockRestore();
    }
  });

  it("FN-4118: anchors an already-loaded active room to the live tail on mount and remount", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    const metrics = mockMessagesContainerMetrics({ scrollHeight: 960, clientHeight: 240 });

    try {
      setup({}, {
        activeRoom: roomA,
        messagesLoading: false,
        messages: [
          { id: "rmsg-1", roomId: roomA.id, role: "user", content: "Room hello", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: null, mentions: [] },
          { id: "rmsg-2", roomId: roomA.id, role: "assistant", content: "Latest room reply", createdAt: "2026-04-08T00:00:10.000Z", senderAgentId: "agent-1", mentions: [] },
        ],
      });

      const { unmount } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await waitFor(() => {
        expect(metrics.getScrollTop()).toBe(960);
      });

      metrics.setScrollTop(0);
      unmount();

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await waitFor(() => {
        expect(metrics.getScrollTop()).toBe(960);
      });
    } finally {
      metrics.restore();
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-4118: anchors to the live tail when a new room message arrives", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    const metrics = mockMessagesContainerMetrics({ scrollHeight: 980, clientHeight: 240 });

    try {
      setup({}, {
        activeRoom: roomA,
        messages: [{ id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] }],
      });
      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      metrics.setScrollTop(980);
      fireEvent.scroll(messagesContainer);
      setup({}, {
        activeRoom: roomA,
        messages: [
          { id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] },
          { id: "rmsg-2", roomId: roomA.id, role: "assistant", content: "Two", createdAt: "2026-04-08T00:00:10.000Z", senderAgentId: "agent-1", mentions: [] },
        ],
      });
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await waitFor(() => {
        expect(metrics.getScrollTop()).toBe(980);
      });
    } finally {
      metrics.restore();
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-4118: does not yank room scrollback readers when new messages arrive", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    const metrics = mockMessagesContainerMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 720 });

    try {
      setup({}, {
        activeRoom: roomA,
        messages: [{ id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] }],
      });
      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      metrics.setScrollTop(720);
      fireEvent.scroll(messagesContainer);

      setup({}, {
        activeRoom: roomA,
        messages: [
          { id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] },
          { id: "rmsg-2", roomId: roomA.id, role: "assistant", content: "Two", createdAt: "2026-04-08T00:00:10.000Z", senderAgentId: "agent-1", mentions: [] },
        ],
      });
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await waitFor(() => {
        expect(metrics.getScrollTop()).toBe(720);
      });
    } finally {
      metrics.restore();
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-4118: mobile visibility restore re-anchors an active room thread", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const metrics = mockMessagesContainerMetrics({ scrollHeight: 1180, clientHeight: 240, initialScrollTop: 250 });

    try {
      setup({}, {
        activeRoom: roomA,
        messages: [{ id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      fireEvent(document, new Event("visibilitychange"));
      metrics.setScrollTop(300);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));

      // Regression guard: visibility restore must explicitly re-anchor when pinned.
      // This previously passed only when an old anchorToBottom rAF happened to run
      // after the visibility event and masked that the handler only captured a snapshot.
      expect(metrics.getScrollTop()).toBe(1180);
    } finally {
      metrics.restore();
      restoreMatchMedia.mockRestore();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  it("FN-4118: mobile pageshow restore re-anchors an active room thread", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const metrics = mockMessagesContainerMetrics({ scrollHeight: 1180, clientHeight: 240, initialScrollTop: 250 });

    try {
      setup({}, {
        activeRoom: roomA,
        messages: [{ id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      metrics.setScrollTop(300);
      fireEvent(window, new Event("pageshow"));

      // Regression guard: pageshow shares the visibility restore path and must not
      // depend on leftover rAF callbacks from the initial mount anchor.
      expect(metrics.getScrollTop()).toBe(1180);
    } finally {
      metrics.restore();
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-4327: desktop visibility restore does not re-anchor active room thread", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    const metrics = mockMessagesContainerMetrics({ scrollHeight: 1180, clientHeight: 240, initialScrollTop: 250 });

    try {
      setup({}, {
        activeRoom: roomA,
        messages: [{ id: "rmsg-1", roomId: roomA.id, role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      metrics.setScrollTop(300);
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));

      expect(metrics.getScrollTop()).toBe(300);
    } finally {
      metrics.restore();
      restoreMatchMedia.mockRestore();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  describe("room switcher dropdown", () => {
    it("renders trigger with active room and menu semantics", async () => {
      setup({}, { activeRoom: roomA, rooms: [roomA] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const trigger = screen.getByTestId("chat-room-switcher-trigger");
      expect(trigger).toHaveTextContent("#Room A");
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    });

    it("opens dropdown, lists rooms, and marks active option", async () => {
      const roomB = { ...roomA, id: "room-b", name: "Room B", slug: "room-b" };
      setup({}, { activeRoom: roomA, rooms: [roomA, roomB] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await userEvent.click(screen.getByTestId("chat-room-switcher-trigger"));

      const dropdown = screen.getByTestId("chat-room-switcher-dropdown");
      expect(dropdown).toBeInTheDocument();
      expect(screen.getByTestId("chat-room-switcher-option-room-a")).toHaveClass("chat-room-switcher-option--active");
      expect(screen.getByTestId("chat-room-switcher-option-room-b")).toBeInTheDocument();
    });

    it("selects a different room and closes dropdown", async () => {
      const roomB = { ...roomA, id: "room-b", name: "Room B", slug: "room-b" };
      const selectRoom = vi.fn();
      setup({}, { activeRoom: roomA, rooms: [roomA, roomB], selectRoom });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await userEvent.click(screen.getByTestId("chat-room-switcher-trigger"));
      await userEvent.click(screen.getByTestId("chat-room-switcher-option-room-b"));

      expect(selectRoom).toHaveBeenCalledWith("room-b");
      expect(screen.queryByTestId("chat-room-switcher-dropdown")).not.toBeInTheDocument();
    });

    it("closes dropdown on Escape", async () => {
      const roomB = { ...roomA, id: "room-b", name: "Room B", slug: "room-b" };
      setup({}, { activeRoom: roomA, rooms: [roomA, roomB] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await userEvent.click(screen.getByTestId("chat-room-switcher-trigger"));
      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.queryByTestId("chat-room-switcher-dropdown")).not.toBeInTheDocument();
    });

    it("closes dropdown on outside click", async () => {
      const roomB = { ...roomA, id: "room-b", name: "Room B", slug: "room-b" };
      setup({}, { activeRoom: roomA, rooms: [roomA, roomB] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await userEvent.click(screen.getByTestId("chat-room-switcher-trigger"));
      fireEvent.mouseDown(screen.getByText("Room hello"));

      expect(screen.queryByTestId("chat-room-switcher-dropdown")).not.toBeInTheDocument();
    });
  });

  it("renders unread dots for unread direct sessions and hides dot for active session", async () => {
    const selectSession = vi.fn();
    const sessionA: ChatSessionInfo = {
      ...activeSession,
      id: "session-a",
      title: "Session A",
      updatedAt: "2026-04-08T00:00:00.000Z",
      lastMessageAt: "2026-04-08T00:00:00.000Z",
    };
    const sessionB: ChatSessionInfo = {
      ...activeSession,
      id: "session-b",
      title: "Session B",
      updatedAt: "2026-04-08T01:00:00.000Z",
      lastMessageAt: "2026-04-08T01:00:00.000Z",
    };

    localStorage.setItem("fusion:chat-scope", "direct");
    localStorage.setItem("kb:proj-123:fusion:chat-unread:direct", JSON.stringify({ "session-a": "2026-04-08T00:00:00.000Z" }));

    setup({
      sessions: [sessionA, sessionB],
      filteredSessions: [sessionA, sessionB],
      activeSession: sessionA,
      selectSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.queryByTestId("chat-unread-dot-session-a")).toBeNull();
    expect(screen.getByTestId("chat-unread-dot-session-b")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("chat-session-session-b"));
    expect(selectSession).toHaveBeenCalledWith("session-b");
    expect(localStorage.getItem("kb:proj-123:fusion:chat-unread:direct")).toContain("session-b");
  });

  it("renders unread dots for unread rooms", async () => {
    localStorage.setItem("fusion:chat-scope", "rooms");
    localStorage.setItem("kb:proj-123:fusion:chat-unread:rooms", JSON.stringify({ "room-a": "2026-04-08T00:00:00.000Z" }));

    const roomB = {
      ...roomA,
      id: "room-b",
      name: "Room B",
      slug: "room-b",
      updatedAt: "2026-04-08T01:00:00.000Z",
    };

    setup({}, { rooms: [roomA, roomB], activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(screen.queryByTestId("chat-unread-dot-room-a")).toBeNull();
    expect(screen.getByTestId("chat-unread-dot-room-b")).toBeInTheDocument();
  });

  it("keeps direct mode behavior unchanged when rooms are enabled", async () => {
    localStorage.setItem("fusion:chat-scope", "direct");
    const addToast = vi.fn();
    const sendMessage = vi.fn();
    const sendRoomMessage = vi.fn().mockRejectedValue(new Error("Room backend failed"));
    setup({ sendMessage }, { sendRoomMessage, activeRoom: roomA });

    await renderWithAct(<ChatView projectId="proj-123" addToast={addToast} experimentalFeatures={{ chatRooms: true }} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "Direct hello{enter}");

    expect(sendMessage).toHaveBeenCalledWith("Direct hello", []);
    expect(sendRoomMessage).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

vi.mock("../../hooks/useChat");
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
    fetchAgents: vi.fn().mockResolvedValue([{ id: "agent-1", name: "Alpha", role: "executor", state: "idle", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} }]),
  };
});
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    ArrowUpToLine: (props: any) => <svg data-testid="icon-arrow-up-to-line" {...props} />,
  };
});

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
  stopStreaming: vi.fn(),
  pendingMessage: "",
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
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const defaultRoomsState: UseChatRoomsResult = {
  rooms: [roomA],
  roomsLoading: false,
  roomsError: null,
  activeRoom: roomA,
  activeRoomMembers: [],
  messages: [],
  messagesLoading: false,
  selectRoom: vi.fn(),
  createRoom: vi.fn(),
  deleteRoom: vi.fn(),
  sendRoomMessage: vi.fn(),
  clearRoom: vi.fn(),
  refreshRooms: vi.fn(),
};

function setup(chatOverrides: Partial<UseChatReturn> = {}, roomsOverrides: Partial<UseChatRoomsResult> = {}, experimentalFeatures?: Record<string, boolean>) {
  mockUseChat.mockReturnValue({ ...defaultChatState, ...chatOverrides });
  mockUseChatRooms.mockReturnValue({ ...defaultRoomsState, ...roomsOverrides });
  return render(<ChatView addToast={vi.fn()} experimentalFeatures={experimentalFeatures} />);
}

describe("ChatView scroll-to-top message affordance", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("renders on assistant messages and not on user or failed assistant messages", () => {
    setup({
      messages: [
        { id: "assistant-ok", sessionId: activeSession.id, role: "assistant", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "assistant-failed", sessionId: activeSession.id, role: "assistant", content: "failed", createdAt: "2026-04-08T00:00:01.000Z", failureInfo: { summary: "oops" } },
        { id: "user-1", sessionId: activeSession.id, role: "user", content: "hey", createdAt: "2026-04-08T00:00:02.000Z" },
      ],
    });

    expect(screen.getByTestId("chat-message-scroll-to-top-assistant-ok")).toHaveAttribute("aria-label", "Scroll message to top");
    expect(screen.queryByTestId("chat-message-scroll-to-top-assistant-failed")).toBeNull();
    expect(screen.queryByTestId("chat-message-scroll-to-top-user-1")).toBeNull();
  });

  it("scrolls container to message top with smooth behavior", () => {
    setup({
      messages: [
        { id: "assistant-ok", sessionId: activeSession.id, role: "assistant", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    const target = screen.getByTestId("chat-message-assistant-ok") as HTMLDivElement;
    Object.defineProperty(container, "scrollTop", { configurable: true, writable: true, value: 20 });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 260 } as DOMRect);

    fireEvent.click(screen.getByTestId("chat-message-scroll-to-top-assistant-ok"));

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 180, behavior: "smooth" });
  });

  it("uses auto behavior when reduced motion is preferred", () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    setup({
      messages: [
        { id: "assistant-ok", sessionId: activeSession.id, role: "assistant", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    const container = document.querySelector(".chat-messages") as HTMLDivElement;
    const target = screen.getByTestId("chat-message-assistant-ok") as HTMLDivElement;
    Object.defineProperty(container, "scrollTop", { configurable: true, writable: true, value: 0 });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 120 } as DOMRect);

    const button = screen.getByTestId("chat-message-scroll-to-top-assistant-ok");
    button.focus();
    fireEvent.click(button);

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 120, behavior: "auto" });
  });

  it("renders the affordance for room assistant messages", () => {
    setup(
      {
        sessions: [activeSession],
        activeSession,
      },
      {
        messages: [
          { id: "room-assistant-1", roomId: roomA.id, role: "assistant", content: "Room response", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] },
        ],
      },
      { chatRooms: true },
    );

    fireEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));

    expect(screen.getByTestId("chat-message-scroll-to-top-room-assistant-1")).toBeInTheDocument();
  });
});

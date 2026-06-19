import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { ChatView } from "../ChatView";
import { loadAllAppCss } from "../../test/cssFixture";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatMessageInfo, ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
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
const css = loadAllAppCss();

const activeSession: ChatSessionInfo = {
  id: "session-001",
  agentId: "agent-001",
  status: "active",
  title: "Mobile chat",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
};

const messageFixture: ChatMessageInfo = {
  id: "msg-001",
  sessionId: activeSession.id,
  role: "assistant",
  content: "Hello from Fusion",
  createdAt: "2026-06-03T00:00:00.000Z",
};

const defaultChatState: UseChatReturn = {
  sessions: [],
  activeSession: null,
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
  filteredSessions: [],
  refreshSessions: vi.fn(),
  agentsMap: new Map([["agent-001", { id: "agent-001", name: "Alpha" }]]),
};

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

function ensureMatchMedia() {
  if (window.matchMedia) {
    return;
  }
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(),
  });
}

function mockViewportMode(mode: "mobile" | "tablet" | "desktop") {
  ensureMatchMedia();
  const widthByMode = {
    mobile: 375,
    tablet: 900,
    desktop: 1280,
  };
  Object.defineProperty(window, "innerWidth", { value: widthByMode[mode], configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches:
      (mode === "mobile" && query.includes("max-width: 768px")) ||
      (mode === "tablet" && query.includes("min-width: 769px") && query.includes("max-width: 1024px")),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mockVisualViewport({ height, width }: { height: number; width: number }) {
  const visualViewport = new EventTarget() as VisualViewport;
  Object.defineProperties(visualViewport, {
    height: { value: height, writable: true, configurable: true },
    width: { value: width, writable: true, configurable: true },
    offsetTop: { value: 0, writable: true, configurable: true },
    offsetLeft: { value: 0, writable: true, configurable: true },
    pageTop: { value: 0, writable: true, configurable: true },
    pageLeft: { value: 0, writable: true, configurable: true },
    scale: { value: 1, writable: true, configurable: true },
  });
  Object.defineProperty(window, "visualViewport", { value: visualViewport, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
  return visualViewport;
}

async function setVisualViewportHeight(visualViewport: VisualViewport, height: number) {
  Object.defineProperty(visualViewport, "height", { value: height, writable: true, configurable: true });
  await act(async () => {
    visualViewport.dispatchEvent(new Event("resize"));
  });
}

function getSidebar() {
  return document.querySelector(".chat-sidebar") as HTMLElement;
}

async function renderWithCss(ui: JSX.Element) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  let rendered = null;
  await act(async () => {
    rendered = render(ui);
  });
  return rendered;
}

function setupChat(overrides: Partial<UseChatReturn> = {}) {
  mockUseChat.mockReturnValue({ ...defaultChatState, ...overrides });
}

function setupRooms(overrides: Partial<UseChatRoomsResult> = {}) {
  mockUseChatRooms.mockReturnValue({ ...defaultRoomsState, ...overrides });
}

function expectMobileEmptyStateToSpanMessagePane(text: string) {
  const emptyState = screen.getByText(text).closest(".chat-empty-state") as HTMLElement | null;
  expect(emptyState).toBeTruthy();
  expect(emptyState?.parentElement?.classList.contains("chat-messages")).toBe(true);

  const messagesStyle = getComputedStyle(emptyState?.parentElement as HTMLElement);
  const emptyStateStyle = getComputedStyle(emptyState as HTMLElement);

  expect(messagesStyle.paddingLeft).toBe(messagesStyle.paddingRight);
  expect(emptyStateStyle.width).toBe("100%");
  expect(emptyStateStyle.display).toBe("flex");
  expect(emptyStateStyle.justifyContent).toBe("center");
  expect(emptyStateStyle.textAlign).toBe("center");
  expect(emptyStateStyle.boxSizing).toBe("border-box");
}

describe("FN-5997 mobile chat message pane rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.head.innerHTML = "";
    localStorage.clear();
    _resetInitialViewportHeight();
    setupChat();
    setupRooms();
  });

  it("lets the direct-thread mobile empty states span the message pane without mobile card chrome while preserving other states", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });

      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expectMobileEmptyStateToSpanMessagePane("No messages yet. Start the conversation!");
      expect(css).toMatch(/@media \(max-width: 768px\)\s*\{[\s\S]*\.chat-messages\s*\{[\s\S]*padding:\s*var\(--space-lg\) var\(--space-sm\);[\s\S]*\.chat-messages\s*>\s*\.chat-empty-state\s*\{[\s\S]*border:\s*none;[\s\S]*border-radius:\s*0;[\s\S]*background:\s*transparent;/);

      cleanup();
      document.head.innerHTML = "";
      setupChat();
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expectMobileEmptyStateToSpanMessagePane("Start a new conversation");
      const startConversationEmptyState = screen.getByText("Start a new conversation").closest(".chat-empty-state") as HTMLElement;
      expect(within(startConversationEmptyState).getByRole("button", { name: "New Chat" })).toBeInTheDocument();

      cleanup();
      document.head.innerHTML = "";
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
        messagesLoading: true,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expect(screen.getByText("Loading messages...")).toBeInTheDocument();

      cleanup();
      document.head.innerHTML = "";
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
        messages: [messageFixture],
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expect(screen.getByText("Hello from Fusion")).toBeInTheDocument();

      cleanup();
      document.head.innerHTML = "";
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
        isStreaming: true,
        streamingText: "Streaming reply",
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expect(screen.getByText("Streaming reply")).toBeInTheDocument();
      expect(screen.queryByText("No messages yet. Start the conversation!")).toBeNull();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("lets the rooms mobile empty pane span the message pane without mobile card chrome while preserving room loading and populated states", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      localStorage.setItem("fusion:chat-scope", "rooms");
      const activeRoom = {
        id: "room-001",
        projectId: "proj-123",
        slug: "eng",
        name: "eng",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      };

      setupRooms({
        rooms: [activeRoom],
        activeRoom,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      expectMobileEmptyStateToSpanMessagePane("No messages yet. Start the conversation!");

      cleanup();
      document.head.innerHTML = "";
      setupRooms({
        rooms: [activeRoom],
        activeRoom,
        messagesLoading: true,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
      expect(screen.getByText("Loading messages...")).toBeInTheDocument();

      cleanup();
      document.head.innerHTML = "";
      setupRooms({
        rooms: [activeRoom],
        activeRoom,
        messages: [{
          id: "room-msg-001",
          roomId: activeRoom.id,
          role: "assistant",
          content: "Room message",
          senderAgentId: "agent-001",
          attachments: [],
          metadata: null,
          mentions: [],
          createdAt: "2026-06-03T00:00:00.000Z",
        }],
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
      expect(screen.getByText("Room message")).toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("preserves the desktop message-pane invariant and does not recenter sidebar padded empty states", async () => {
    const restoreMatchMedia = mockViewportMode("desktop");
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagePaneEmptyState = screen.getByText("No messages yet. Start the conversation!").closest(".chat-empty-state");
      expect(messagePaneEmptyState).toBeTruthy();
      expect(getComputedStyle(messagePaneEmptyState as HTMLElement).display).toBe("flex");
      expect(getComputedStyle(messagePaneEmptyState as HTMLElement).justifyContent).toBe("center");
      expect(css).toMatch(/\.chat-messages\s*>\s*\.chat-empty-state\s*\{[\s\S]*border:\s*1px solid var\(--border\);[\s\S]*background:\s*var\(--surface\);/);

      cleanup();
      document.head.innerHTML = "";
      setupChat({
        sessionsLoading: true,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const sidebarEmptyState = screen.getByText("Loading...").closest(".chat-empty-state");
      expect(sidebarEmptyState).toBeTruthy();
      expect(getComputedStyle(sidebarEmptyState as HTMLElement).display).toBe("block");
      expect(getComputedStyle(sidebarEmptyState as HTMLElement).textAlign).toBe("left");
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("keeps the tablet sidebar at the same width while the software keyboard is open", async () => {
    const restoreMatchMedia = mockViewportMode("tablet");
    const visualViewport = mockVisualViewport({ width: 900, height: 1112 });
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const sidebar = getSidebar();
      expect(sidebar).not.toHaveClass("chat-sidebar--hidden");
      expect(sidebar.style.width).toBe("280px");
      expect(screen.getByRole("separator", { name: "Resize chat sidebar" })).toBeInTheDocument();

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        input.focus();
      });
      await setVisualViewportHeight(visualViewport, 560);

      await waitFor(() => expect(screen.queryByRole("separator", { name: "Resize chat sidebar" })).toBeNull());
      expect(sidebar.style.width).toBe("280px");
      expect(sidebar).not.toHaveClass("chat-sidebar--hidden");

      await act(async () => {
        input.blur();
      });
      await setVisualViewportHeight(visualViewport, 1112);

      await waitFor(() => expect(screen.getByRole("separator", { name: "Resize chat sidebar" })).toBeInTheDocument());
      expect(sidebar.style.width).toBe("280px");
      expect(sidebar).not.toHaveClass("chat-sidebar--hidden");
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("keeps a persisted custom tablet sidebar width while the software keyboard is open", async () => {
    const restoreMatchMedia = mockViewportMode("tablet");
    const visualViewport = mockVisualViewport({ width: 900, height: 1112 });
    localStorage.setItem("fusion:chat-sidebar-width", "360");
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const sidebar = getSidebar();
      await waitFor(() => expect(sidebar.style.width).toBe("360px"));
      expect(sidebar).not.toHaveClass("chat-sidebar--hidden");

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        input.focus();
      });
      await setVisualViewportHeight(visualViewport, 560);

      await waitFor(() => expect(screen.queryByRole("separator", { name: "Resize chat sidebar" })).toBeNull());
      expect(sidebar.style.width).toBe("360px");
      expect(sidebar).not.toHaveClass("chat-sidebar--hidden");

      await act(async () => {
        input.blur();
      });
      await setVisualViewportHeight(visualViewport, 1112);

      await waitFor(() => expect(screen.getByRole("separator", { name: "Resize chat sidebar" })).toBeInTheDocument());
      expect(sidebar.style.width).toBe("360px");
      expect(sidebar).not.toHaveClass("chat-sidebar--hidden");
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("keeps a user-collapsed sidebar collapsed across tablet keyboard open and close", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const visualViewport = mockVisualViewport({ width: 900, height: 1112 });
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const sidebar = getSidebar();
      await act(async () => {
        screen.getByTestId(`chat-session-${activeSession.id}`).click();
      });
      expect(sidebar).toHaveClass("chat-sidebar--hidden");

      Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
      restoreMatchMedia.mockImplementation((query: string) => ({
        matches: query.includes("min-width: 769px") && query.includes("max-width: 1024px"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });

      expect(sidebar).toHaveClass("chat-sidebar--hidden");
      expect(sidebar.style.width).toBe("280px");

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        input.focus();
      });
      await setVisualViewportHeight(visualViewport, 560);

      await waitFor(() => expect(screen.queryByRole("separator", { name: "Resize chat sidebar" })).toBeNull());
      expect(sidebar.style.width).toBe("280px");
      expect(sidebar).toHaveClass("chat-sidebar--hidden");

      await act(async () => {
        input.blur();
      });
      await setVisualViewportHeight(visualViewport, 1112);

      await waitFor(() => expect(sidebar.style.width).toBe("280px"));
      expect(sidebar).toHaveClass("chat-sidebar--hidden");
      expect(screen.queryByRole("separator", { name: "Resize chat sidebar" })).toBeNull();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("keeps sidebar width bounded even if viewport mode flickers to mobile during keyboard-open on tablet", async () => {
    const restoreMatchMedia = mockViewportMode("tablet");
    const originalScreenDescriptor = Object.getOwnPropertyDescriptor(window, "screen");
    const visualViewport = mockVisualViewport({ width: 900, height: 1112 });
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const sidebar = getSidebar();
      expect(sidebar).not.toHaveClass("chat-sidebar--hidden");
      expect(sidebar.style.width).toBe("280px");

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        input.focus();
      });
      await setVisualViewportHeight(visualViewport, 400);

      // Simulate the FN-6213 bug scenario where viewport mode transiently
      // resolves to mobile on a tablet while the keyboard has shrunk height.
      Object.defineProperty(window, "screen", { configurable: true, value: { width: 390, height: 844 } });
      restoreMatchMedia.mockImplementation((query: string) => ({
        matches:
          query.includes("max-width: 768px") ||
          query.includes("max-height: 480px"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });

      await waitFor(() => expect(sidebar.style.width).toBe(""));
      const maxWidth = parseInt(getComputedStyle(sidebar).maxWidth, 10);
      expect(maxWidth).toBeLessThanOrEqual(500);
      expect(sidebar.offsetWidth).toBeLessThanOrEqual(500);
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalScreenDescriptor) {
        Object.defineProperty(window, "screen", originalScreenDescriptor);
      }
    }
  });

  it("keeps the desktop sidebar fixed even if visualViewport shrinks while the composer is focused", async () => {
    const restoreMatchMedia = mockViewportMode("desktop");
    const visualViewport = mockVisualViewport({ width: 1280, height: 900 });
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const sidebar = getSidebar();
      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        input.focus();
      });
      await setVisualViewportHeight(visualViewport, 560);

      expect(sidebar).not.toHaveClass("chat-sidebar--hidden");
      expect(sidebar.style.width).toBe("280px");
      expect(screen.getByRole("separator", { name: "Resize chat sidebar" })).toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("keeps the existing mobile sidebar behavior unchanged when the keyboard opens", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const visualViewport = mockVisualViewport({ width: 375, height: 812 });
    try {
      setupChat({
        sessions: [activeSession],
        filteredSessions: [activeSession],
        activeSession,
      });
      await renderWithCss(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const sidebar = getSidebar();
      const initiallyHidden = sidebar.classList.contains("chat-sidebar--hidden");
      expect(sidebar.style.width).toBe("");
      expect(screen.queryByRole("separator", { name: "Resize chat sidebar" })).toBeNull();

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        input.focus();
      });
      await setVisualViewportHeight(visualViewport, 500);

      expect(sidebar.classList.contains("chat-sidebar--hidden")).toBe(initiallyHidden);
      expect(sidebar.style.width).toBe("");
      expect(screen.queryByRole("separator", { name: "Resize chat sidebar" })).toBeNull();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });
});

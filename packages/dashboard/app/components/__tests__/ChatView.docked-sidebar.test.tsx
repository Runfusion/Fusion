/*
FNXC:DashboardTests 2026-08-23-17:07:
FN-9200 keeps docked-sidebar eligibility behavioral: all tablet variants must expose the pane and
all embedded or floating hosts must retain the one-pane Back navigation.
*/
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ChatView, CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH, CHAT_DOCKED_SIDEBAR_MAX_WIDTH, CHAT_DOCKED_SIDEBAR_MIN_WIDTH, CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY, CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, clampChatDockedSidebarWidth } from "../ChatView";
import {
  createRoomFixture,
  installChatViewEnv,
  mockTabletClassTouchViewport,
  mockViewportMode,
  mockFetchModels,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

const session = {
  id: "session-001", agentId: "agent-001", status: "active" as const, title: "Architecture discussion",
  lastMessagePreview: "The latest conversation message", modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
  createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
};

async function renderSelected(props: Partial<React.ComponentProps<typeof ChatView>> = {}, selected = session) {
  const selectSession = vi.fn();
  setupMockChat({ activeSession: selected, sessions: [selected], filteredSessions: [selected], selectSession });
  const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} {...props} />);
  await act(async () => { fireEvent.click(screen.getByTestId(`chat-session-${selected.id}`)); });
  return { view, selectSession };
}

function expectDocked() {
  expect(document.querySelector(".chat-view")).toHaveClass("chat-view--docked-list");
  const sidebar = document.querySelector(".chat-sidebar") as HTMLElement;
  expect(sidebar).toHaveClass("chat-sidebar--docked");
  expect(sidebar.style.width).toBeTruthy();
  expect(screen.getByTestId("chat-docked-sidebar-toggle")).toBeInTheDocument();
  return screen.getByTestId("chat-sidebar-resize-handle");
}

function expectOnePaneHost() {
  expect(document.querySelector(".chat-view")).not.toHaveClass("chat-view--docked-list");
  expect(screen.queryByTestId("chat-docked-sidebar-toggle")).toBeNull();
  expect(screen.queryByTestId("chat-sidebar-resize-handle")).toBeNull();
  expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
}

describe("ChatView docked conversation sidebar", () => {
  it.each([
    ["desktop", () => mockViewportMode("desktop")],
    ["769-1024 tablet", () => mockViewportMode("tablet")],
    ["768px touch tablet", () => mockTabletClassTouchViewport()],
  ])("renders a resizable docked pane on %s", async (_name, installViewport) => {
    const restore = installViewport();
    try {
      const { view } = await renderSelected();
      const handle = expectDocked();
      expect(handle).toHaveAttribute("aria-valuenow", "300");
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(handle).toHaveAttribute("aria-valuenow", "316");
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(handle).toHaveAttribute("aria-valuenow", "300");
      view.unmount();
    } finally { restore(); }
  });

  it.each([
    ["mobile", { }, () => mockViewportMode("mobile")],
    ["compact right dock", { compactLayout: true }, () => mockViewportMode("desktop")],
    ["floating Quick Chat", { floating: true }, () => mockViewportMode("desktop")],
    ["popped-out chat", { floating: true, persistChatPreferences: false }, () => mockViewportMode("desktop")],
  ])("keeps %s in one-pane navigation", async (_name, props, installViewport) => {
    const restore = installViewport();
    // FN-9200 must prove the floating exclusion itself, not jsdom's zero-width narrow-host fallback.
    const bounds = props.floating
      ? vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect)
      : null;
    try {
      const { view } = await renderSelected(props);
      expectOnePaneHost();
      view.unmount();
    } finally { bounds?.mockRestore(); restore(); }
  });

  it("hides Back without leaving a header shell while docked, and restores it when closed", async () => {
    const { view } = await renderSelected();
    expectDocked();
    const header = document.querySelector(".chat-thread-header") as HTMLElement;
    expect(header.querySelector('[aria-label="Back to conversations"]')).toBeNull();
    expect(header.querySelector("button.btn, button.btn-icon")).toBeNull();
    expect(screen.getByTestId("chat-thread-header-identity")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-docked-sidebar-toggle"));
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    view.unmount();
  });

  it("keeps the Rooms scope inside the docked sidebar and removes its Back shell", async () => {
    const room = createRoomFixture("docked");
    localStorage.setItem("fusion:chat-scope", "rooms");
    setupMockChat({ sessions: [], filteredSessions: [] });
    setupMockRooms({ rooms: [room], activeRoom: room });
    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
    expectDocked();
    const rooms = screen.getByTestId("chat-sidebar-rooms");
    expect(rooms.closest(".chat-sidebar")).toHaveClass("chat-sidebar--docked");
    fireEvent.click(screen.getByTestId(`chat-room-item-${room.slug}`));
    const header = document.querySelector(".chat-room-thread-header") as HTMLElement;
    expect(header.querySelector('[aria-label="Back to conversations"]')).toBeNull();
    expect(header.querySelector("button.btn, button.btn-icon")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-docked-sidebar-toggle"));
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    view.unmount();
  });

  it("clamps widths and restores valid stored preferences at first render", async () => {
    expect(clampChatDockedSidebarWidth(100)).toBe(CHAT_DOCKED_SIDEBAR_MIN_WIDTH);
    expect(clampChatDockedSidebarWidth(900)).toBe(CHAT_DOCKED_SIDEBAR_MAX_WIDTH);
    expect(clampChatDockedSidebarWidth(300)).toBe(300);
    localStorage.setItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, "900");
    setupMockChat({ sessions: [], filteredSessions: [] });
    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe(`${CHAT_DOCKED_SIDEBAR_MAX_WIDTH}px`);
    view.unmount();
  });

  it("persists resize and open state across unmount/remount", async () => {
    const { view } = await renderSelected();
    const handle = screen.getByTestId("chat-sidebar-resize-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 180 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 180 });
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY)).toBe("380");
    fireEvent.click(screen.getByTestId("chat-docked-sidebar-toggle"));
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY)).toBe("false");
    view.unmount();
    const remount = await renderSelected();
    expect(screen.queryByTestId("chat-sidebar-resize-handle")).toBeNull();
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-docked-sidebar-toggle"));
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe("380px");
    remount.view.unmount();
  });

  it.each([[null, "300px"], ["340", "340px"], ["abc", "300px"], ["", "300px"], ["-5", "300px"], ["100", "220px"], ["900", "480px"]])("restores valid, corrupt, and bounded width preference %s", async (stored, expected) => {
    if (stored !== null) localStorage.setItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, stored);
    setupMockChat({ sessions: [], filteredSessions: [] });
    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe(expected);
    view.unmount();
  });

  it("round-trips both closed and default-open preferences", async () => {
    localStorage.setItem(CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY, "false");
    const closed = await renderSelected();
    expect(screen.queryByTestId("chat-sidebar-resize-handle")).toBeNull();
    closed.view.unmount();
    localStorage.removeItem(CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY);
    const open = await renderSelected();
    expectDocked();
    open.view.unmount();
  });

  it("cleans up a pointer resize when unmounted mid-drag", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { view } = await renderSelected();
    const handle = screen.getByTestId("chat-sidebar-resize-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 140 });
    view.unmount();
    const writes = setItem.mock.calls.filter(([key]) => key === CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY).length;
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 300 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 300 });
    expect(setItem.mock.calls.filter(([key]) => key === CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY)).toHaveLength(writes);
    setItem.mockRestore();
  });

  it("renders conversation row fallbacks, populated selection, and the docked empty state", async () => {
    mockFetchModels.mockResolvedValueOnce({ models: [], favoriteProviders: [], favoriteModels: [] });
    const untitled = { ...session, id: "session-untitled", title: "", lastMessagePreview: "", modelProvider: undefined, modelId: undefined };
    const selectSession = vi.fn();
    setupMockChat({ activeSession: session, sessions: [session, untitled], filteredSessions: [session, untitled], selectSession });
    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const populatedRow = screen.getByTestId(`chat-session-${session.id}`);
    expect(populatedRow.querySelector(".chat-session-title")).toHaveTextContent(session.title);
    expect(populatedRow.querySelector(".chat-session-preview")).toHaveTextContent(session.lastMessagePreview);
    expect(populatedRow.querySelector(".chat-session-meta-model [data-provider='anthropic']")).toBeInTheDocument();
    const untitledRow = screen.getByTestId(`chat-session-${untitled.id}`);
    expect(untitledRow.querySelector(".chat-session-title")).toHaveTextContent("Untitled");
    expect(untitledRow.querySelector(".chat-session-preview")).toHaveTextContent("No messages");
    expect(untitledRow.querySelector(".chat-session-meta-model [data-provider]")).toBeNull();
    expect(screen.getByTestId(`chat-session-model-tag-${untitled.id}`)).toHaveTextContent("Fusion");
    fireEvent.click(untitledRow);
    expect(selectSession).toHaveBeenCalledWith(untitled.id);
    expectDocked();
    view.unmount();
    setupMockChat({ sessions: [], filteredSessions: [] });
    const empty = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expectDocked();
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    empty.unmount();
  });

  it("keeps the conversation-row contract on mobile", async () => {
    const restore = mockViewportMode("mobile");
    try {
      const { view } = await renderSelected();
      const row = screen.getByTestId(`chat-session-${session.id}`);
      expect(row.querySelector(".chat-session-title")).toHaveTextContent(session.title);
      expect(row.querySelector(".chat-session-preview")).toHaveTextContent(session.lastMessagePreview);
      expect(row.querySelector(".chat-session-meta-model [data-provider='anthropic']")).toBeInTheDocument();
      expect(screen.getByTestId(`chat-session-model-tag-${session.id}`)).toHaveTextContent("Claude Sonnet 4.5");
      view.unmount();
    } finally { restore(); }
  });

  it("does not persist preferences for ephemeral hosts", async () => {
    const { view } = await renderSelected({ persistChatPreferences: false });
    fireEvent.keyDown(screen.getByTestId("chat-sidebar-resize-handle"), { key: "ArrowRight" });
    fireEvent.click(screen.getByTestId("chat-docked-sidebar-toggle"));
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY)).toBeNull();
    view.unmount();
    expect(CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH).toBe(300);
  });
});

/*
FNXC:ChatSearch 2026-07-07-12:00:
Covers content search: no "Search in title only" toggle renders on desktop or mobile chat
sidebars (FN-7651 removed the affordance), and matchedMessagePreview still renders when
content-mode drove a session's inclusion — content search remains always-on.
*/
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import {
  renderWithAct,
  setupMockChat,
  setupMockRooms,
  mockViewportMode,
  activeSessionFixture,
  installChatViewEnv,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return { ...actual };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

function dispatchFind(target: EventTarget, modifier: "ctrl" | "meta" = "ctrl") {
  const event = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: modifier === "ctrl",
    metaKey: modifier === "meta",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

/*
FNXC:ChatNavigation 2026-08-23-18:25:
FN-9193 docks the conversation list on tablet-or-wider hosts, so the in-thread Back control renders
only while that list is collapsed. Detail entry is proven by the thread header identity, and a case
that needs to LEAVE the conversation collapses the docked list first to reach Back.
*/
async function enterDirectDetail() {
  fireEvent.pointerDown(screen.getByTestId(`chat-session-${activeSessionFixture.id}`));
  fireEvent.click(screen.getByTestId(`chat-session-${activeSessionFixture.id}`));
  return screen.findByTestId("chat-thread-header-identity");
}

function leaveDirectDetail() {
  const dockToggle = screen.queryByTestId("chat-docked-sidebar-toggle");
  if (dockToggle) fireEvent.click(dockToggle);
  fireEvent.click(screen.getByTestId("chat-back-btn"));
}

describe("ChatView content search", () => {
  it("does not render the title-only toggle on the desktop sidebar", async () => {
    mockViewportMode("desktop");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-search-input")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-search-title-only-toggle")).toBeNull();
  });

  it("does not render the title-only toggle on the mobile sidebar", async () => {
    mockViewportMode("mobile");
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-search-input")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-search-title-only-toggle")).toBeNull();
  });

  it("focuses the existing list search and prevents native Find without changing its query", async () => {
    mockViewportMode("desktop");
    const setSearchQuery = vi.fn();
    setupMockChat({ sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture], searchQuery: "kept", setSearchQuery });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    screen.getByTestId("chat-search-input").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId("chat-search-input")).toHaveFocus();
    expect(screen.getByTestId("chat-search-input")).toHaveValue("kept");
    expect(setSearchQuery).not.toHaveBeenCalled();
  });

  it("does not retain native Find ownership while its host is hidden", async () => {
    mockViewportMode("desktop");
    setupMockChat({ sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} findActive={false} />);
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    screen.getByTestId("chat-search-input").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    ["desktop", "desktop" as const, {}],
    ["mobile", "mobile" as const, {}],
    ["compact", "desktop" as const, { floating: true, compactLayout: true }],
  ])("focuses the retained list search in the %s host", async (_host, viewport, hostProps) => {
    mockViewportMode(viewport);
    const setSearchQuery = vi.fn();
    setupMockChat({ sessions: [], filteredSessions: [], searchQuery: "retained", setSearchQuery });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} {...hostProps} />);
    const input = screen.getByTestId("chat-search-input");
    const event = dispatchFind(input, "meta");

    expect(event.defaultPrevented).toBe(true);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("retained");
    expect(setSearchQuery).not.toHaveBeenCalled();
  });

  it("opens conversation Find and navigates one matching row per message", async () => {
    mockViewportMode("desktop");
    setupMockChat({
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      messages: [
        { id: "message-1", sessionId: activeSessionFixture.id, role: "user", content: "Needle needle", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "message-2", sessionId: activeSessionFixture.id, role: "assistant", content: "Another needle", createdAt: "2026-01-01T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await enterDirectDetail();
    const event = dispatchFind(screen.getByTestId("chat-message-message-1"), "meta");

    expect(event.defaultPrevented).toBe(true);
    const input = await screen.findByTestId("chat-conversation-search-input");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "needle" } });
    expect(screen.getByText("1 of 2 matches")).toBeInTheDocument();
    expect(screen.getByTestId("chat-message-message-1")).toHaveClass("chat-message--search-active");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("chat-message-message-2")).toHaveClass("chat-message--search-active");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByTestId("chat-message-message-1")).toHaveClass("chat-message--search-active");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByTestId("chat-message-message-2")).toHaveClass("chat-message--search-active");
    leaveDirectDetail();
    expect(screen.queryByTestId("chat-conversation-search")).toBeNull();
  });

  it("searches room details without changing the Direct list query", async () => {
    mockViewportMode("mobile");
    const room = { id: "room-find", projectId: "proj-123", slug: "find", name: "Find", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const setSearchQuery = vi.fn();
    localStorage.setItem("fusion:chat-scope", "rooms");
    setupMockChat({ sessions: [], filteredSessions: [], setSearchQuery });
    setupMockRooms({
      rooms: [room],
      activeRoom: room,
      messages: [
        { id: "room-find-1", roomId: room.id, role: "user", content: "Room needle", createdAt: "2026-01-01T00:00:00.000Z", senderAgentId: null, mentions: [] },
        { id: "room-find-2", roomId: room.id, role: "assistant", content: "Another room needle", createdAt: "2026-01-01T00:01:00.000Z", senderAgentId: "agent-001", mentions: [] },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
    fireEvent.click(screen.getByTestId("chat-room-item-find"));
    const firstRow = await screen.findByTestId("chat-message-room-find-1");
    const event = dispatchFind(firstRow);

    expect(event.defaultPrevented).toBe(true);
    const input = await screen.findByTestId("chat-conversation-search-input");
    fireEvent.change(input, { target: { value: "needle" } });
    expect(screen.getByText("1 of 2 matches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByTestId("chat-message-room-find-2")).toHaveClass("chat-message--search-active");
    expect(setSearchQuery).not.toHaveBeenCalled();
  });

  it("keeps native Find terminal-owned while hybrid transcripts own it", async () => {
    const hybrid = { ...activeSessionFixture, cliExecutorAdapterId: "claude-code", cliSessionFile: "cli-find" };
    setupMockChat({ activeSession: hybrid, sessions: [hybrid], filteredSessions: [hybrid], messages: [{ id: "cli-find-message", sessionId: hybrid.id, role: "assistant", content: "Transcript needle", createdAt: "2026-01-01T00:00:00.000Z" }] });
    const hybridView = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await enterDirectDetail();
    const transcriptEvent = dispatchFind(screen.getByTestId("chat-message-cli-find-message"));
    expect(transcriptEvent.defaultPrevented).toBe(true);
    expect(await screen.findByTestId("chat-conversation-search-input")).toBeInTheDocument();

    const rawTerminalTarget = document.createElement("textarea");
    rawTerminalTarget.className = "xterm";
    document.body.append(rawTerminalTarget);
    expect(dispatchFind(rawTerminalTarget).defaultPrevented).toBe(false);
    rawTerminalTarget.remove();
    hybridView.unmount();
  });

  it("uses one activated visible host and releases ownership when retained Quick Chat hides", async () => {
    setupMockChat({ sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture] });
    const first = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const second = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating />);
    const inputs = screen.getAllByTestId("chat-search-input");
    fireEvent.pointerDown(inputs[1]!);
    const event = dispatchFind(document.body);
    expect(event.defaultPrevented).toBe(true);
    expect(inputs[1]).toHaveFocus();
    expect(inputs[0]).not.toHaveFocus();

    second.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} floating findActive={false} />);
    const hiddenEvent = dispatchFind(document.body);
    expect(hiddenEvent.defaultPrevented).toBe(false);
    first.unmount();
    second.unmount();
  });

  it("leaves dialog targets alone and clears stale no-match, whitespace, and streaming results", async () => {
    const chatState = {
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      messages: [{ id: "message-search", sessionId: activeSessionFixture.id, role: "assistant" as const, content: "stable needle", createdAt: "2026-01-01T00:00:00.000Z" }],
      isStreaming: false,
      streamingText: "",
    };
    setupMockChat(chatState);
    const result = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await enterDirectDetail();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const dialogInput = document.createElement("input");
    dialog.append(dialogInput);
    document.body.append(dialog);
    expect(dispatchFind(dialogInput).defaultPrevented).toBe(false);
    dialog.remove();

    dispatchFind(screen.getByTestId("chat-message-message-search"));
    const input = await screen.findByTestId("chat-conversation-search-input");
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByText("No matches")).toBeInTheDocument();

    setupMockChat({ ...chatState, isStreaming: true, streamingText: "stream needle" });
    result.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    fireEvent.change(screen.getByTestId("chat-conversation-search-input"), { target: { value: "stream" } });
    expect(screen.getByText("1 of 1 matches")).toBeInTheDocument();
    expect(screen.getByTestId("chat-message-__streaming__")).toHaveClass("chat-message--search-active");
  });

  it("shows matchedMessagePreview for a session included via content match, with no toggle present", async () => {
    const contentMatchedSession = {
      ...activeSessionFixture,
      id: "session-content-match",
      title: "Weekend plans",
      matchedMessagePreview: "quarterly roadmap discussion",
    };
    setupMockChat({
      sessions: [contentMatchedSession],
      filteredSessions: [contentMatchedSession],
      searchQuery: "roadmap",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-session-matched-preview-session-content-match")).toHaveTextContent(
      "quarterly roadmap discussion",
    );
    expect(screen.queryByTestId("chat-search-title-only-toggle")).toBeNull();
  });
});

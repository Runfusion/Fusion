// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  mockTabletClassTouchViewport,
  mockUseChat,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  mockPhoneLandscapeViewport,
} from "./ChatView.test-harness";

vi.mock("../SessionTerminal", () => ({
  SessionTerminal: () => <div data-testid="session-terminal">terminal</div>,
}));
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn(), removeNav: vi.fn() }),
}));
vi.mock("../../hooks/useModelsCache", () => ({
  useModelsCache: () => ({
    models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
    loading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

function session(id: string, overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    ...activeSessionFixture,
    id,
    title: `Conversation ${id}`,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function message(sessionId: string) {
  return {
    id: `message-${sessionId}`,
    sessionId,
    role: "assistant" as const,
    content: "Existing conversation message",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function setupOpenableChat(overrides: Partial<UseChatReturn> = {}) {
  const selectSession = vi.fn();
  const createSession = vi.fn();
  const initialSessions = overrides.sessions ?? [];
  const initialActiveSession = overrides.activeSession ?? null;

  mockUseChat.mockImplementation(() => {
    const [sessions, setSessions] = useState<ChatSessionInfo[]>(initialSessions);
    const [activeSession, setActiveSession] = useState<ChatSessionInfo | null>(initialActiveSession);

    const select = (id: string) => {
      selectSession(id);
      setActiveSession(sessions.find((candidate) => candidate.id === id) ?? null);
    };
    const create = async (input: { agentId: string }) => {
      createSession(input);
      const created = session(`created-${sessions.length + 1}`, { agentId: input.agentId });
      setSessions((current) => [...current, created]);
      setActiveSession(created);
      return created;
    };

    return {
      ...defaultChatState,
      ...overrides,
      sessions,
      filteredSessions: sessions,
      activeSession,
      selectSession: select,
      createSession: create,
    } satisfies UseChatReturn;
  });

  return { selectSession, createSession };
}

async function openConversation(id = "session-001") {
  fireEvent.click(screen.getByTestId(`chat-session-${id}`));
  return screen.findByTestId("chat-input");
}

async function expectComposerFocused() {
  const composer = await screen.findByTestId("chat-input");
  await waitFor(() => expect(composer).toHaveFocus());
  return composer;
}

function setupListedConversation(overrides: Partial<UseChatReturn> = {}) {
  const current = session("session-001", overrides.activeSession ?? {});
  const selectSession = vi.fn();
  setupMockChat({
    ...defaultChatState,
    ...overrides,
    activeSession: current,
    sessions: [current],
    filteredSessions: [current],
    messages: overrides.messages ?? [message(current.id)],
    selectSession,
  });
  return { current, selectSession };
}

function withFloatingHostWidth(width: number) {
  const originalResizeObserver = globalThis.ResizeObserver;
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width, height: 640, top: 0, right: width, bottom: 640, left: 0, toJSON: () => ({}),
  });
  class MockResizeObserver implements ResizeObserver {
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();
    constructor(_callback: ResizeObserverCallback) {}
  }
  globalThis.ResizeObserver = MockResizeObserver;
  return () => {
    globalThis.ResizeObserver = originalResizeObserver;
    bounds.mockRestore();
  };
}

describe("ChatView composer focus when a conversation opens", () => {
  it("focuses the desktop embedded composer after opening a populated conversation from the list", async () => {
    const { current, selectSession } = setupListedConversation();
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await openConversation(current.id);
    await expectComposerFocused();
    expect(selectSession).toHaveBeenCalledWith(current.id);
  });

  it("focuses the composer after New Chat creates the first conversation", async () => {
    setupOpenableChat();
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-new-btn"));
    await expectComposerFocused();
    expect(screen.getByTestId("chat-session-created-1")).toBeInTheDocument();
  });

  it("focuses the replacement composer after /new creates a conversation", async () => {
    const current = session("session-001");
    const stopStreaming = vi.fn().mockResolvedValue(undefined);
    const { createSession } = setupOpenableChat({
      activeSession: current,
      sessions: [current],
      messages: [message(current.id)],
      stopStreaming,
    });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const composer = await openConversation(current.id);
    fireEvent.change(composer, { target: { value: "/new" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await expectComposerFocused();
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(stopStreaming).toHaveBeenCalledTimes(1);
  });

  it("focuses the composer rather than the thread title switcher after selecting another conversation", async () => {
    const first = session("session-001");
    const second = session("session-002");
    setupOpenableChat({ activeSession: first, sessions: [first, second], messages: [message(first.id)] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await openConversation(first.id);

    fireEvent.click(screen.getByTestId("chat-thread-title-trigger"));
    fireEvent.click(await screen.findByTestId(`chat-thread-title-menu-item-${second.id}`));

    const composer = await expectComposerFocused();
    expect(screen.getByTestId("chat-thread-title-trigger")).not.toHaveFocus();
    expect(composer).toHaveFocus();
  });

  it("re-arms focus when returning to the list then reopening the same conversation", async () => {
    const { current } = setupListedConversation();
    localStorage.setItem("fusion:chat-docked-sidebar-open", "false");
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating />);
    await openConversation(current.id);
    await expectComposerFocused();

    fireEvent.click(screen.getByTestId("chat-back-btn"));
    await waitFor(() => expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument());
    await openConversation(current.id);
    await expectComposerFocused();
  });

  it("focuses a popped-out host on its initial direct-session paint", async () => {
    const current = session("session-001");
    setupMockChat({ activeSession: current, sessions: [current], filteredSessions: [current], messages: [message(current.id)] });
    await renderWithAct(
      <ChatView projectId="proj-123" addToast={vi.fn()} floating initialDirectSession={current} initialDirectSessionNonce={1} />,
    );

    await expectComposerFocused();
  });

  it("re-focuses a popped-out host when its direct-session nonce is bumped", async () => {
    const current = session("session-001");
    setupMockChat({ activeSession: current, sessions: [current], filteredSessions: [current], messages: [message(current.id)] });
    const view = await renderWithAct(
      <ChatView projectId="proj-123" addToast={vi.fn()} floating initialDirectSession={current} initialDirectSessionNonce={1} />,
    );
    await expectComposerFocused();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    view.rerender(
      <ChatView projectId="proj-123" addToast={vi.fn()} floating initialDirectSession={current} initialDirectSessionNonce={2} />,
    );
    await expectComposerFocused();
    outside.remove();
  });

  it.each([
    ["floating Quick Chat", { floating: true }],
    ["compact right-dock Chat", { compactLayout: true }],
  ])("focuses the composer in the %s pointer host", async (_name, props) => {
    const { current } = setupListedConversation();
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} {...props} />);

    await openConversation(current.id);
    await expectComposerFocused();
  });

  it("keeps focus behavior in a narrow floating host", async () => {
    const restoreHost = withFloatingHostWidth(640);
    try {
      const { current } = setupListedConversation();
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating />);
      await openConversation(current.id);
      await expectComposerFocused();
      expect(document.querySelector(".chat-view")).toHaveClass("chat-view--narrow");
    } finally {
      restoreHost();
    }
  });

  it.each([
    ["phone", () => mockViewportMode("mobile")],
    ["phone landscape", () => mockPhoneLandscapeViewport()],
    ["touch-class tablet", () => mockTabletClassTouchViewport()],
  ])("does not focus the composer on a %s soft-keyboard host", async (_name, installViewport) => {
    const restore = installViewport();
    try {
      const { current } = setupListedConversation();
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      const composer = await openConversation(current.id);
      await waitFor(() => expect(composer).not.toHaveFocus());
    } finally {
      restore();
    }
  });

  it("focuses the composer on a non-touch tablet-sized desktop viewport", async () => {
    const touchDescriptor = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    const touchStartDescriptor = Object.getOwnPropertyDescriptor(window, "ontouchstart");
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
    delete (window as Window & { ontouchstart?: unknown }).ontouchstart;
    const restore = mockViewportMode("tablet");
    try {
      const { current } = setupListedConversation();
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      await openConversation(current.id);
      await expectComposerFocused();
    } finally {
      restore.mockRestore();
      if (touchDescriptor) Object.defineProperty(navigator, "maxTouchPoints", touchDescriptor);
      else delete (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints;
      if (touchStartDescriptor) Object.defineProperty(window, "ontouchstart", touchStartDescriptor);
    }
  });

  it("keeps the empty list search reachable without mounting or focusing a composer", async () => {
    setupMockChat({ sessions: [], filteredSessions: [], activeSession: null, messages: [] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();
    const search = screen.getByTestId("chat-search-input");
    search.focus();
    expect(search).toHaveFocus();
  });

  it("focuses the composer while streaming without stopping the reply", async () => {
    const stopStreaming = vi.fn().mockResolvedValue(undefined);
    const { current } = setupListedConversation({ isStreaming: true, streamingText: "Still replying", stopStreaming });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await openConversation(current.id);
    await expectComposerFocused();
    expect(stopStreaming).not.toHaveBeenCalled();
  });

  it("does not throw or focus a disabled composer while the pending queue is busy", async () => {
    const { current } = setupListedConversation({ pendingQueueAction: true });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const composer = await openConversation(current.id);
    expect(composer).toBeDisabled();
    expect(composer).not.toHaveFocus();
  });

  it("drives the real list selection and New Chat handlers before asserting focus", async () => {
    const current = session("session-001");
    const { selectSession } = setupOpenableChat({ activeSession: current, sessions: [current], messages: [message(current.id)] });
    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await openConversation(current.id);
    await expectComposerFocused();
    expect(selectSession).toHaveBeenCalledWith(current.id);

    view.unmount();
    setupOpenableChat();
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    fireEvent.click(screen.getByTestId("chat-new-btn"));
    await expectComposerFocused();
    expect(screen.getByTestId("chat-session-created-1")).toBeInTheDocument();
  });

  it("leaves generic CLI sessions terminal-owned without a composer focus target", async () => {
    const current = session("session-generic", { cliExecutorAdapterId: "generic" });
    setupMockChat({ activeSession: current, sessions: [current], filteredSessions: [current], messages: [message(current.id)] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.click(screen.getByTestId(`chat-session-${current.id}`));
    expect(await screen.findByTestId("session-terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  it("focuses the transcript composer for a hybrid CLI session", async () => {
    const current = session("session-hybrid", { cliExecutorAdapterId: "claude-code" });
    setupMockChat({ activeSession: current, sessions: [current], filteredSessions: [current], messages: [message(current.id)] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await openConversation(current.id);
    await expectComposerFocused();
  });

  it("preserves the composer markup while making it the focus owner", async () => {
    const { current } = setupListedConversation();
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await openConversation(current.id);
    const composer = await expectComposerFocused();
    const wrapper = composer.closest(".chat-input-wrapper");
    expect(composer).toHaveClass("chat-input-textarea");
    expect(composer).toHaveAttribute("placeholder", "Type a message...");
    expect(composer).toHaveAttribute("rows", "1");
    expect(wrapper?.querySelectorAll(":scope > button")).toHaveLength(0);
  });

  it("keeps a retained hidden Quick Chat from stealing focus and focuses it when shown", async () => {
    const current = session("session-001");
    setupMockChat({ activeSession: current, sessions: [current], filteredSessions: [current], messages: [message(current.id)] });
    const view = await renderWithAct(
      <>
        <ChatView projectId="proj-123" addToast={vi.fn()} />
        <ChatView projectId="proj-123" addToast={vi.fn()} floating findActive={false} initialDirectSession={current} />
      </>,
    );
    const visibleSearch = screen.getAllByTestId("chat-search-input")[0];
    visibleSearch.focus();
    const hiddenComposer = screen.getByTestId("chat-input");
    expect(hiddenComposer).not.toHaveFocus();
    expect(visibleSearch).toHaveFocus();

    view.rerender(
      <>
        <ChatView projectId="proj-123" addToast={vi.fn()} />
        <ChatView projectId="proj-123" addToast={vi.fn()} floating findActive initialDirectSession={current} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("chat-input")).toHaveFocus());
  });

  it("focuses once per open without pulling focus back after an unrelated rerender", async () => {
    const { current } = setupListedConversation();
    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    await openConversation(current.id);
    await expectComposerFocused();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} active />);
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it("does not retroactively focus a conversation opened before a touch host becomes a pointer host", async () => {
    const mobile = mockViewportMode("mobile");
    const { current } = setupListedConversation();
    const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const composer = await openConversation(current.id);
    expect(composer).not.toHaveFocus();

    mobile.mockRestore();
    const desktop = mockViewportMode("desktop");
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(composer).not.toHaveFocus();
    view.unmount();
    desktop.mockRestore();
  });
});

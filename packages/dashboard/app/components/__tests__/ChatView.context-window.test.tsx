import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  defaultModelsResponse,
  installChatViewEnv,
  mockFetchModels,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
  createRoomFixture,
} from "./ChatView.test-harness";
import { estimateChatTokens, formatTokenCount } from "../../utils/estimateChatTokens";

/*
FNXC:DashboardTests 2026-06-27-00:00:
Chat context-window coverage is surface-enumeration driven: desktop Direct chat renders the estimate, while mobile, floating-narrow, rooms, and unknown-model states must omit the element entirely so no empty header shell survives in constrained layouts.
*/

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
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
  fetchAgents: vi.fn().mockResolvedValue([
    { id: "agent-001", name: "Alpha", role: "executor", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

function expectNoContextWindowShell() {
  expect(screen.queryByTestId("chat-thread-context-window")).not.toBeInTheDocument();
  expect(document.querySelector(".chat-thread-header-context")).not.toBeInTheDocument();
}

function setupDirectChat(options: { content?: string; streamingText?: string } = {}) {
  const content = options.content ?? "abcd";
  setupMockChat({
    sessions: [activeSessionFixture],
    filteredSessions: [activeSessionFixture],
    activeSession: activeSessionFixture,
    messages: [
      {
        id: "msg-001",
        sessionId: activeSessionFixture.id,
        role: "user",
        content,
        createdAt: "2026-04-08T00:00:00.000Z",
      },
    ],
    isStreaming: options.streamingText !== undefined,
    streamingText: options.streamingText ?? "",
  });
}

describe("ChatView context-window indicator", () => {
  it("renders the estimated token budget in the desktop Direct-chat header", async () => {
    setupDirectChat({ content: "abcd" });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const indicator = await screen.findByTestId("chat-thread-context-window");
    expect(indicator).toHaveTextContent("1 / 200k");
    expect(indicator).toHaveAttribute("aria-label", "Estimated 1 of 200k context tokens");
  });

  it("does not render an indicator shell in mobile Direct chat", async () => {
    const restoreViewport = mockViewportMode("mobile");
    try {
      setupDirectChat({ content: "abcd" });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(screen.getByTestId("chat-mobile-session-trigger")).toBeInTheDocument();
      expectNoContextWindowShell();
    } finally {
      restoreViewport.mockRestore();
    }
  });

  it("does not render an indicator shell in the narrowed floating chat modal", async () => {
    const restoreViewport = mockViewportMode("desktop");
    const originalResizeObserver = globalThis.ResizeObserver;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 560,
      height: 640,
      top: 0,
      right: 560,
      bottom: 640,
      left: 0,
      toJSON: () => ({}),
    });

    class MockResizeObserver implements ResizeObserver {
      readonly observe = vi.fn();
      readonly unobserve = vi.fn();
      readonly disconnect = vi.fn();
      constructor(_callback: ResizeObserverCallback) {}
    }

    globalThis.ResizeObserver = MockResizeObserver;
    try {
      setupDirectChat({ content: "abcd" });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating />);

      expect(screen.getByTestId("chat-mobile-session-trigger")).toBeInTheDocument();
      expectNoContextWindowShell();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      rectSpy.mockRestore();
      restoreViewport.mockRestore();
    }
  });

  it("does not render an indicator shell when the active model context window is unknown", async () => {
    mockFetchModels.mockResolvedValue({
      ...defaultModelsResponse,
      models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 0 }],
    });
    setupDirectChat({ content: "abcd" });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await waitFor(() => {
      expectNoContextWindowShell();
    });
  });

  it("includes in-flight streaming text in the displayed estimate", async () => {
    const content = "a".repeat(3996);
    const streamingText = "abcd";
    setupDirectChat({ content, streamingText });
    const expectedUsed = formatTokenCount(estimateChatTokens([{ content }], streamingText));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const indicator = await screen.findByTestId("chat-thread-context-window");
    expect(expectedUsed).toBe("~1k");
    expect(indicator).toHaveTextContent(`${expectedUsed} / 200k`);
    expect(indicator).not.toHaveTextContent("999 / 200k");
  });

  it("does not render an indicator shell in rooms scope", async () => {
    const room = createRoomFixture("context-room");
    localStorage.setItem("fusion:chat-scope", "rooms");
    setupDirectChat({ content: "abcd" });
    setupMockRooms({
      rooms: [room],
      activeRoom: room,
      activeRoomMembers: [],
      messages: [
        {
          id: "room-msg-001",
          roomId: room.id,
          role: "user",
          content: "Room hello",
          createdAt: "2026-04-08T00:00:00.000Z",
          senderAgentId: null,
          mentions: [],
        },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    expect(document.querySelector(".chat-room-thread-header")).toBeInTheDocument();
    expectNoContextWindowShell();
  });
});

import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Agent } from "../../api";
import type { ChatSession } from "@fusion/core";
import * as apiModule from "../../api";
import { useAgents } from "../../hooks/useAgents";
import { useViewportMode } from "../../hooks/useViewportMode";
import { useMobileKeyboard } from "../../hooks/useMobileKeyboard";
import { useAppSettings } from "../../hooks/useAppSettings";
import { useChatRooms } from "../../hooks/useChatRooms";
import * as mobileScrollLock from "../../hooks/useMobileScrollLock";
import { QuickChatFAB } from "../QuickChatFAB";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import { getPersistedLastQuickChatSessionId } from "../../hooks/quickChatLastSessionStorage";

vi.mock("../../api", () => ({
  fetchResumeChatSession: vi.fn(),
  fetchChatSession: vi.fn(),
  fetchChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchModels: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  attachmentBaseUrlForRoom: vi.fn((roomId: string) => `/api/chat/rooms/${roomId}/attachments/`),
}));

vi.mock("../../hooks/useAgents", () => ({ useAgents: vi.fn() }));
vi.mock("../../hooks/useViewportMode", () => {
  const useViewportMode = vi.fn();
  return {
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    getViewportMode: () => useViewportMode(),
    isMobileViewport: () => useViewportMode() === "mobile",
    useViewportMode,
  };
});
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn() }));
vi.mock("../../hooks/useAppSettings", () => ({ useAppSettings: vi.fn() }));
vi.mock("../../hooks/useChatRooms", () => ({ useChatRooms: vi.fn() }));

const mockFetchResumeChatSession = vi.mocked(apiModule.fetchResumeChatSession);
const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockCreateChatSession = vi.mocked(apiModule.createChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockUpdateChatSession = vi.mocked(apiModule.updateChatSession);
const mockFetchModels = vi.mocked(apiModule.fetchModels);
const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);
const mockStreamChatResponse = vi.mocked(apiModule.streamChatResponse);
const mockCancelChatResponse = vi.mocked(apiModule.cancelChatResponse);
const mockUseAgents = vi.mocked(useAgents);
const mockUseViewportMode = vi.mocked(useViewportMode);
const mockUseMobileKeyboard = vi.mocked(useMobileKeyboard);
const mockUseAppSettings = vi.mocked(useAppSettings);
const mockUseChatRooms = vi.mocked(useChatRooms);

const agents: Agent[] = [
  { id: "agent-001", name: "Agent One", role: "executor", state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} },
  { id: "agent-002", name: "Agent Two", role: "reviewer", state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} },
];

const modelSession: ChatSession = {
  id: "session-model",
  agentId: "__fn_agent__",
  modelProvider: "openai",
  modelId: "gpt-4o",
  title: "Model thread",
  status: "active",
  projectId: null,
  createdAt: "2026-05-16T00:00:02.000Z",
  updatedAt: "2026-05-16T00:00:02.000Z",
};

const modelSessionAnthropic: ChatSession = {
  ...modelSession,
  id: "session-model-anthropic",
  modelProvider: "anthropic",
  modelId: "claude-3-7-sonnet",
  title: "Claude thread",
};

const agentSession: ChatSession = {
  id: "session-agent",
  agentId: "agent-001",
  modelProvider: null,
  modelId: null,
  title: null,
  status: "active",
  projectId: null,
  createdAt: "2026-05-16T00:00:01.000Z",
  updatedAt: "2026-05-16T00:00:01.000Z",
};

const agentTwoSession: ChatSession = {
  ...agentSession,
  id: "session-agent-two",
  agentId: "agent-002",
  title: "Agent Two thread",
};

function resolveResumeSession(agentId: string, modelProvider?: string, modelId?: string): ChatSession {
  if (agentId === "agent-002") {
    return agentTwoSession;
  }

  if (agentId === "__fn_agent__" && modelProvider === "anthropic" && modelId === "claude-3-7-sonnet") {
    return modelSessionAnthropic;
  }

  return modelSession;
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockQuickChatVisualViewport({ height = 800, offsetTop = 0, width = 390 } = {}) {
  const visualViewport = new EventTarget() as VisualViewport;
  Object.defineProperties(visualViewport, {
    height: { value: height, writable: true, configurable: true },
    width: { value: width, writable: true, configurable: true },
    offsetTop: { value: offsetTop, writable: true, configurable: true },
    offsetLeft: { value: 0, writable: true, configurable: true },
    pageTop: { value: 0, writable: true, configurable: true },
    pageLeft: { value: 0, writable: true, configurable: true },
    scale: { value: 1, writable: true, configurable: true },
  });
  Object.defineProperty(window, "visualViewport", { value: visualViewport, configurable: true, writable: true });
  return visualViewport;
}

async function driveQuickChatVisualViewport(
  visualViewport: VisualViewport,
  { height, offsetTop, eventType = "resize" }: { height: number; offsetTop: number; eventType?: "resize" | "scroll" },
) {
  setQuickChatVisualViewportSample(visualViewport, { height, offsetTop });

  await act(async () => {
    visualViewport.dispatchEvent(new Event(eventType));
  });
}

function setQuickChatVisualViewportSample(
  visualViewport: VisualViewport,
  { height, offsetTop }: { height: number; offsetTop: number },
) {
  Object.defineProperties(visualViewport, {
    height: { value: height, writable: true, configurable: true },
    offsetTop: { value: offsetTop, writable: true, configurable: true },
  });
}

function mockRequestAnimationFrames() {
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;
  const rafQueue: FrameRequestCallback[] = [];
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  window.cancelAnimationFrame = vi.fn();

  return {
    async drain() {
      await act(async () => {
        while (rafQueue.length > 0) {
          const cb = rafQueue.shift();
          cb?.(performance.now());
        }
      });
    },
    restore() {
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancelRaf;
    },
  };
}

describe("QuickChatFAB session-first UX", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.dispatchEvent(new Event("resize"));
    localStorage.clear();
    mockUseAgents.mockReturnValue({ agents, activeAgents: agents, stats: null, isLoading: false, loadAgents: vi.fn(), loadStats: vi.fn() });
    mockUseViewportMode.mockReturnValue("desktop");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
    });
    mockUseAppSettings.mockReturnValue({
      experimentalFeatures: {},
    } as ReturnType<typeof useAppSettings>);
    mockUseChatRooms.mockReturnValue({
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
      sendRoomMessage: vi.fn(),
      refreshRooms: vi.fn(),
    });
    mockFetchResumeChatSession.mockImplementation(async ({ agentId, modelProvider, modelId }) => ({
      session: resolveResumeSession(agentId, modelProvider, modelId),
    }));
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchChatSessions.mockResolvedValue({ sessions: [modelSession, agentSession] });
    mockCreateChatSession.mockResolvedValue({ session: { ...modelSession, id: "session-new" } });
    mockUpdateChatSession.mockResolvedValue({ session: { ...modelSession, title: "Renamed model thread" } });
    mockCancelChatResponse.mockResolvedValue({ success: true });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      handlers.onDone?.({ messageId: "msg-stream" });
      return { close: vi.fn(), isConnected: () => true };
    });
    mockFetchModels.mockResolvedValue({
      models: [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: true, contextWindow: 128000 },
        { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", reasoning: true, contextWindow: 200000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });
    mockFetchDiscoveredSkills.mockResolvedValue([
      { id: "sk-1", name: "fusion-basics", relativePath: "skills/fusion-basics", source: "acme/skills" },
      { id: "sk-2", name: "deploy-helper", relativePath: "skills/deploy-helper", source: "acme/skills" },
    ]);
  });

  it("renders compact question tool calls and sends answers through quick chat", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [{
        id: "msg-question",
        sessionId: "session-model",
        role: "assistant",
        content: "Need input",
        metadata: { toolCalls: [{ toolName: "ask_user", args: { question: "Pick?", options: ["Alpha", "Beta"] }, isError: false, status: "completed" }] },
        createdAt: "2026-05-16T00:00:00.000Z",
      }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByTestId("chat-question-response")).toHaveClass("chat-question-response--compact");
    expect(document.querySelector(".chat-tool-call")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("chat-question-response-option-q-0-opt-0"));
    fireEvent.click(screen.getByTestId("chat-question-response-submit"));

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "session-model",
        "> Q: Pick?\nAlpha",
        expect.any(Object),
        undefined,
        "proj-1",
      );
    });
  });

  it("keeps non-question quick chat tool calls generic and historical questions read-only", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-tool",
          sessionId: "session-model",
          role: "assistant",
          content: "Read file",
          metadata: { toolCalls: [{ toolName: "read", args: { path: "foo.ts" }, isError: false, status: "completed" }] },
          createdAt: "2026-05-16T00:00:02.000Z",
        },
        { id: "msg-user", sessionId: "session-model", role: "user", content: "> Q: Pick?\nBeta", createdAt: "2026-05-16T00:00:01.000Z" },
        {
          id: "msg-question",
          sessionId: "session-model",
          role: "assistant",
          content: "Need input",
          metadata: { toolCalls: [{ toolName: "ask_user", args: { question: "Pick?", options: ["Alpha", "Beta"] }, isError: false, status: "completed" }] },
          createdAt: "2026-05-16T00:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByTestId("chat-question-response")).toHaveTextContent("Answered");
    expect(screen.getByTestId("chat-question-response-submitted-answer")).toHaveTextContent("Beta");
    expect(screen.queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
    expect(screen.getByText("read")).toBeInTheDocument();
  });

  it("removes header mode toggle and renders session dropdown", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByTestId("quick-chat-session-dropdown")).toBeInTheDocument();
    expect(screen.queryByTestId("quick-chat-mode-toggle")).toBeNull();
    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    expect(screen.getByTestId("quick-chat-session-option-session-model")).toHaveClass("quick-chat-session-option--active");
    expect(screen.getByTestId("quick-chat-session-option-session-agent")).toBeInTheDocument();
  });

  it("renames a quick chat session from the dropdown and updates the panel title", async () => {
    mockUpdateChatSession.mockResolvedValueOnce({ session: { ...modelSession, title: "Renamed model thread" } });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByTestId("quick-chat-active-session-title")).toHaveTextContent("Model thread");
    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    expect(screen.getByTestId("quick-chat-session-rename-session-model")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("quick-chat-session-rename-session-model"));

    const input = screen.getByTestId("quick-chat-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Model thread");
    fireEvent.change(input, { target: { value: "Renamed model thread" } });
    fireEvent.click(screen.getByTestId("quick-chat-rename-save"));

    await waitFor(() => {
      expect(mockUpdateChatSession).toHaveBeenCalledWith("session-model", { title: "Renamed model thread" }, "proj-1");
      expect(screen.getByTestId("quick-chat-active-session-title")).toHaveTextContent("Renamed model thread");
    });
  });

  it("renders unread dots for unread sessions and hides active session dot", async () => {
    localStorage.setItem(
      "kb:proj-1:fusion:chat-unread:direct",
      JSON.stringify({ "session-model": "2026-05-15T00:00:00.000Z" }),
    );

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    fireEvent.click(await screen.findByTestId("quick-chat-session-dropdown-trigger"));

    expect(screen.queryByTestId("quick-chat-unread-dot-session-model")).toBeNull();
    expect(screen.getByTestId("quick-chat-unread-dot-session-agent")).toBeInTheDocument();
  });

  it("renders unread dots for unread rooms", async () => {
    const selectRoom = vi.fn();
    mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
    mockUseChatRooms.mockReturnValue({
      rooms: [
        { id: "room-1", name: "engineering", slug: "engineering", memberCount: 2, createdAt: new Date().toISOString(), updatedAt: "2026-05-15T00:00:00.000Z" },
        { id: "room-2", name: "support", slug: "support", memberCount: 2, createdAt: new Date().toISOString(), updatedAt: "2026-05-15T01:00:00.000Z" },
      ],
      roomsLoading: false,
      roomsError: null,
      activeRoom: { id: "room-1", name: "engineering", slug: "engineering", memberCount: 2, createdAt: new Date().toISOString(), updatedAt: "2026-05-15T00:00:00.000Z" },
      activeRoomMembers: [],
      messages: [],
      messagesLoading: false,
      selectRoom,
      createRoom: vi.fn(),
      deleteRoom: vi.fn(),
      sendRoomMessage: vi.fn(),
      refreshRooms: vi.fn(),
    });
    localStorage.setItem(
      "kb:proj-1:fusion:chat-unread:rooms",
      JSON.stringify({ "room-1": "2026-05-15T00:00:00.000Z" }),
    );

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    fireEvent.click(await screen.findByTestId("quick-chat-session-dropdown-trigger"));

    expect(screen.queryByTestId("quick-chat-unread-dot-room-1")).toBeNull();
    expect(screen.getByTestId("quick-chat-unread-dot-room-2")).toBeInTheDocument();
  });

  it("does not render room options or group labels when chat rooms are disabled", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    fireEvent.click(await screen.findByTestId("quick-chat-session-dropdown-trigger"));

    expect(screen.getByTestId("quick-chat-session-option-session-model")).toBeInTheDocument();
    expect(screen.queryByTestId("quick-chat-session-option-room-engineering")).toBeNull();
    expect(screen.queryByText("Rooms")).toBeNull();
    expect(screen.queryByText("Sessions")).toBeNull();
  });

  it("FN-4660: opens/closes session menu and shows rooms before sessions when enabled", async () => {
    const selectRoom = vi.fn();
    mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
    mockUseChatRooms.mockReturnValue({
      rooms: [{ id: "room-1", name: "engineering", slug: "engineering", memberCount: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      roomsLoading: false,
      roomsError: null,
      activeRoom: { id: "room-1", name: "engineering", slug: "engineering", memberCount: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      activeRoomMembers: [],
      messages: [],
      messagesLoading: false,
      selectRoom,
      createRoom: vi.fn(),
      deleteRoom: vi.fn(),
      sendRoomMessage: vi.fn(),
      refreshRooms: vi.fn(),
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const trigger = await screen.findByTestId("quick-chat-session-dropdown-trigger");
    expect(trigger).toHaveTextContent("#engineering");
    fireEvent.click(trigger);

    expect(screen.getByTestId("quick-chat-session-dropdown-menu")).toBeInTheDocument();
    const roomsLabel = screen.getByText("Rooms");
    const sessionsLabel = screen.getByText("Sessions");
    expect(roomsLabel).toBeInTheDocument();
    expect(sessionsLabel).toBeInTheDocument();
    expect(roomsLabel.compareDocumentPosition(sessionsLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("quick-chat-session-option-session-model")).toHaveClass("quick-chat-session-option");
    expect(screen.getByTestId("quick-chat-session-option-room-engineering")).toHaveClass("quick-chat-session-option--active");

    fireEvent.click(screen.getByTestId("quick-chat-session-option-room-engineering"));
    expect(selectRoom).toHaveBeenCalledWith("room-1");

    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByTestId("quick-chat-new-thread"));
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-session-dropdown-menu")).toBeNull();
    });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("quick-chat-session-option-session-model"));
    await waitFor(() => {
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-model", { limit: 50, order: "desc" }, "proj-1");
    });
  });

  it("opens inline chooser from new button defaulting to model", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    fireEvent.click(await screen.findByTestId("quick-chat-new-thread"));
    expect(await screen.findByTestId("quick-chat-new-session-chooser")).toBeInTheDocument();
    expect(screen.getByTestId("quick-chat-inline-mode-model")).toHaveClass("quick-chat-mode-btn--active");
    expect(screen.getByTestId("quick-chat-new-model-select")).toBeInTheDocument();
  });

  it("keeps a persisted model session through same-target auto-init before sessions load", async () => {
    localStorage.setItem("fusion:quick-chat-last-session:proj-1", "model-last-opened");
    const sessionsDeferred = createDeferredPromise<{ sessions: ChatSession[] }>();
    mockFetchChatSessions.mockReturnValueOnce(sessionsDeferred.promise);
    mockFetchResumeChatSession.mockResolvedValue({
      session: {
        ...modelSession,
        id: "model-auto-resolved",
        updatedAt: "2026-05-13T12:00:00.000Z",
        lastMessageAt: "2026-05-13T12:00:00.000Z",
      },
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(mockFetchChatSessions).toHaveBeenCalledWith("proj-1");
    });
    expect(mockFetchResumeChatSession).not.toHaveBeenCalled();
    expect(getPersistedLastQuickChatSessionId("proj-1")).toBe("model-last-opened");

    sessionsDeferred.resolve({
      sessions: [
        {
          ...modelSession,
          id: "model-last-opened",
          updatedAt: "2026-05-13T10:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
        {
          ...modelSession,
          id: "model-auto-resolved",
          updatedAt: "2026-05-13T12:00:00.000Z",
          lastMessageAt: "2026-05-13T12:00:00.000Z",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("model-last-opened");
      expect(getPersistedLastQuickChatSessionId("proj-1")).toBe("model-last-opened");
    });
  });

  it("restores the persisted session from the mobile FAB path", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    localStorage.setItem("fusion:quick-chat-last-session:proj-1", "mobile-last-opened");
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...modelSession,
          id: "mobile-last-opened",
          updatedAt: "2026-05-13T10:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
        {
          ...modelSession,
          id: "mobile-newer-same-target",
          updatedAt: "2026-05-13T12:00:00.000Z",
          lastMessageAt: "2026-05-13T12:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("mobile-last-opened");
      expect(getPersistedLastQuickChatSessionId("proj-1")).toBe("mobile-last-opened");
    });
  });

  it("keeps a persisted agent session through same-target auto-init before sessions load", async () => {
    localStorage.setItem("fusion:quick-chat-last-session:proj-1", "agent-last-opened");
    const sessionsDeferred = createDeferredPromise<{ sessions: ChatSession[] }>();
    mockFetchChatSessions.mockReturnValueOnce(sessionsDeferred.promise);
    mockFetchResumeChatSession.mockResolvedValue({
      session: {
        ...agentSession,
        id: "agent-auto-resolved",
        updatedAt: "2026-05-13T12:00:00.000Z",
        lastMessageAt: "2026-05-13T12:00:00.000Z",
      },
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(mockFetchChatSessions).toHaveBeenCalledWith("proj-1");
    });
    expect(mockFetchResumeChatSession).not.toHaveBeenCalled();
    expect(getPersistedLastQuickChatSessionId("proj-1")).toBe("agent-last-opened");

    sessionsDeferred.resolve({
      sessions: [
        {
          ...agentSession,
          id: "agent-last-opened",
          updatedAt: "2026-05-13T10:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
        {
          ...agentSession,
          id: "agent-auto-resolved",
          updatedAt: "2026-05-13T12:00:00.000Z",
          lastMessageAt: "2026-05-13T12:00:00.000Z",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("agent-last-opened");
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message Agent One");
      expect(getPersistedLastQuickChatSessionId("proj-1")).toBe("agent-last-opened");
    });
  });

  it("restores the persisted last opened active session before latest activity", async () => {
    localStorage.setItem("fusion:quick-chat-last-session:proj-1", "older-updated");
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...modelSession,
          id: "older-updated",
          updatedAt: "2026-05-13T10:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
        {
          ...agentTwoSession,
          id: "newer-last-message",
          updatedAt: "2026-05-13T09:00:00.000Z",
          lastMessageAt: "2026-05-13T11:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message GPT-4o");
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("older-updated");
    });
    expect(mockFetchResumeChatSession).not.toHaveBeenCalled();
  });

  it("falls back to the latest conversation session when the persisted id is stale", async () => {
    localStorage.setItem("fusion:quick-chat-last-session:proj-1", "missing-session");
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...modelSession,
          id: "older-updated",
          updatedAt: "2026-05-13T12:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
        {
          ...agentTwoSession,
          id: "newer-last-message",
          updatedAt: "2026-05-13T09:00:00.000Z",
          lastMessageAt: "2026-05-13T11:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message Agent Two");
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("newer-last-message");
    });
  });

  it("skips archived persisted sessions and restores the newest active session", async () => {
    localStorage.setItem("fusion:quick-chat-last-session:proj-1", "archived-newest");
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...modelSessionAnthropic,
          id: "archived-newest",
          status: "archived",
          updatedAt: "2026-05-13T12:00:00.000Z",
          lastMessageAt: "2026-05-13T12:00:00.000Z",
        },
        {
          ...agentTwoSession,
          id: "active-latest",
          updatedAt: "2026-05-13T11:00:00.000Z",
          lastMessageAt: "2026-05-13T11:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message Agent Two");
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("active-latest");
    });
    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    expect(screen.getByTestId("quick-chat-session-option-archived-newest")).toBeInTheDocument();
  });

  it("reopen keeps the last session the user opened", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...modelSession,
          id: "older-updated",
          updatedAt: "2026-05-13T10:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
        {
          ...agentTwoSession,
          id: "newer-last-message",
          updatedAt: "2026-05-13T09:00:00.000Z",
          lastMessageAt: "2026-05-13T11:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.click(fab);

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("newer-last-message");
    });

    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    fireEvent.click(screen.getByTestId("quick-chat-session-option-older-updated"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("older-updated");
    });

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    fireEvent.click(fab);

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("older-updated");
    });
  });

  it("reopen keeps the last active session even when archived newer sessions exist", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...modelSessionAnthropic,
          id: "archived-newest",
          status: "archived",
          updatedAt: "2026-05-13T12:00:00.000Z",
          lastMessageAt: "2026-05-13T12:00:00.000Z",
        },
        {
          ...agentTwoSession,
          id: "active-latest",
          updatedAt: "2026-05-13T11:00:00.000Z",
          lastMessageAt: "2026-05-13T11:00:00.000Z",
        },
        {
          ...modelSession,
          id: "active-older",
          updatedAt: "2026-05-13T10:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.click(fab);

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("active-latest");
    });

    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    fireEvent.click(screen.getByTestId("quick-chat-session-option-active-older"));
    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("active-older");
    });

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    fireEvent.click(fab);

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("active-older");
    });
  });

  it("does not reload messages or show a loading placeholder when reopening", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          sessionId: "session-model",
          role: "assistant",
          content: "Warm conversation",
          createdAt: "2026-05-16T00:00:03.000Z",
          metadata: null,
          thinkingOutput: null,
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.click(fab);

    await waitFor(() => {
      expect(screen.getByText("Warm conversation")).toBeInTheDocument();
    });
    const messageFetchCountAfterInitialOpen = mockFetchChatMessages.mock.calls.length;

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    fireEvent.click(fab);

    await waitFor(() => {
      expect(screen.getByText("Warm conversation")).toBeInTheDocument();
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("session-model");
    });
    expect(mockFetchChatMessages).toHaveBeenCalledTimes(messageFetchCountAfterInitialOpen);
    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
  });

  it("re-restores for a new project without leaking the previous project session", async () => {
    mockFetchChatSessions.mockImplementation(async (projectId?: string) => ({
      sessions: projectId === "proj-2"
        ? [
          {
            ...agentTwoSession,
            id: "proj-2-session",
            updatedAt: "2026-05-17T10:00:00.000Z",
            lastMessageAt: "2026-05-17T10:00:00.000Z",
          },
        ]
        : [
          {
            ...modelSession,
            id: "proj-1-session",
            updatedAt: "2026-05-16T10:00:00.000Z",
            lastMessageAt: "2026-05-16T10:00:00.000Z",
          },
        ],
    }));

    const { rerender } = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("proj-1-session");
    });

    rerender(<QuickChatFAB addToast={vi.fn()} projectId="proj-2" />);

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("proj-2-session");
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message Agent Two");
    });
  });

  it("falls back to the existing default target when there are no prior sessions", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({ sessions: [] });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-model-tag")).toHaveTextContent("GPT-4o");
    });
    expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message GPT-4o");
  });

  it("FN-4804: session dropdown keeps explicit older model-session selection", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...modelSession,
          id: "model-older",
          updatedAt: "2026-05-13T08:00:00.000Z",
          lastMessageAt: "2026-05-13T08:00:00.000Z",
        },
        {
          ...modelSession,
          id: "model-newer",
          updatedAt: "2026-05-13T10:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("model-newer");
    });

    mockFetchResumeChatSession.mockClear();

    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    fireEvent.click(screen.getByTestId("quick-chat-session-option-model-older"));

    await waitFor(async () => {
      await Promise.resolve();
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("model-older");
    });
    expect(mockFetchResumeChatSession).not.toHaveBeenCalled();
  });

  it("FN-4804: switching dropdown from model session to agent session preserves explicit pick", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        {
          ...modelSession,
          id: "model-newer",
          updatedAt: "2026-05-13T10:00:00.000Z",
          lastMessageAt: "2026-05-13T10:00:00.000Z",
        },
        {
          ...agentTwoSession,
          id: "agent-older",
          updatedAt: "2026-05-13T08:00:00.000Z",
          lastMessageAt: "2026-05-13T08:00:00.000Z",
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("model-newer");
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message GPT-4o");
    });

    mockFetchResumeChatSession.mockClear();

    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    fireEvent.click(screen.getByTestId("quick-chat-session-option-agent-older"));

    await waitFor(async () => {
      await Promise.resolve();
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("agent-older");
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message Agent Two");
    });
    expect(mockFetchResumeChatSession).not.toHaveBeenCalled();
  });

  it("FN-4804: switching from an active room to a direct session clears room display state", async () => {
    const room = {
      id: "room-1",
      name: "engineering",
      slug: "engineering",
      memberCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
    mockUseChatRooms.mockImplementation(() => {
      const [activeRoom, setActiveRoom] = useState(room);
      return {
        rooms: [room],
        roomsLoading: false,
        roomsError: null,
        activeRoom,
        activeRoomMembers: [],
        messages: [],
        messagesLoading: false,
        selectRoom: (roomId: string | null) => {
          setActiveRoom(roomId ? room : null);
        },
        createRoom: vi.fn(),
        deleteRoom: vi.fn(),
        sendRoomMessage: vi.fn(),
        refreshRooms: vi.fn(),
      };
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message #engineering");
    expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("");

    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    fireEvent.click(screen.getByTestId("quick-chat-session-option-session-agent"));

    await waitFor(() => {
      expect(screen.getByTestId("quick-chat-session-dropdown")).toHaveValue("session-agent");
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message Agent One");
      expect(screen.getByTestId("quick-chat-session-dropdown-trigger")).not.toHaveTextContent("#engineering");
    });
  });

  describe("FN-4708 room reflection", () => {
    it("shows room placeholder and room tag when an active room exists", async () => {
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [{ id: "room-1", name: "engineering", slug: "engineering", memberCount: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
        roomsLoading: false,
        roomsError: null,
        activeRoom: { id: "room-1", name: "engineering", slug: "engineering", memberCount: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        activeRoomMembers: [],
        messages: [],
        messagesLoading: false,
        selectRoom: vi.fn(),
        createRoom: vi.fn(),
        deleteRoom: vi.fn(),
        sendRoomMessage: vi.fn(),
        refreshRooms: vi.fn(),
      });

      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      expect(await screen.findByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message #engineering");
      expect(screen.getByTestId("quick-chat-room-tag")).toHaveTextContent("#engineering");
      expect(screen.queryByTestId("quick-chat-model-tag")).toBeNull();
    });

    it("preserves model placeholder/tag behavior when no active room is selected", async () => {
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [{ id: "room-1", name: "engineering", slug: "engineering", memberCount: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
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
        refreshRooms: vi.fn(),
      });

      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      expect(await screen.findByTestId("quick-chat-model-tag")).toHaveTextContent("GPT-4o");
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message GPT-4o");
    });
  });

  it("creates fresh model session from inline chooser and closes chooser", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await screen.findByTestId("quick-chat-model-tag");
    fireEvent.click(await screen.findByTestId("quick-chat-new-thread"));

    await waitFor(() => expect(screen.getByTestId("quick-chat-new-session-submit")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("quick-chat-new-session-submit"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" },
        "proj-1",
      );
    });
    expect(screen.queryByTestId("quick-chat-new-session-chooser")).toBeNull();
  });

  it("creates fresh agent session from inline chooser agent path", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await screen.findByTestId("quick-chat-model-tag");
    fireEvent.click(await screen.findByTestId("quick-chat-new-thread"));
    await waitFor(() => expect(screen.getByTestId("quick-chat-new-session-submit")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("quick-chat-inline-mode-agent"));
    fireEvent.change(screen.getByTestId("quick-chat-new-agent-select"), { target: { value: "agent-002" } });
    fireEvent.click(screen.getByTestId("quick-chat-new-session-submit"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith({ agentId: "agent-002" }, "proj-1");
    });
  });

  it("shows distinguishable labels for sessions from multiple models", async () => {
    mockFetchChatSessions.mockResolvedValueOnce({
      sessions: [
        { ...modelSession, id: "session-openai", title: null },
        { ...modelSession, id: "session-anthropic", modelProvider: "anthropic", modelId: "claude-3-7-sonnet", title: null },
      ],
    });
    mockFetchModels.mockResolvedValueOnce({
      models: [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: true, contextWindow: 128000 },
        { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", reasoning: true, contextWindow: 200000 },
      ],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    fireEvent.click(await screen.findByTestId("quick-chat-session-dropdown-trigger"));
    expect(screen.getByTestId("quick-chat-session-option-session-openai")).toBeInTheDocument();
    expect(screen.getByTestId("quick-chat-session-option-session-anthropic")).toBeInTheDocument();
  });

  it("includes both title and model descriptor in session label", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    fireEvent.click(await screen.findByTestId("quick-chat-session-dropdown-trigger"));
    expect(screen.getByTestId("quick-chat-session-option-session-model")).toBeInTheDocument();
  });

  it("FN-6518: desktop opening Quick Chat focuses the enabled composer", async () => {
    const raf = mockRequestAnimationFrames();

    try {
      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const input = await screen.findByTestId("quick-chat-input") as HTMLTextAreaElement;
      await waitFor(() => expect(input).not.toBeDisabled());
      await raf.drain();

      expect(document.activeElement).toBe(input);
    } finally {
      raf.restore();
    }
  });

  it("FN-6518: desktop composer focuses after the session becomes ready post-open", async () => {
    const raf = mockRequestAnimationFrames();
    const deferredSessions = createDeferredPromise<{ sessions: ChatSession[] }>();
    mockFetchChatSessions.mockImplementationOnce(() => deferredSessions.promise);

    try {
      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const input = await screen.findByTestId("quick-chat-input") as HTMLTextAreaElement;
      expect(input).toBeDisabled();
      deferredSessions.resolve({ sessions: [modelSession, agentSession] });
      await waitFor(() => expect(input).not.toBeDisabled());
      await raf.drain();

      expect(document.activeElement).toBe(input);
    } finally {
      raf.restore();
    }
  });

  it("FN-6518: mobile opening Quick Chat hands focus from stealth input to composer", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input") as HTMLTextAreaElement;
    await waitFor(() => expect(input).not.toBeDisabled());

    expect(document.activeElement).toBe(input);
  });

  it("FN-6518: auto-focus does not steal focus from an external control", async () => {
    const raf = mockRequestAnimationFrames();
    const externalFocusTarget = document.createElement("button");
    externalFocusTarget.type = "button";
    externalFocusTarget.textContent = "External focus target";
    document.body.appendChild(externalFocusTarget);

    try {
      const { rerender } = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open={false} onOpenChange={vi.fn()} />);
      externalFocusTarget.focus();
      expect(document.activeElement).toBe(externalFocusTarget);

      rerender(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open onOpenChange={vi.fn()} />);
      const input = await screen.findByTestId("quick-chat-input") as HTMLTextAreaElement;
      await waitFor(() => expect(input).not.toBeDisabled());
      await raf.drain();

      expect(document.activeElement).toBe(externalFocusTarget);
    } finally {
      externalFocusTarget.remove();
      raf.restore();
    }
  });

  it("FN-6301: iOS first tap focuses composer without canceling native focus, then sends", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    const isIOSSpy = vi.spyOn(mobileScrollLock, "isIOS").mockReturnValue(true);
    mockStreamChatResponse.mockImplementation((_sessionId, _content, _handlers) => ({
      close: vi.fn(),
      isConnected: () => true,
    }));

    try {
      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const input = await screen.findByTestId("quick-chat-input") as HTMLTextAreaElement;
      await waitFor(() => expect(input).not.toBeDisabled());
      input.blur();
      expect(document.activeElement).not.toBe(input);

      const touchEvent = new TouchEvent("touchstart", { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(touchEvent, "preventDefault");
      fireEvent(input, touchEvent);
      // jsdom has no soft keyboard/native touch-focus default action; mirror
      // the browser focus that iOS only performs when touchstart is not canceled.
      if (!touchEvent.defaultPrevented) {
        input.focus();
      }

      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
      expect(screen.getByTestId("quick-chat-send")).toBeDisabled();

      fireEvent.change(input, { target: { value: "Hello quick mobile" } });
      const sendButton = screen.getByTestId("quick-chat-send");
      fireEvent.touchStart(sendButton);
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(mockStreamChatResponse).toHaveBeenCalledTimes(1);
      });
      expect(mockStreamChatResponse).toHaveBeenCalledWith("session-model", "Hello quick mobile", expect.any(Object), [], "proj-1");
      expect(await screen.findByTestId("quick-chat-stop")).toBeInTheDocument();
      expect(document.activeElement).toBe(input);
    } finally {
      isIOSSpy.mockRestore();
    }
  });

  it("Android send fires exactly once for a full pointerdown+touchstart+click tap", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    const isIOSSpy = vi.spyOn(mobileScrollLock, "isIOS").mockReturnValue(false);
    mockStreamChatResponse.mockImplementation(() => ({ close: vi.fn(), isConnected: () => true }));
    try {
      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));
      const input = await screen.findByTestId("quick-chat-input") as HTMLTextAreaElement;
      await waitFor(() => expect(input).not.toBeDisabled());
      fireEvent.change(input, { target: { value: "Hello" } });

      const sendButton = screen.getByTestId("quick-chat-send");
      // Real Android tap dispatches pointerdown + touchstart + click within one
      // task, with no React flush between them (unlike separate fireEvent calls).
      // Dispatch them in a single act() so state batching mirrors the device.
      await act(async () => {
        sendButton.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: "touch" }));
        sendButton.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
        sendButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
      });

      await waitFor(() => expect(mockStreamChatResponse).toHaveBeenCalledTimes(1));
    } finally {
      isIOSSpy.mockRestore();
    }
  });

  it("FN-6301: Android mobile composer touchstart leaves native focus uncanceled", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    const isIOSSpy = vi.spyOn(mobileScrollLock, "isIOS").mockReturnValue(false);

    try {
      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const input = await screen.findByTestId("quick-chat-input") as HTMLTextAreaElement;
      await waitFor(() => expect(input).not.toBeDisabled());
      input.blur();

      const touchEvent = new TouchEvent("touchstart", { bubbles: true, cancelable: true });
      const preventDefaultSpy = vi.spyOn(touchEvent, "preventDefault");
      fireEvent(input, touchEvent);
      if (!touchEvent.defaultPrevented) {
        input.focus();
      }

      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
    } finally {
      isIOSSpy.mockRestore();
    }
  });

  it("FN-6498: mobile visualViewport tracking skips duplicate resize/scroll writes and clears stale variables", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 280,
      viewportHeight: 520,
      viewportOffsetTop: 0,
      keyboardOpen: true,
    });
    const visualViewport = mockQuickChatVisualViewport({ height: 800, offsetTop: 0 });
    const styleWriteSpy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty");
    const styleRemoveSpy = vi.spyOn(CSSStyleDeclaration.prototype, "removeProperty");

    const rendered = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    const panel = await screen.findByTestId("quick-chat-panel");
    await screen.findByTestId("quick-chat-input");

    expect(panel.style.getPropertyValue("--vv-height")).toBe("800px");
    expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("0px");
    const initialWriteCount = styleWriteSpy.mock.calls.length;

    await driveQuickChatVisualViewport(visualViewport, { height: 520, offsetTop: 0, eventType: "resize" });
    expect(panel.style.getPropertyValue("--vv-height")).toBe("520px");
    expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("0px");
    const writesAfterResize = styleWriteSpy.mock.calls.length;
    expect(writesAfterResize - initialWriteCount).toBe(2);

    await driveQuickChatVisualViewport(visualViewport, { height: 520, offsetTop: 0, eventType: "scroll" });
    expect(styleWriteSpy.mock.calls.length).toBe(writesAfterResize);

    await driveQuickChatVisualViewport(visualViewport, { height: 360, offsetTop: 24, eventType: "resize" });
    expect(panel.style.getPropertyValue("--vv-height")).toBe("360px");
    expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("24px");

    await driveQuickChatVisualViewport(visualViewport, { height: 800, offsetTop: 0, eventType: "resize" });
    expect(panel.style.getPropertyValue("--vv-height")).toBe("800px");
    expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("0px");

    rendered.unmount();
    expect(panel.style.getPropertyValue("--vv-height")).toBe("");
    expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("");
    expect(styleRemoveSpy).toHaveBeenCalledWith("--vv-height");
    expect(styleRemoveSpy).toHaveBeenCalledWith("--vv-offset-top");

    styleWriteSpy.mockRestore();
    styleRemoveSpy.mockRestore();
  });

  it("FN-6503: re-samples Android first-open keyboard settle on composer focus handoff", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 280,
      viewportHeight: 520,
      viewportOffsetTop: 0,
      keyboardOpen: true,
    });
    const visualViewport = mockQuickChatVisualViewport({ height: 800, offsetTop: 0 });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    const panel = await screen.findByTestId("quick-chat-panel");
    const input = await screen.findByTestId("quick-chat-input");

    expect(panel.style.getPropertyValue("--vv-height")).toBe("800px");
    setQuickChatVisualViewportSample(visualViewport, { height: 520, offsetTop: 0 });
    fireEvent.focusIn(input);

    await waitFor(() => {
      expect(panel.style.getPropertyValue("--vv-height")).toBe("520px");
    });
    expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("0px");

    fireEvent.blur(input);
    fireEvent.click(screen.getByTestId("quick-chat-close"));
    expect(panel.style.getPropertyValue("--vv-height")).toBe("");
    expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("");

    setQuickChatVisualViewportSample(visualViewport, { height: 800, offsetTop: 0 });
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    const reopenedPanel = await screen.findByTestId("quick-chat-panel");
    expect(reopenedPanel.style.getPropertyValue("--vv-height")).toBe("800px");

    await driveQuickChatVisualViewport(visualViewport, { height: 520, offsetTop: 0, eventType: "resize" });
    expect(reopenedPanel.style.getPropertyValue("--vv-height")).toBe("520px");
    expect(reopenedPanel.style.getPropertyValue("--vv-offset-top")).toBe("0px");
  });

  it("FN-6503: preserves iOS offsetTop compensation and desktop no-op viewport mirroring", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    const visualViewport = mockQuickChatVisualViewport({ height: 800, offsetTop: 0 });

    const rendered = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    const panel = await screen.findByTestId("quick-chat-panel");
    const input = await screen.findByTestId("quick-chat-input");

    setQuickChatVisualViewportSample(visualViewport, { height: 360, offsetTop: 24 });
    fireEvent.focusIn(input);

    await waitFor(() => {
      expect(panel.style.getPropertyValue("--vv-height")).toBe("360px");
      expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("24px");
    });

    rendered.unmount();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("desktop");
    const desktopVisualViewport = mockQuickChatVisualViewport({ height: 800, offsetTop: 0, width: 1024 });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    const focusSpy = vi.spyOn(document.querySelector(".quick-chat-stealth-input") as HTMLInputElement, "focus");
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    const desktopPanel = await screen.findByTestId("quick-chat-panel");
    setQuickChatVisualViewportSample(desktopVisualViewport, { height: 520, offsetTop: 0 });
    fireEvent.focusIn(desktopPanel);

    expect(desktopPanel.style.getPropertyValue("--vv-height")).toBe("");
    expect(desktopPanel.style.getPropertyValue("--vv-offset-top")).toBe("");
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("FN-6498: close while suppressing dismiss samples resets tracking for reopen", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    const visualViewport = mockQuickChatVisualViewport({ height: 800, offsetTop: 0 });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    const input = await screen.findByTestId("quick-chat-input") as HTMLTextAreaElement;
    const firstPanel = await screen.findByTestId("quick-chat-panel");

    await driveQuickChatVisualViewport(visualViewport, { height: 360, offsetTop: 24, eventType: "resize" });
    expect(firstPanel.style.getPropertyValue("--vv-height")).toBe("360px");
    expect(firstPanel.style.getPropertyValue("--vv-offset-top")).toBe("24px");

    fireEvent.blur(input);
    expect(firstPanel.style.getPropertyValue("--vv-height")).toBe("");
    expect(firstPanel.style.getPropertyValue("--vv-offset-top")).toBe("");
    fireEvent.click(screen.getByTestId("quick-chat-close"));
    expect(screen.queryByTestId("quick-chat-panel")).toBeNull();

    await driveQuickChatVisualViewport(visualViewport, { height: 800, offsetTop: 0, eventType: "resize" });
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    const reopenedPanel = await screen.findByTestId("quick-chat-panel");
    expect(reopenedPanel.style.getPropertyValue("--vv-height")).toBe("800px");
    expect(reopenedPanel.style.getPropertyValue("--vv-offset-top")).toBe("0px");

    await driveQuickChatVisualViewport(visualViewport, { height: 520, offsetTop: 0, eventType: "resize" });
    expect(reopenedPanel.style.getPropertyValue("--vv-height")).toBe("520px");
    expect(reopenedPanel.style.getPropertyValue("--vv-offset-top")).toBe("0px");
  });

  it("FN-6498: desktop quick chat does not attach visualViewport tracking listeners", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("desktop");
    const visualViewport = mockQuickChatVisualViewport({ height: 800, offsetTop: 0, width: 1024 });
    const addListenerSpy = vi.spyOn(visualViewport, "addEventListener");

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    expect(await screen.findByTestId("quick-chat-panel")).toBeInTheDocument();
    expect(screen.getByTestId("quick-chat-resize-n")).toBeInTheDocument();
    expect(addListenerSpy).not.toHaveBeenCalledWith("resize", expect.any(Function));
    expect(addListenerSpy).not.toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("FN-6498: missing visualViewport leaves mobile panel on CSS fallback without listeners", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel.style.getPropertyValue("--vv-height")).toBe("");
    expect(panel.style.getPropertyValue("--vv-offset-top")).toBe("");
  });

  it("uses icon-only model tag without pill styling when mobile header fallback is active", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");

    mockFetchModels.mockResolvedValueOnce({
      models: [{ provider: "openai", id: "gpt-4o", name: "Extremely Long Model Name", reasoning: true, contextWindow: 128000 }],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const modelTag = await screen.findByTestId("quick-chat-model-tag");
    expect(modelTag).toHaveClass("quick-chat-model-tag--icon");

    const styles = window.getComputedStyle(modelTag);
    expect(styles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(styles.borderTopStyle).toBe("none");
    expect(styles.paddingLeft).toBe("0px");
    expect(styles.paddingRight).toBe("0px");
  });

  it("intercepts exact /clear and starts a fresh session for the active target", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: " /clear " } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" },
        "proj-1",
      );
    });
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
  });

  it("intercepts exact /new and starts a fresh session for the active target", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: " /new " } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockCreateChatSession).toHaveBeenCalledWith(
        { agentId: "__fn_agent__", modelProvider: "openai", modelId: "gpt-4o" },
        "proj-1",
      );
    });
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
  });

  it("does not intercept non-exact /new prompts", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/new now" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "session-model",
        "/new now",
        expect.any(Object),
        [],
        "proj-1",
      );
    });
  });

  it("does not intercept non-exact /clear prompts", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/clear now" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(mockStreamChatResponse).toHaveBeenCalledWith(
        "session-model",
        "/clear now",
        expect.any(Object),
        [],
        "proj-1",
      );
    });
  });

  it("shows skill menu when typing slash", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/" } });

    expect(await screen.findByTestId("quick-chat-skill-menu")).toBeInTheDocument();
    expect(screen.getByText("fusion-basics")).toBeInTheDocument();
  });

  it("filters skills from slash input", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/fusion" } });

    expect(await screen.findByText("fusion-basics")).toBeInTheDocument();
    expect(screen.queryByText("deploy-helper")).toBeNull();
  });

  it("supports keyboard navigation and enter selection for skills", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/" } });

    await screen.findByTestId("quick-chat-skill-menu");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toHaveValue("/skill:deploy-helper ");
  });

  it("selects skill from menu click and replaces slash trigger", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/" } });

    const skillName = await screen.findByText("fusion-basics");
    fireEvent.click(skillName.closest("button") as HTMLButtonElement);
    expect(input).toHaveValue("/skill:fusion-basics ");
  });

  it("shows help message for exact /help command", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "/help" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    const helpMessage = await screen.findByTestId("quick-chat-help-message");
    expect(helpMessage).toBeInTheDocument();
    expect(helpMessage).toHaveTextContent("/new");
    expect(helpMessage).toHaveTextContent("/clear");
    expect(mockStreamChatResponse).not.toHaveBeenCalled();
  });

  it("clears help message on next user message", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, { target: { value: "/help" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));
    expect(await screen.findByTestId("quick-chat-help-message")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-help-message")).toBeNull();
      expect(mockStreamChatResponse).toHaveBeenCalledWith("session-model", "hello", expect.any(Object), [], "proj-1");
    });
  });

  it("switches existing sessions from dropdown without creating new session", async () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    await screen.findByTestId("quick-chat-session-dropdown");
    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    fireEvent.click(screen.getByTestId("quick-chat-session-option-session-agent"));

    await waitFor(() => {
      expect(mockFetchChatMessages).toHaveBeenCalledWith("session-agent", { limit: 50, order: "desc" }, "proj-1");
    });
    expect(mockCreateChatSession).not.toHaveBeenCalled();
  });

  it("shows streaming feedback on second turn after first turn completes", async () => {
    const handlers: Array<Parameters<typeof mockStreamChatResponse>[2]> = [];
    mockStreamChatResponse.mockImplementation((_sessionId, _content, nextHandlers) => {
      handlers.push(nextHandlers);
      return { close: vi.fn(), isConnected: () => true };
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, { target: { value: "Turn one" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    expect(await screen.findByTestId("quick-chat-streaming-message")).toBeInTheDocument();

    handlers[0]?.onDone?.({ messageId: "msg-1" });

    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-streaming-message")).toBeNull();
    });

    fireEvent.change(input, { target: { value: "Turn two" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    expect(await screen.findByTestId("quick-chat-streaming-message")).toBeInTheDocument();
    expect(screen.getByTestId("quick-chat-waiting")).toHaveTextContent("Working…");
    expect(mockStreamChatResponse).toHaveBeenCalledTimes(2);
  });

  it("FN-6513: keeps the live tail anchored while a response is streaming", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        {
          id: "msg-before-stream",
          sessionId: "session-model",
          role: "assistant",
          content: "Before streaming",
          createdAt: "2026-06-16T00:00:00.000Z",
        },
      ],
    });
    mockStreamChatResponse.mockImplementation((_sessionId, _content, handlers) => {
      handlers.onChunk?.("streaming answer");
      return { close: vi.fn(), isConnected: () => true };
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const scrollHeightValue = 1400;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "Stream a reply" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    expect(await screen.findByTestId("quick-chat-streaming-message")).toBeInTheDocument();
    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });

  it("shows the streaming indicator instead of the loading placeholder while waiting for a long reply", async () => {
    const deferredMessages = createDeferredPromise<{ messages: never[] }>();
    mockFetchChatMessages.mockImplementation(() => deferredMessages.promise);
    mockStreamChatResponse.mockImplementation(() => ({ close: vi.fn(), isConnected: () => false }));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, { target: { value: "Explain the current architecture" } });
    fireEvent.click(screen.getByTestId("quick-chat-send"));

    expect(await screen.findByTestId("quick-chat-streaming-message")).toBeInTheDocument();
    expect(screen.getByTestId("quick-chat-waiting")).toHaveTextContent("Working…");
    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
  });

  it("keeps tap behavior for below-threshold touch movement", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);

    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.pointerDown(fab, { pointerId: 21, pointerType: "touch", button: 0, clientX: 120, clientY: 420 });
    fireEvent.pointerMove(document, { pointerId: 21, pointerType: "touch", clientX: 123, clientY: 423 });
    fireEvent.pointerUp(document, { pointerId: 21, pointerType: "touch", clientX: 123, clientY: 423 });
    fireEvent.click(fab);

    expect(await screen.findByTestId("quick-chat-panel")).toBeInTheDocument();
  });

  it("repositions on touch drag without opening panel and persists position", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);

    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.pointerDown(fab, { pointerId: 33, pointerType: "touch", button: 0, clientX: 150, clientY: 500 });
    fireEvent.pointerMove(document, { pointerId: 33, pointerType: "touch", clientX: 180, clientY: 470 });
    fireEvent.pointerUp(document, { pointerId: 33, pointerType: "touch", clientX: 180, clientY: 470 });
    fireEvent.click(fab);

    expect(screen.queryByTestId("quick-chat-panel")).toBeNull();

    const saved = localStorage.getItem("fusion-quick-chat-position-proj-1");
    expect(saved).not.toBeNull();
    expect(saved).toContain("\"x\"");
    expect(saved).toContain("\"y\"");
  });

  it("keeps persisted desktop panel size when dragging a closed FAB", async () => {
    const persistedSize = { width: 420, height: 360 };
    localStorage.setItem("fusion:quick-chat-size-proj-1", JSON.stringify(persistedSize));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);

    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.pointerDown(fab, { pointerId: 44, pointerType: "mouse", button: 0, clientX: 960, clientY: 700 });
    fireEvent.pointerMove(document, { pointerId: 44, pointerType: "mouse", clientX: 900, clientY: 620 });
    fireEvent.pointerUp(document, { pointerId: 44, pointerType: "mouse", clientX: 900, clientY: 620 });

    expect(screen.queryByTestId("quick-chat-panel")).toBeNull();
    expect(JSON.parse(localStorage.getItem("fusion:quick-chat-size-proj-1") || "null")).toEqual(persistedSize);

    fireEvent.click(fab);
    expect(screen.queryByTestId("quick-chat-panel")).toBeNull();

    fireEvent.click(fab);

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel).toHaveStyle({ width: "420px", height: "360px" });
  });

  it("FN-6502: opens taller by default on tablet without persisting the computed size", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("tablet");

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel).toHaveStyle({ width: "320px", height: "720px" });
    expect(localStorage.getItem("fusion:quick-chat-size-proj-1")).toBeNull();
  });

  it("FN-6502: keeps the desktop default size unchanged when no persisted size exists", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("desktop");

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel).toHaveStyle({ width: "320px", height: "400px" });
  });

  it("FN-6502: restores an existing desktop persisted size on desktop", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("desktop");
    localStorage.setItem("fusion:quick-chat-size-proj-1", JSON.stringify({ width: 500, height: 520 }));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel).toHaveStyle({ width: "500px", height: "520px" });
  });

  it("FN-6502: tablet open does not overwrite a pre-existing desktop persisted size", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("tablet");
    const persistedSize = { width: 500, height: 520 };
    localStorage.setItem("fusion:quick-chat-size-proj-1", JSON.stringify(persistedSize));

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel).toHaveStyle({ width: "500px", height: "520px" });
    expect(JSON.parse(localStorage.getItem("fusion:quick-chat-size-proj-1") || "null")).toEqual(persistedSize);
  });

  it("FN-6502: portrait mobile keeps inline panel sizing disabled for the full-screen CSS sheet", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel.style.width).toBe("");
    expect(panel.style.height).toBe("");
    expect(panel.style.right).toBe("");
    expect(panel.style.bottom).toBe("");
  });

  it("shows jump-to-latest only after leaving live tail and scrolls back on click", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [
        {
          id: "msg-1",
          sessionId: "session-model",
          role: "assistant",
          content: "First",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => 1200 });
    Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 240 });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    scrollTopValue = 700;
    fireEvent.scroll(messages);
    expect(screen.getByTestId("quick-chat-jump-to-latest")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("quick-chat-jump-to-latest"));
    expect(scrollTopValue).toBe(1200);
    await waitFor(() => {
      expect(screen.queryByTestId("quick-chat-jump-to-latest")).toBeNull();
    });
  });

  it("FN-6513: re-anchors a direct thread after async loading settles", async () => {
    const deferredMessages = createDeferredPromise<{
      messages: Array<{ id: string; sessionId: string; role: "assistant"; content: string; createdAt: string }>;
    }>();
    mockFetchChatMessages.mockImplementation(() => deferredMessages.promise);

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    await waitFor(() => expect(mockFetchChatMessages).toHaveBeenCalled());

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    let scrollHeightValue = 120;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
    fireEvent.scroll(messages);
    expect(screen.getByTestId("quick-chat-jump-to-latest")).toBeInTheDocument();

    scrollHeightValue = 1400;
    deferredMessages.resolve({
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `direct-msg-${index}`,
        sessionId: "session-model",
        role: "assistant" as const,
        content: `Loaded direct message ${index}`,
        createdAt: `2026-06-16T00:00:${String(index).padStart(2, "0")}.000Z`,
      })),
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });

  it("FN-6513: re-anchors a mobile room thread after async loading settles", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    const originalRaf = window.requestAnimationFrame;
    const originalCancelRaf = window.cancelAnimationFrame;
    const rafQueue: FrameRequestCallback[] = [];
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    window.cancelAnimationFrame = vi.fn();
    const room = {
      id: "room-6513",
      name: "engineering",
      slug: "engineering",
      memberCount: 2,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:10.000Z",
    };
    const roomMessages = Array.from({ length: 12 }, (_, index) => ({
      id: `room-msg-${index}`,
      roomId: room.id,
      role: index % 2 === 0 ? "assistant" as const : "user" as const,
      content: `Loaded room message ${index}`,
      createdAt: `2026-06-16T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    let finishRoomLoad: (() => void) | null = null;
    mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
    mockUseChatRooms.mockImplementation(() => {
      const [messagesLoading, setMessagesLoading] = useState(true);
      finishRoomLoad = () => setMessagesLoading(false);
      return {
        rooms: [room],
        roomsLoading: false,
        roomsError: null,
        activeRoom: room,
        activeRoomMembers: [],
        messages: roomMessages,
        messagesLoading,
        selectRoom: vi.fn(),
        createRoom: vi.fn(),
        deleteRoom: vi.fn(),
        sendRoomMessage: vi.fn(),
        clearRoom: vi.fn(),
        refreshRooms: vi.fn(),
      };
    });

    try {
      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const messages = await screen.findByTestId("quick-chat-messages");
      let scrollTopValue = 0;
      let scrollHeightValue = 120;
      Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 20 });
      Object.defineProperty(messages, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift();
        cb?.(performance.now());
      }
      expect(scrollTopValue).toBe(scrollHeightValue);
      scrollTopValue = 0;
      fireEvent.scroll(messages);
      expect(screen.getByTestId("quick-chat-jump-to-latest")).toBeInTheDocument();

      scrollHeightValue = 1400;
      await act(async () => {
        finishRoomLoad?.();
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(scrollHeightValue);
      });
    } finally {
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancelRaf;
    }
  });

  it("FN-3910: anchors to live tail on initial controlled open", async () => {
    const deferredMessages = createDeferredPromise<{
      messages: Array<{ id: string; sessionId: string; role: "assistant"; content: string; createdAt: string }>;
    }>();
    mockFetchChatMessages.mockImplementationOnce(() => deferredMessages.promise);

    const { rerender } = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open={false} onOpenChange={vi.fn()} />);

    rerender(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open onOpenChange={vi.fn()} />);

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const scrollHeightValue = 1100;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    // FN-3910: install descriptors before initial messages resolve so the initial-open
    // useLayoutEffect branch (openingNow from isOpen false->true) writes to this scrollTop.
    expect(scrollTopValue).toBe(0);

    deferredMessages.resolve({
      messages: [
        {
          id: "msg-initial",
          sessionId: "session-model",
          role: "assistant",
          content: "hello",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });

  it("FN-3884: reopens same session and scrolls to latest again", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "hello", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.click(fab);

    let messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const installScrollDescriptors = (target: HTMLElement) => {
      Object.defineProperty(target, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(target, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });
    };
    installScrollDescriptors(messages);

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    scrollTopValue = 0;
    fireEvent.click(fab);

    messages = await screen.findByTestId("quick-chat-messages");
    installScrollDescriptors(messages);

    await waitFor(() => {
      expect(scrollTopValue).toBe(1000);
    });
  });

  it("FN-3884: retries anchor when quick chat thread height grows after open", async () => {
    const originalRaf = window.requestAnimationFrame;
    const rafQueue: FrameRequestCallback[] = [];
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "hello", createdAt: new Date().toISOString() }],
    });

    try {
      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const messages = await screen.findByTestId("quick-chat-messages");
      let scrollTopValue = 0;
      let scrollHeightValue = 500;
      Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messages, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      scrollHeightValue = 900;
      while (rafQueue.length > 0) {
        const cb = rafQueue.shift();
        cb?.(performance.now());
      }

      expect(scrollTopValue).toBe(900);
    } finally {
      window.requestAnimationFrame = originalRaf;
    }
  });

  it("FN-4040: mobile reopen re-anchors quick chat to the latest message", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "hello", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    const fab = screen.getByTestId("quick-chat-fab");
    fireEvent.click(fab);

    let scrollTopValue = 0;
    const installScrollDescriptors = (target: HTMLElement) => {
      Object.defineProperty(target, "scrollHeight", { configurable: true, get: () => 1080 });
      Object.defineProperty(target, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });
    };

    let messages = await screen.findByTestId("quick-chat-messages");
    installScrollDescriptors(messages);

    fireEvent.click(screen.getByTestId("quick-chat-close"));
    scrollTopValue = 0;
    fireEvent.click(fab);

    messages = await screen.findByTestId("quick-chat-messages");
    installScrollDescriptors(messages);

    await waitFor(() => {
      expect(scrollTopValue).toBe(1080);
    });
  });

  it("applies keyboard-open panel class on mobile to remove composer safe-area gap", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));
    mockUseViewportMode.mockReturnValue("mobile");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 160,
      viewportHeight: 500,
      viewportOffsetTop: 0,
      keyboardOpen: true,
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const panel = await screen.findByTestId("quick-chat-panel");
    expect(panel).toHaveClass("quick-chat-panel--keyboard-open");
  });

  it("FN-4040: mobile visibility restore re-anchors quick chat to latest", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "hello", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 120;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => 1320 });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    scrollTopValue = 280;

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => {
      expect(scrollTopValue).toBe(1320);
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("renders non-member mention chips when roomContext is provided", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-room-mention",
          sessionId: "session-model",
          role: "user",
          content: "Check with @Agent_Two",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(
      <QuickChatFAB
        addToast={vi.fn()}
        projectId="proj-1"
        roomContext={{ roomName: "engineering", memberIds: new Set(["agent-001"]) }}
      />,
    );
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const nonMemberChip = await screen.findByText("@Agent_Two", { selector: ".chat-mention-chip--non-member" });
    expect(nonMemberChip).toHaveAttribute("title", "Not a member of engineering");

    const sentBubble = nonMemberChip.closest(".quick-chat-panel-message--sent");
    expect(sentBubble).toBeTruthy();
    // FN-4520: quick-chat mention chip text must stay distinct from sent-bubble background.
    expect(getComputedStyle(nonMemberChip).color).not.toBe(getComputedStyle(sentBubble as Element).backgroundColor);
  });

  it("FN-3884: snaps to bottom when switching sessions while open", async () => {
    mockFetchChatMessages
      .mockResolvedValueOnce({ messages: [{ id: "msg-1", sessionId: "session-model", role: "assistant", content: "A", createdAt: new Date().toISOString() }] })
      .mockResolvedValueOnce({ messages: [{ id: "msg-2", sessionId: "session-agent", role: "assistant", content: "B", createdAt: new Date().toISOString() }] });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    let scrollHeightValue = 1100;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await screen.findByTestId("quick-chat-session-dropdown");
    fireEvent.click(screen.getByTestId("quick-chat-session-dropdown-trigger"));
    fireEvent.click(screen.getByTestId("quick-chat-session-option-session-agent"));
    scrollHeightValue = 1700;

    await waitFor(() => {
      expect(scrollTopValue).toBe(1700);
    });
  });

  // FN-4437 coverage note: initial-open snap-to-bottom regression coverage lives in
  // both paths below — controlled open transition (FN-3945) and uncontrolled FAB open (FN-4095).
  it("FN-3945: snaps to bottom on controlled initial open (open=false -> open=true) with an active session already loaded", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [{ id: "msg-open", sessionId: "session-model", role: "assistant", content: "Loaded", createdAt: new Date().toISOString() }],
    });

    const { rerender } = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open={false} onOpenChange={vi.fn()} />);

    rerender(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open onOpenChange={vi.fn()} />);

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const scrollHeightValue = 1400;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });

  it("FN-4095: snaps to bottom on uncontrolled initial open (FAB click) with preloaded messages", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [{ id: "msg-open", sessionId: "session-model", role: "assistant", content: "Loaded", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 0;
    const scrollHeightValue = 1400;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });

  // FN-4720 guards that the first open transition snaps to the live tail before any user scroll event,
  // complementing FN-3945/FN-4095/FN-4590 which only assert eventual bottom anchoring.
  it("FN-4720: snaps to bottom on first uncontrolled open before any user scroll event fires", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [{ id: "msg-open", sessionId: "session-model", role: "assistant", content: "Loaded", createdAt: new Date().toISOString() }],
    });

    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 240;
    const scrollHeightValue = 1760;
    let userScrollEventFired = false;
    messages.addEventListener("scroll", () => {
      userScrollEventFired = true;
    });

    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    expect(userScrollEventFired).toBe(false);
    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
    expect(userScrollEventFired).toBe(false);
  });

  it("FN-4590: snaps to bottom on controlled initial open by overwriting a non-zero starting scrollTop", async () => {
    mockFetchChatMessages.mockResolvedValueOnce({
      messages: [{ id: "msg-open", sessionId: "session-model", role: "assistant", content: "Loaded", createdAt: new Date().toISOString() }],
    });

    const { rerender } = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open={false} onOpenChange={vi.fn()} />);

    rerender(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open onOpenChange={vi.fn()} />);

    const messages = await screen.findByTestId("quick-chat-messages");
    let scrollTopValue = 200;
    const scrollHeightValue = 1600;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(scrollHeightValue);
    });
  });

  it("linkifies file paths in markdown assistant messages", async () => {
    const openFile = vi.fn();
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-path", sessionId: "session-model", role: "assistant", content: "See packages/dashboard/app/App.tsx:9", createdAt: new Date().toISOString() }],
    });

    render(
      <FileBrowserProvider openFile={openFile}>
        <QuickChatFAB addToast={vi.fn()} projectId="proj-1" />
      </FileBrowserProvider>,
    );
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    const fileLink = await screen.findByRole("button", { name: "packages/dashboard/app/App.tsx:9" });
    fireEvent.click(fileLink);

    expect(openFile).toHaveBeenCalledWith("packages/dashboard/app/App.tsx", { line: 9, col: undefined });
  });

  it("linkifies file paths in plain-text render mode", async () => {
    const openFile = vi.fn();
    mockFetchChatMessages.mockResolvedValue({
      messages: [{ id: "msg-plain", sessionId: "session-model", role: "assistant", content: "Check packages/dashboard/app/components/QuickChatFAB.tsx", createdAt: new Date().toISOString() }],
    });

    render(
      <FileBrowserProvider openFile={openFile}>
        <QuickChatFAB addToast={vi.fn()} projectId="proj-1" />
      </FileBrowserProvider>,
    );
    fireEvent.click(screen.getByTestId("quick-chat-fab"));

    fireEvent.click(await screen.findByTestId("quick-chat-message-render-toggle"));
    const fileLink = await screen.findByRole("button", { name: "packages/dashboard/app/components/QuickChatFAB.tsx" });
    fireEvent.click(fileLink);

    expect(openFile).toHaveBeenCalledWith("packages/dashboard/app/components/QuickChatFAB.tsx", { line: undefined, col: undefined });
  });

  describe("FN-4849 room switching", () => {
    const room = {
      id: "room-1",
      name: "engineering",
      slug: "engineering",
      memberCount: 2,
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:03.000Z",
    };

    it("switching to a room renders room messages, not session messages", async () => {
      const selectRoom = vi.fn();
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [room],
        roomsLoading: false,
        roomsError: null,
        activeRoom: room,
        activeRoomMembers: [],
        messages: [
          { id: "room-msg-1", roomId: room.id, role: "assistant", content: "room msg 1", createdAt: "2026-05-16T00:00:01.000Z" },
          { id: "room-msg-2", roomId: room.id, role: "user", content: "room msg 2", createdAt: "2026-05-16T00:00:02.000Z" },
        ],
        messagesLoading: false,
        selectRoom,
        createRoom: vi.fn(),
        deleteRoom: vi.fn(),
        sendRoomMessage: vi.fn(),
        clearRoom: vi.fn(),
        refreshRooms: vi.fn(),
      });
      mockFetchChatMessages.mockResolvedValueOnce({
        messages: [{ id: "session-msg", sessionId: "session-model", role: "assistant", content: "hello from session", createdAt: "2026-05-16T00:00:00.000Z" }],
      });

      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const messages = await screen.findByTestId("quick-chat-messages");
      expect(messages).toHaveTextContent("room msg 1");
      expect(messages).toHaveTextContent("room msg 2");
      expect(messages).not.toHaveTextContent("hello from session");
      expect(screen.getByTestId("quick-chat-session-dropdown-trigger")).toHaveTextContent("#engineering");
      expect(screen.getByTestId("quick-chat-input")).toHaveAttribute("placeholder", "Message #engineering");
    });

    it("sending while in a room routes attachments to sendRoomMessage, not sendMessage", async () => {
      const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [room], roomsLoading: false, roomsError: null, activeRoom: room, activeRoomMembers: [], messages: [], messagesLoading: false,
        selectRoom: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn(), sendRoomMessage, clearRoom: vi.fn(), refreshRooms: vi.fn(),
      });

      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const input = await screen.findByTestId("quick-chat-input");
      const attachmentInput = document.querySelector(".quick-chat-attachment-input") as HTMLInputElement | null;
      const file = new File(["hi"], "note.txt", { type: "text/plain" });
      expect(attachmentInput).not.toBeNull();
      fireEvent.change(attachmentInput!, { target: { files: [file] } });
      fireEvent.change(input, { target: { value: "room dispatch" } });
      fireEvent.click(screen.getByTestId("quick-chat-send"));

      await waitFor(() => {
        expect(sendRoomMessage).toHaveBeenCalledWith("room dispatch", { files: [file] });
      });
      expect(mockStreamChatResponse).not.toHaveBeenCalled();
    });

    it("/clear while in a room calls clearRoom, not startFreshSession", async () => {
      const clearRoom = vi.fn().mockResolvedValue(undefined);
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [room], roomsLoading: false, roomsError: null, activeRoom: room, activeRoomMembers: [], messages: [], messagesLoading: false,
        selectRoom: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn(), sendRoomMessage: vi.fn(), clearRoom, refreshRooms: vi.fn(),
      });

      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const input = await screen.findByTestId("quick-chat-input");
      fireEvent.change(input, { target: { value: "/clear" } });
      fireEvent.click(screen.getByTestId("quick-chat-send"));

      await waitFor(() => {
        expect(clearRoom).toHaveBeenCalledWith("room-1");
      });
      expect(mockCreateChatSession).not.toHaveBeenCalled();
    });

    it("composer is enabled in a room even without an activeSession", async () => {
      mockFetchResumeChatSession.mockRejectedValueOnce(new Error("resume failed"));
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [room], roomsLoading: false, roomsError: null, activeRoom: room, activeRoomMembers: [], messages: [], messagesLoading: false,
        selectRoom: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn(), sendRoomMessage: vi.fn(), clearRoom: vi.fn(), refreshRooms: vi.fn(),
      });

      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      expect(await screen.findByTestId("quick-chat-input")).not.toBeDisabled();
    });

    it("switching back from a room to a session restores session messages", async () => {
      const selectRoom = vi.fn();
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [room], roomsLoading: false, roomsError: null, activeRoom: room, activeRoomMembers: [],
        messages: [{ id: "room-msg-1", roomId: room.id, role: "assistant", content: "room msg 1", createdAt: "2026-05-16T00:00:01.000Z" }],
        messagesLoading: false,
        selectRoom, createRoom: vi.fn(), deleteRoom: vi.fn(), sendRoomMessage: vi.fn(), clearRoom: vi.fn(), refreshRooms: vi.fn(),
      });
      mockFetchChatMessages.mockResolvedValue({
        messages: [{ id: "session-msg", sessionId: "session-model", role: "assistant", content: "hello from session", createdAt: "2026-05-16T00:00:00.000Z" }],
      });

      const view = render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));
      fireEvent.click(await screen.findByTestId("quick-chat-session-dropdown-trigger"));
      fireEvent.click(screen.getByTestId("quick-chat-session-option-session-model"));

      await waitFor(() => {
        expect(selectRoom).toHaveBeenCalledWith(null);
      });

      mockUseChatRooms.mockReturnValue({
        rooms: [room], roomsLoading: false, roomsError: null, activeRoom: null, activeRoomMembers: [],
        messages: [], messagesLoading: false,
        selectRoom, createRoom: vi.fn(), deleteRoom: vi.fn(), sendRoomMessage: vi.fn(), clearRoom: vi.fn(), refreshRooms: vi.fn(),
      });
      view.rerender(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      expect(await screen.findByTestId("quick-chat-messages")).toHaveTextContent("hello from session");
    });

    it("renders room message attachments with room attachment URLs", async () => {
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [room],
        roomsLoading: false,
        roomsError: null,
        activeRoom: room,
        activeRoomMembers: [],
        messages: [
          {
            id: "room-msg-1",
            roomId: room.id,
            role: "assistant",
            content: "with attachment",
            attachments: [{ id: "att-1", filename: "file.png", originalName: "file.png", mimeType: "image/png", size: 10, createdAt: "2026-05-16T00:00:01.000Z" }],
            createdAt: "2026-05-16T00:00:01.000Z",
          },
        ],
        messagesLoading: false,
        selectRoom: vi.fn(),
        createRoom: vi.fn(),
        deleteRoom: vi.fn(),
        sendRoomMessage: vi.fn(),
        clearRoom: vi.fn(),
        refreshRooms: vi.fn(),
      });

      render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const attachment = await screen.findByTestId("quick-chat-message-attachment");
      expect(attachment).toHaveAttribute("href", expect.stringContaining("/api/chat/rooms/room-1/attachments/file.png"));
    });

    it("room send failure keeps attachment previews and surfaces error toast", async () => {
      const addToast = vi.fn();
      const sendRoomMessage = vi.fn().mockRejectedValue(new Error("upload failed"));
      mockUseAppSettings.mockReturnValue({ experimentalFeatures: { chatRooms: true } } as ReturnType<typeof useAppSettings>);
      mockUseChatRooms.mockReturnValue({
        rooms: [room], roomsLoading: false, roomsError: null, activeRoom: room, activeRoomMembers: [], messages: [], messagesLoading: false,
        selectRoom: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn(), sendRoomMessage, clearRoom: vi.fn(), refreshRooms: vi.fn(),
      });

      render(<QuickChatFAB addToast={addToast} projectId="proj-1" />);
      fireEvent.click(screen.getByTestId("quick-chat-fab"));

      const attachmentInput = document.querySelector(".quick-chat-attachment-input") as HTMLInputElement | null;
      const input = screen.getByTestId("quick-chat-input");
      const file = new File(["hi"], "note.txt", { type: "text/plain" });
      expect(attachmentInput).not.toBeNull();
      fireEvent.change(attachmentInput!, { target: { files: [file] } });
      fireEvent.change(input, { target: { value: "try send" } });
      fireEvent.click(screen.getByTestId("quick-chat-send"));

      await waitFor(() => {
        expect(sendRoomMessage).toHaveBeenCalledWith("try send", { files: [file] });
      });
      expect(addToast).toHaveBeenCalledWith("upload failed", "error");
      expect(screen.getByTestId("quick-chat-attachment-previews")).toBeInTheDocument();
    });
  });
});

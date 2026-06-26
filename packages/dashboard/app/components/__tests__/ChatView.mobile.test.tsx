/*
FNXC:DashboardTests 2026-06-25-16:30:
ChatView suite split 3/3 (mobile) (was ChatView.test.tsx). Shares ChatView.test-harness for fixtures,
helpers, vi.mocked handles, and installChatViewEnv(). vi.mock factories stay inline & self
-contained here (see harness header for why delegating them triggers a TDZ ReferenceError).
*/

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { ChatView } from "../ChatView";
import { loadAllAppCss } from "../../test/cssFixture";
import * as mobileScrollLock from "../../hooks/useMobileScrollLock";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";
import {
  renderWithAct,
  setupMockChat,
  setupMockRooms,
  mockViewportMode,
  activeSessionFixture,
  createRoomFixture,
  ensureMatchMedia,
  installChatViewEnv,
} from "./ChatView.test-harness";

// Mock the hooks
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

// Mock lucide-react icons - spread actual module and override specific icons
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    MessageSquare: ({ "data-testid": testId, ...props }: any) => (
      <svg data-testid={testId || "icon-message-square"} {...props} />
    ),
    Send: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-send"} {...props} />,
    Plus: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-plus"} {...props} />,
    Search: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-search"} {...props} />,
    Trash2: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-trash"} {...props} />,
    Archive: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-archive"} {...props} />,
    Pencil: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-pencil"} {...props} />,
    ChevronLeft: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-chevron-left"} {...props} />,
    Bot: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-bot"} {...props} />,
    Square: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-square"} {...props} />,
    Eye: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-eye"} {...props} />,
    EyeOff: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-eye-off"} {...props} />,
    Paperclip: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-paperclip"} {...props} />,
    File: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-file"} {...props} />,
    Copy: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-copy"} {...props} />,
    Check: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-check"} {...props} />,
  };
});

// Mock CustomModelDropdown - no longer used but kept for other tests
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => (
    <select
      data-testid="mock-model-dropdown"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Use default</option>
      <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
      <option value="openai/gpt-4o">GPT-4o</option>
    </select>
  ),
}));

// Mock fetchAgents for new chat dialog
vi.mock("../../api", () => ({
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
    { id: "agent-002", name: "Beta", role: "reviewer", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

describe("ChatView mobile behavior", () => {
  let savedVisualViewport: typeof window.visualViewport;
  let savedInnerHeight: number;
  let savedOntouchstart: typeof window.ontouchstart;

  beforeEach(() => {
    _resetInitialViewportHeight();
    savedVisualViewport = window.visualViewport;
    savedInnerHeight = window.innerHeight;
    savedOntouchstart = window.ontouchstart;
  });

  afterEach(() => {
    _resetInitialViewportHeight();
    Object.defineProperty(window, "visualViewport", {
      value: savedVisualViewport,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: savedInnerHeight,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "ontouchstart", {
      value: savedOntouchstart,
      writable: true,
      configurable: true,
    });
  });

  function mockMobileVisualViewport({
    innerHeight,
    vvHeight,
  }: {
    innerHeight: number;
    vvHeight: number;
  }) {
    (window as any).ontouchstart = null;
    Object.defineProperty(window, "innerHeight", {
      value: innerHeight,
      writable: true,
      configurable: true,
    });

    const listeners: Record<string, Array<() => void>> = {
      resize: [],
      scroll: [],
    };

    const mockVV = {
      width: 375,
      height: vvHeight,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners[event]?.push(cb);
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "visualViewport", {
      value: mockVV,
      writable: true,
      configurable: true,
    });

    return { listeners, mockVV };
  }
  function ensureMatchMedia() {
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn(),
      });
    }
  }

  function mockMobileViewport() {
    ensureMatchMedia();
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

  function mockDesktopViewport() {
    ensureMatchMedia();
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

  it("mobile mode: does not render thread header when no active session (list view)", async () => {
    const restoreMatchMedia = mockMobileViewport();
    try {
      setupMockChat({
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        activeSession: null,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Thread header should not be rendered when there's no active session
      expect(document.querySelector(".chat-thread-header")).not.toBeInTheDocument();
      // Back button should not be visible
      expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: renders thread header with back button when session is active", async () => {
    const restoreMatchMedia = mockMobileViewport();
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Thread header should be rendered when there's an active session
      expect(document.querySelector(".chat-thread-header")).toBeInTheDocument();
      // Back button should be visible in mobile thread view
      expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: tapping back button calls selectSession with empty string to return to list", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const selectSession = vi.fn();
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
        selectSession,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const backBtn = screen.getByTestId("chat-back-btn");
      await userEvent.click(backBtn);

      // Back button should trigger selectSession("") to return to list view
      expect(selectSession).toHaveBeenCalledWith("");
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: thread header title opens quick session switcher and closes after selection", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const selectSession = vi.fn();
    try {
      setupMockChat({
        sessions: [
          { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
          { id: "session-002", agentId: "agent-002", status: "active", title: "Another Chat", createdAt: "2026-04-07T00:00:00.000Z", updatedAt: "2026-04-07T00:00:00.000Z" },
        ],
        filteredSessions: [
          { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
          { id: "session-002", agentId: "agent-002", status: "active", title: "Another Chat", createdAt: "2026-04-07T00:00:00.000Z", updatedAt: "2026-04-07T00:00:00.000Z" },
        ],
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        selectSession,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const trigger = screen.getByTestId("chat-mobile-session-trigger");
      expect(trigger).toHaveClass("btn", "chat-mobile-session-trigger");
      expect(trigger).not.toHaveClass("btn-icon");
      expect(trigger).toHaveTextContent("Test Chat");

      await userEvent.click(trigger);
      expect(screen.getByTestId("chat-mobile-session-dropdown")).toBeInTheDocument();

      await userEvent.click(screen.getByTestId("chat-mobile-session-option-session-002"));
      expect(selectSession).toHaveBeenCalledWith("session-002");
      expect(screen.queryByTestId("chat-mobile-session-dropdown")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: quick session switcher closes on outside click and is not shown for rooms", async () => {
    const restoreMatchMedia = mockMobileViewport();
    try {
      setupMockChat({ activeSession: activeSessionFixture });
      const initialRender = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(screen.queryByTestId("chat-mobile-session-trigger")).toBeInTheDocument();
      await userEvent.click(screen.getByTestId("chat-mobile-session-trigger"));
      expect(screen.getByTestId("chat-mobile-session-dropdown")).toBeInTheDocument();

      fireEvent.mouseDown(document.body);
      await waitFor(() => {
        expect(screen.queryByTestId("chat-mobile-session-dropdown")).not.toBeInTheDocument();
      });

      initialRender.unmount();

      localStorage.setItem("fusion:chat-scope", "rooms");
      setupMockRooms({
        activeRoom: {
          id: "room-001",
          projectId: "proj-123",
          name: "backend",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
      expect(screen.queryByTestId("chat-mobile-session-trigger")).not.toBeInTheDocument();
      expect(screen.getByText("#backend")).toBeInTheDocument();
    } finally {
      localStorage.setItem("fusion:chat-scope", "direct");
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: iOS first tap focuses direct composer without blocking native focus, then sends", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const isIOSSpy = vi.spyOn(mobileScrollLock, "isIOS").mockReturnValue(true);
    const sendMessage = vi.fn();

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [],
        sendMessage,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
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

      fireEvent.change(input, { target: { value: "Hello mobile" } });
      const sendButton = screen.getByTestId("chat-send-btn");
      fireEvent.touchStart(sendButton);
      fireEvent.click(sendButton);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith("Hello mobile", []);
      expect(document.activeElement).toBe(input);
    } finally {
      isIOSSpy.mockRestore();
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: send button sends on first touch and keeps composer focused", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const sendMessage = vi.fn();

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [],
        sendMessage,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Hello mobile" } });
      input.focus();

      const sendButton = screen.getByTestId("chat-send-btn");
      fireEvent.touchStart(sendButton);
      fireEvent.click(sendButton);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith("Hello mobile", []);
      expect(document.activeElement).toBe(input);
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: room send button sends on first touch and keeps composer focused", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const sendRoomMessage = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn();

    try {
      localStorage.setItem("fusion:chat-scope", "rooms");
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [],
        sendMessage,
      });
      setupMockRooms({
        activeRoom: {
          id: "room-001",
          projectId: "proj-123",
          name: "backend",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        sendRoomMessage,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "Hello mobile room" } });
      input.focus();

      const sendButton = screen.getByTestId("chat-send-btn");
      fireEvent.touchStart(sendButton);
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(sendRoomMessage).toHaveBeenCalledTimes(1);
        expect(sendRoomMessage).toHaveBeenCalledWith("Hello mobile room", { files: [] });
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
    } finally {
      localStorage.removeItem("fusion:chat-scope");
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: sets and clears keyboard overlap CSS vars on chat thread", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();
      expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("0px");

      // Focus the chat textarea so the hook treats the active element as a
      // keyboard-focusable target.
      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", {
        value: 560,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("284px");
        expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");
      });

      // Blur to signal keyboard dismissal
      await act(async () => {
        textarea.blur();
      });

      Object.defineProperty(mockVV, "height", {
        value: 844,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("284px");
        expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: applies keyboard-active class for iOS fallback when viewport offset is present", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();
      expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(false);

      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", { value: 784, writable: true, configurable: true });
      Object.defineProperty(mockVV, "offsetTop", { value: 16, writable: true, configurable: true });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("0px");
        expect(thread.style.getPropertyValue("--vv-height")).toBe("784px");
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(true);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-5365: mobile keyboard viewport vars follow settled sample and suppress blur-dismiss shrink", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();
      expect(thread.style.getPropertyValue("--vv-height")).toBe("844px");
      expect(thread.style.getPropertyValue("--vv-offset-top")).toBe("0px");
      expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("0px");

      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "offsetTop", { value: 180, writable: true, configurable: true });
      Object.defineProperty(mockVV, "height", { value: 820, writable: true, configurable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });
      expect(thread.style.getPropertyValue("--vv-height")).toBe("820px");

      Object.defineProperty(mockVV, "offsetTop", { value: 0, writable: true, configurable: true });
      Object.defineProperty(mockVV, "height", { value: 560, writable: true, configurable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");
        expect(thread.style.getPropertyValue("--vv-offset-top")).toBe("0px");
        expect(thread.style.getPropertyValue("--keyboard-overlap")).toBe("284px");
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(true);
      });

      const styleAfterVvEvents = thread.getAttribute("style") ?? "";
      expect(styleAfterVvEvents).toContain("--vv-height: 560px");
      expect(styleAfterVvEvents).toContain("--vv-offset-top: 0px");
      expect(styleAfterVvEvents).toContain("--keyboard-overlap: 284px");

      await act(async () => {
        textarea.blur();
        document.dispatchEvent(new Event("focusout"));
      });
      await waitFor(() => {
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(false);
      });

      Object.defineProperty(mockVV, "height", { value: 700, writable: true, configurable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });
      expect(thread.style.getPropertyValue("--vv-height")).toBe("560px");

      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", { value: 640, writable: true, configurable: true });
      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.style.getPropertyValue("--vv-height")).toBe("640px");
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: removes keyboard-active class immediately on blur even before visualViewport settles", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const thread = document.querySelector(".chat-thread") as HTMLDivElement;
      expect(thread).toBeInTheDocument();

      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(mockVV, "height", { value: 560, writable: true, configurable: true });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(true);
      });

      await act(async () => {
        textarea.blur();
        document.dispatchEvent(new Event("focusout"));
      });

      await waitFor(() => {
        expect(thread.classList.contains("chat-thread--keyboard-active")).toBe(false);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: scrolls messages container to bottom when keyboard opens", async () => {
    _resetInitialViewportHeight();
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      expect(messagesContainer).toBeInTheDocument();

      Object.defineProperty(messagesContainer, "scrollHeight", {
        value: 900,
        configurable: true,
      });
      // In jsdom, scrollTop on a non-scrollable div may not reflect writes.
      // Intercept the setter so the assertion can read back the value the effect wrote.
      let capturedScrollTop = 0;
      Object.defineProperty(messagesContainer, "scrollTop", {
        get() { return capturedScrollTop; },
        set(v: number) { capturedScrollTop = v; },
        configurable: true,
      });

      // Focus the chat textarea so the hook treats the active element as a
      // keyboard-focusable target.
      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await act(async () => {
        textarea.focus();
      });
      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      Object.defineProperty(window, "innerHeight", {
        value: 560,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 560,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(messagesContainer.scrollTop).toBe(900);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: does not force window scroll when keyboard opens", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { listeners, mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      Object.defineProperty(window, "innerHeight", {
        value: 560,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 560,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(scrollToSpy).not.toHaveBeenCalled();
      });
    } finally {
      scrollToSpy.mockRestore();
      restoreMatchMedia.mockRestore();
    }
  });

  it("mobile mode: does not subscribe to keyboard tracking without active session", async () => {
    const restoreMatchMedia = mockMobileViewport();
    const { mockVV } = mockMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 600,
    });

    try {
      setupMockChat({
        activeSession: null,
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(mockVV.addEventListener).toHaveBeenCalledTimes(1);
        expect(mockVV.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
        expect(mockVV.addEventListener).not.toHaveBeenCalledWith("scroll", expect.any(Function));
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("desktop mode: renders thread header even without active session (shows empty state)", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
        activeSession: null,
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Desktop mode: thread header should always be visible (even in empty state)
      expect(document.querySelector(".chat-thread-header")).toBeInTheDocument();
      // Back button should not be visible in desktop mode
      expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
      // Should show empty state
      expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("desktop mode: thread header is visible with active session", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Desktop mode: thread header should always be visible
      expect(document.querySelector(".chat-thread-header")).toBeInTheDocument();
      // Back button should not be visible in desktop mode
      expect(screen.queryByTestId("chat-back-btn")).not.toBeInTheDocument();
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("shows jump-to-latest only after scrolling away from bottom and jumps back on click", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      scrollTopValue = 600;
      fireEvent.scroll(messagesContainer);
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      await userEvent.click(screen.getByTestId("chat-jump-to-latest"));
      expect(scrollTopValue).toBe(1000);
      await waitFor(() => {
        expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("shows jump-to-latest in rooms after scrolling away from bottom and jumps back on click", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    localStorage.setItem("fusion:chat-scope", "rooms");
    try {
      setupMockChat({ activeSession: null, messages: [] });
      setupMockRooms({
        activeRoom: createRoomFixture("general"),
        rooms: [createRoomFixture("general")],
        messages: [
          {
            id: "room-msg-001",
            roomId: "room-general",
            role: "assistant",
            content: "One",
            thinkingOutput: null,
            metadata: null,
            senderAgentId: null,
            mentions: [],
            createdAt: "2026-05-12T00:00:00.000Z",
          },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();

      scrollTopValue = 600;
      fireEvent.scroll(messagesContainer);
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      await userEvent.click(screen.getByTestId("chat-jump-to-latest"));
      expect(scrollTopValue).toBe(1000);
      await waitFor(() => {
        expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
      });
    } finally {
      localStorage.removeItem("fusion:chat-scope");
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: snaps to bottom when opening a session with loaded messages", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 950 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(950);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: re-anchors when messagesLoading transitions to loaded with messages", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({ activeSession: activeSessionFixture, messages: [], messagesLoading: true });
      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 980 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      setupMockChat({
        activeSession: activeSessionFixture,
        messagesLoading: false,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "Loaded", createdAt: "2026-04-08T00:00:00.000Z" }],
      });
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(980);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-4040: mobile thread entry anchors to latest message", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1040 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1040);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-4040: mobile visibility restore re-anchors chat thread to latest", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 250;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1180 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      fireEvent(document, new Event("visibilitychange"));
      scrollTopValue = 300;

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));

      // Regression guard: visibility restore must explicitly re-anchor when pinned.
      // Without that, this only passed when leftover anchorToBottom rAF callbacks
      // happened to run after the visibility event.
      expect(scrollTopValue).toBe(1180);
    } finally {
      restoreMatchMedia.mockRestore();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  it("FN-4336: direct chat re-anchors on ResizeObserver growth in mobile", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 1000;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1000);
      });

      scrollHeightValue = 1300;
      await act(async () => {
        resizeCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1300);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalResizeObserver) {
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("FN-4336: direct chat ResizeObserver growth keeps thread pinned", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 2000;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      fireEvent.scroll(messagesContainer);
      scrollHeightValue = 2400;

      await act(async () => {
        resizeCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(2400);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalResizeObserver) {
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("FN-4336: visibility restore performs deferred direct chat settle pass", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    vi.useFakeTimers();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 1000;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      scrollHeightValue = 1500;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(260);
        await vi.runOnlyPendingTimersAsync();
      });

      expect(scrollTopValue).toBe(1500);
    } finally {
      restoreMatchMedia.mockRestore();
      vi.useRealTimers();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  it("FN-4336: rooms scope does not attach direct ResizeObserver follower", async () => {
    const restoreMatchMedia = mockViewportMode("mobile");
    const originalResizeObserver = globalThis.ResizeObserver;
    localStorage.setItem("fusion:chat-scope", "rooms");
    const resizeObserverCtor = vi.fn();

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCtor(callback);
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    try {
      setupMockChat({ activeSession: null, messages: [] });
      setupMockRooms({
        activeRoom: createRoomFixture("general"),
        rooms: [createRoomFixture("general")],
        messages: [
          {
            id: "room-msg-001",
            roomId: "room-general",
            role: "assistant",
            content: "Room message",
            thinkingOutput: null,
            metadata: null,
            senderAgentId: null,
            mentions: [],
            createdAt: "2026-05-12T00:00:00.000Z",
          },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      await waitFor(() => {
        expect(screen.getByTestId("chat-sidebar-rooms")).toBeInTheDocument();
      });
      expect(resizeObserverCtor).not.toHaveBeenCalled();
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalResizeObserver) {
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("FN-4336: desktop direct chat still re-anchors on ResizeObserver growth", async () => {
    const restoreMatchMedia = mockViewportMode("desktop");
    const originalResizeObserver = globalThis.ResizeObserver;
    let resizeCallback: ResizeObserverCallback | null = null;

    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 1200;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 300 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1200);
      });

      scrollHeightValue = 1700;
      await act(async () => {
        resizeCallback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      });

      await waitFor(() => {
        expect(scrollTopValue).toBe(1700);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      if (originalResizeObserver) {
        vi.stubGlobal("ResizeObserver", originalResizeObserver);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  it("FN-5380: desktop visibility restore preserves manual direct-thread scroll", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 600;
      let scrollHeightValue = 1200;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      fireEvent.scroll(messagesContainer);
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));

      await waitFor(() => {
        expect(scrollTopValue).toBe(600);
      });
      expect(screen.getByTestId("chat-jump-to-latest")).toBeInTheDocument();

      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" },
          { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Two", createdAt: "2026-04-08T00:00:10.000Z" },
        ],
      });
      scrollTopValue = 700;
      scrollHeightValue = 1300;
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(1300);
      });
    } finally {
      restoreMatchMedia.mockRestore();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  it("FN-5380: desktop pageshow preserves direct chat scroll position", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 420;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1280 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      fireEvent(window, new Event("pageshow"));

      await waitFor(() => {
        expect(scrollTopValue).toBe(420);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: retries bottom anchor while container height keeps growing", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    const originalRaf = window.requestAnimationFrame;
    const rafQueue: FrameRequestCallback[] = [];
    window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 600;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      scrollHeightValue = 900;
      await act(async () => {
        while (rafQueue.length > 0) {
          const cb = rafQueue.shift();
          cb?.(performance.now());
        }
      });

      expect(scrollTopValue).toBe(900);
    } finally {
      window.requestAnimationFrame = originalRaf;
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: snaps to bottom when switching active session id", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });
      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 0;
      let scrollHeightValue = 900;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => scrollHeightValue });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      setupMockChat({
        activeSession: { ...activeSessionFixture, id: "session-002" },
        messages: [{ id: "msg-101", sessionId: "session-002", role: "assistant", content: "Two", createdAt: "2026-04-08T00:01:00.000Z" }],
      });
      scrollHeightValue = 1300;
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(1300);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });

  it("FN-3884: does not yank when user scrolled up on same-session updates", async () => {
    const restoreMatchMedia = mockDesktopViewport();
    try {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [{ id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" }],
      });

      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      const messagesContainer = document.querySelector(".chat-messages") as HTMLDivElement;
      let scrollTopValue = 700;
      Object.defineProperty(messagesContainer, "scrollHeight", { configurable: true, get: () => 1200 });
      Object.defineProperty(messagesContainer, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(messagesContainer, "scrollTop", {
        configurable: true,
        get: () => scrollTopValue,
        set: (value: number) => {
          scrollTopValue = value;
        },
      });

      fireEvent.scroll(messagesContainer);

      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          { id: "msg-000", sessionId: "session-001", role: "assistant", content: "Older", createdAt: "2026-04-07T23:59:00.000Z" },
          { id: "msg-001", sessionId: "session-001", role: "assistant", content: "One", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
      });
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(scrollTopValue).toBe(700);
      });
    } finally {
      restoreMatchMedia.mockRestore();
    }
  });
});

describe("ChatView mobile CSS contract", () => {
  const css = loadAllAppCss();

  // Helper to find a selector rule within any mobile media query block
  function findMobileRule(selector: string): string | null {
    const mobileRegex = /@media[^{]*\(max-width:\s*768px\)[^{]*\{([\s\S]*?)\n\}/g;
    let match;
    while ((match = mobileRegex.exec(css)) !== null) {
      const mediaContent = match[1];
      if (mediaContent.includes(selector)) {
        const ruleMatch = mediaContent.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
        if (ruleMatch) return ruleMatch[1];
      }
    }
    return null;
  }

  // Helper to check if any mobile media query contains a selector with a specific property
  function mobileRuleContains(selector: string, property: string): boolean {
    const ruleCSS = findMobileRule(selector);
    return ruleCSS !== null && ruleCSS.includes(property);
  }

  // Helper to check if a selector does NOT contain a property in any mobile media query
  function mobileRuleNotContains(selector: string, property: string): boolean {
    const mobileRegex = /@media[^{]*\(max-width:\s*768px\)[^{]*\{([\s\S]*?)\n\}/g;
    let match;
    while ((match = mobileRegex.exec(css)) !== null) {
      const mediaContent = match[1];
      if (mediaContent.includes(selector)) {
        const ruleMatch = mediaContent.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
        if (ruleMatch && ruleMatch[1].includes(property)) {
          return false;
        }
      }
    }
    return true;
  }

  it("mobile .chat-sidebar uses height: 100% instead of max-height: 40vh", async () => {
    expect(mobileRuleContains(".chat-sidebar", "height: 100%")).toBe(true);
    expect(mobileRuleNotContains(".chat-sidebar", "max-height: 40vh")).toBe(true);
  });

  it("keeps the shared header outside the bounded chat body row", async () => {
    const viewRule = css.match(/\.chat-view\s*\{([^}]*)\}/)?.[1] ?? "";
    const bodyRule = css.match(/\.chat-view__body\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(viewRule).toContain("flex-direction: column;");
    expect(viewRule).toContain("min-height: 0;");
    expect(bodyRule).toContain("display: flex;");
    expect(bodyRule).toContain("flex: 1 1 auto;");
    expect(bodyRule).toContain("min-height: 0;");
    expect(bodyRule).toContain("overflow: hidden;");
  });

  it("mobile .chat-sidebar-header is hidden", async () => {
    expect(mobileRuleContains(".chat-sidebar-header", "display: none")).toBe(true);
  });

  it("mobile .chat-sidebar-search remains visible (FN-4120)", async () => {
    expect(mobileRuleNotContains(".chat-sidebar-search", "display: none")).toBe(true);
  });

  it("mobile .chat-sidebar-search keeps a token-based touch target (FN-4120)", async () => {
    expect(mobileRuleContains(".chat-sidebar-search", "min-height: calc(var(--space-2xl) + var(--space-xs))")).toBe(true);
  });

  it("mobile .chat-sidebar-list has flex: 1 and overflow-y: auto for scrolling", async () => {
    expect(mobileRuleContains(".chat-sidebar-list", "flex: 1")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-list", "overflow-y: auto")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-list", "min-height: 0")).toBe(true);
  });

  it("mobile .chat-sidebar-footer exists with display block and border-top", async () => {
    expect(mobileRuleContains(".chat-sidebar-footer", "display: block")).toBe(true);
    expect(mobileRuleContains(".chat-sidebar-footer", "border-top")).toBe(true);
  });

  it("mobile .chat-sidebar-footer-btn stays full-width and centered", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-sidebar-footer\s+\.chat-sidebar-footer-btn\s*\{[^}]*width:\s*100%[^}]*justify-content:\s*center/);
  });

  it("mobile does not override assistant render toggle visibility", async () => {
    expect(mobileRuleNotContains(".chat-message-render-toggle", "display: inline-flex")).toBe(true);
  });

  it("mobile keeps ChatView dialog backdrop centered with safe-area padding", async () => {
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "align-items: center")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "justify-content: center")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "overflow-y: auto")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "padding-top: max(var(--space-md), env(safe-area-inset-top, 0px))")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog-backdrop", "padding-bottom: max(var(--space-md), env(safe-area-inset-bottom, 0px))")).toBe(true);
  });

  it("mobile constrains ChatView dialog height and allows internal scrolling", async () => {
    expect(mobileRuleContains(".chat-view-dialog", "max-height: calc(100dvh - (var(--space-md) * 2) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "display: flex")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "flex-direction: column")).toBe(true);
    expect(mobileRuleContains(".chat-view-dialog", "overflow-y: auto")).toBe(true);
  });

  it("mobile ChatView dialog rules do not set full-screen heights", async () => {
    expect(mobileRuleNotContains(".chat-view-dialog", "height: 100vh")).toBe(true);
    expect(mobileRuleNotContains(".chat-view-dialog", "height: 100dvh")).toBe(true);
  });

  it("mobile includes keyboard-aware chat-thread height rule", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread--keyboard-active\s*\{[^}]*--vv-height/);
  });

  it("mobile widens chat bubbles for readability", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message\s*\{[^}]*max-width:\s*90%/);
  });

  it("mobile keeps thread-header identity and render toggle inline", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header-identity\s*\{[^}]*flex:\s*1\s+1\s+auto[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-thread-header-render-toggle\s*\{[^}]*flex-shrink:\s*0/);
  });

  it("FN-4352: response copy action stays compact on mobile", async () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*opacity:\s*1/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*min-width:\s*calc\(var\(--space-lg\)\s*\*\s*2\.25\)/);
    expect(css).not.toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*?\.chat-message-copy-action\s*\{[^}]*min-height:\s*calc\(var\(--space-lg\)\s*\*\s*2\.25\)/);
  });
});

describe("ChatView empty-state token guards", () => {
  it("renders loading and empty states with chat-empty-state class and no inline text-secondary style", async () => {
    setupMockChat({
      sessions: [],
      filteredSessions: [],
      sessionsLoading: true,
      activeSession: activeSessionFixture,
      messages: [],
      messagesLoading: true,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const loadingNodes = screen.getAllByText("Loading messages...");
    const sidebarLoadingNode = screen.getByText("Loading...");

    const legacyToken = `--text-${"secondary"}`;
    expect(sidebarLoadingNode.className).toContain("chat-empty-state");
    expect(sidebarLoadingNode.getAttribute("style") ?? "").not.toContain(legacyToken);

    for (const node of loadingNodes) {
      expect(node.className).toContain("chat-empty-state");
      expect(node.getAttribute("style") ?? "").not.toContain(legacyToken);
    }
  });

  it("keeps ChatView source files free of deprecated secondary token", async () => {
    const chatViewTsx = readFileSync("app/components/ChatView.tsx", "utf8");
    const chatViewCss = readFileSync("app/components/ChatView.css", "utf8");
    const legacyToken = `--text-${"secondary"}`;

    expect(chatViewTsx.includes(legacyToken)).toBe(false);
    expect(chatViewCss.includes(legacyToken)).toBe(false);
  });
});


import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import type { ChatSessionInfo } from "../../hooks/useChat";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

// Factories stay inline: importing the shared harness from a factory creates a TDZ cycle.
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

function session(id: string, title: string | null): ChatSessionInfo {
  return { ...activeSessionFixture, id, title, updatedAt: "2026-09-14T00:00:00.000Z" };
}

function useChatWith(active: ChatSessionInfo, others: ChatSessionInfo[] = []) {
  const sessions = [active, ...others];
  setupMockChat({ ...defaultChatState, activeSession: active, sessions, filteredSessions: sessions });
}

function headerTitleText() {
  return document.querySelector(".chat-view .view-header__title-content")?.textContent ?? "";
}

/*
FNXC:DashboardTests 2026-09-14-23:48:
jsdom returns a zero-width rect and installs a no-op ResizeObserver, so a floating ChatView is always
measured narrow unless the host width is stubbed explicitly. The desktop case must force a real width.
*/
function withMeasuredHost(width: number) {
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width, height: 720, top: 0, right: width, bottom: 720, left: 0, toJSON: () => ({}),
  });
  return () => rectSpy.mockRestore();
}

describe("ChatView active-session identity sync", () => {
  /*
  FNXC:ChatWindows 2026-09-14-23:48:
  FN-396: a detached window used to render the session snapshot captured when it opened, so renaming the
  conversation left the old title in the window header until the operator closed and reopened it. The host
  now receives the live session identity; these cases are the symptom regression for that stale title.
  */
  it.each([["desktop", 1280], ["mobile", 390]] as const)(
    "reports a renamed dedicated conversation to its host on %s",
    async (mode, width) => {
      const restoreRect = withMeasuredHost(width);
      const restoreViewport = mockViewportMode(mode === "mobile" ? "mobile" : "desktop");
      const onActiveSessionChange = vi.fn();
      const initial = session("session-001", "Ancien");
      useChatWith(initial);

      const renderDedicated = () => (
        <ChatView
          projectId="proj-123"
          addToast={vi.fn()}
          floating
          dedicatedConversation
          initialDirectSession={initial}
          initialDirectSessionNonce={1}
          persistChatPreferences={false}
          onActiveSessionChange={onActiveSessionChange}
        />
      );

      const { rerender } = await renderWithAct(renderDedicated());
      expect(onActiveSessionChange).toHaveBeenCalledWith(expect.objectContaining({ id: "session-001", title: "Ancien" }));
      onActiveSessionChange.mockClear();

      useChatWith(session("session-001", "Nouveau"));
      await act(async () => { rerender(renderDedicated()); });

      expect(onActiveSessionChange).toHaveBeenCalledWith(expect.objectContaining({ id: "session-001", title: "Nouveau" }));
      expect(headerTitleText()).toContain("Nouveau");

      restoreViewport.mockRestore();
      restoreRect();
    },
  );

  it("does not re-notify the host when no rendered identity field changed", async () => {
    const onActiveSessionChange = vi.fn();
    const initial = session("session-001", "Stable");
    useChatWith(initial);
    const element = () => (
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        floating
        dedicatedConversation
        initialDirectSession={initial}
        initialDirectSessionNonce={1}
        persistChatPreferences={false}
        onActiveSessionChange={onActiveSessionChange}
      />
    );
    const { rerender } = await renderWithAct(element());
    onActiveSessionChange.mockClear();

    // Same rendered identity, new object reference plus an unrendered field change.
    useChatWith({ ...initial, lastMessagePreview: "nouveau message" });
    await act(async () => { rerender(element()); });

    expect(onActiveSessionChange).not.toHaveBeenCalled();
  });

  it("falls back to the untitled label and still reports a blank title", async () => {
    const onActiveSessionChange = vi.fn();
    const initial = session("session-001", "Ancien");
    useChatWith(initial);
    const element = () => (
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        floating
        dedicatedConversation
        initialDirectSession={initial}
        initialDirectSessionNonce={1}
        persistChatPreferences={false}
        onActiveSessionChange={onActiveSessionChange}
      />
    );
    const { rerender } = await renderWithAct(element());
    onActiveSessionChange.mockClear();

    useChatWith(session("session-001", "   "));
    await act(async () => { rerender(element()); });

    expect(onActiveSessionChange).toHaveBeenCalledWith(expect.objectContaining({ id: "session-001", title: "   " }));
    expect(headerTitleText()).toContain("Untitled conversation");
  });

  it("follows a rename in the thread title switcher and the conversation list of a non-dedicated host", async () => {
    const initial = session("session-001", "Ancien");
    const other = session("session-002", "Beta");
    useChatWith(initial, [other]);
    const element = () => <ChatView projectId="proj-123" addToast={vi.fn()} />;
    const { rerender } = await renderWithAct(element());
    await userEvent.click(screen.getByTestId("chat-session-session-001"));
    expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Ancien");

    useChatWith(session("session-001", "Nouveau"), [other]);
    await act(async () => { rerender(element()); });

    expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Nouveau");
    expect(screen.getByTestId("chat-session-session-001")).toHaveTextContent("Nouveau");
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
    expect(await screen.findByTestId("chat-thread-title-menu-item-session-001")).toHaveTextContent("Nouveau");
  });
});

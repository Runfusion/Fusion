/*
FNXC:ChatWindows 2026-09-18-01:28:
This suite mocks `useChat`, so its list rows and its active session come from ONE fixture: it pins
the RENDERING contract (which surfaces paint the live session identity on each host and breakpoint),
not the convergence of the two title writers inside the hook. FN-524 proves that convergence in
`ChatView.session-title-sync-live.test.tsx`, which mounts the real hook and drives real events.
*/

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

/** Same as {@link useChatWith}, with the assistant actively streaming its reply. */
function useStreamingChatWith(active: ChatSessionInfo, others: ChatSessionInfo[] = []) {
  const sessions = [active, ...others];
  setupMockChat({
    ...defaultChatState,
    activeSession: active,
    sessions,
    filteredSessions: sessions,
    isStreaming: true,
    streamingText: "Je regarde ça",
  });
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

  /*
  FNXC:ChatWindows 2026-09-16-05:31:
  FN-455 symptom: a conversation opened before its server-generated title existed showed
  "Untitled conversation" in the window header until it was closed and reopened. Once the live
  session carries the generated title, the header and the host notification must follow it on
  both breakpoints.
  */
  it.each([["desktop", 1280], ["mobile", 390]] as const)(
    "shows a freshly generated title in an untitled dedicated conversation on %s",
    async (mode, width) => {
      const restoreRect = withMeasuredHost(width);
      const restoreViewport = mockViewportMode(mode === "mobile" ? "mobile" : "desktop");
      const onActiveSessionChange = vi.fn();
      const initial = session("session-001", null);
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
      expect(headerTitleText()).toContain("Untitled conversation");
      onActiveSessionChange.mockClear();

      useChatWith(session("session-001", "Titre généré"));
      await act(async () => { rerender(renderDedicated()); });

      expect(onActiveSessionChange).toHaveBeenCalledWith(
        expect.objectContaining({ id: "session-001", title: "Titre généré" }),
      );
      expect(headerTitleText()).toContain("Titre généré");
      expect(headerTitleText()).not.toContain("Untitled conversation");

      restoreViewport.mockRestore();
      restoreRect();
    },
  );

  // (C5) Non-dedicated host: header switcher AND list row converge on the generated title.
  it("shows a freshly generated title in the thread switcher and the conversation list", async () => {
    const initial = session("session-001", null);
    const other = session("session-002", "Beta");
    useChatWith(initial, [other]);
    const element = () => <ChatView projectId="proj-123" addToast={vi.fn()} />;
    const { rerender } = await renderWithAct(element());
    await userEvent.click(screen.getByTestId("chat-session-session-001"));
    expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Untitled conversation");

    useChatWith(session("session-001", "Titre généré"), [other]);
    await act(async () => { rerender(element()); });

    expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Titre généré");
    expect(screen.getByTestId("chat-session-session-001")).toHaveTextContent("Titre généré");
  });

  /*
  FNXC:ChatWindows 2026-09-17-11:42:
  FN-505 symptom acceptance on the rendered surfaces. The operator's report is specifically about
  WHEN the name appears: the header still read "Untitled conversation" while the assistant was
  already replying. Naming is now two-stage, so both the provisional and the refined title must
  reach the header AND the conversation list row while `isStreaming` is true — on both breakpoints.
  jsdom measures every host at zero width, so the breakpoint is forced through the rect stub.
  */
  it.each([["desktop", 1200], ["mobile", 720]] as const)(
    "shows both naming stages in the header and the list row while streaming on %s",
    async (mode, width) => {
      const restoreRect = withMeasuredHost(width);
      const restoreViewport = mockViewportMode(mode === "mobile" ? "mobile" : "desktop");
      const other = session("session-002", "Beta");
      useStreamingChatWith(session("session-001", null), [other]);
      const element = () => <ChatView projectId="proj-123" addToast={vi.fn()} />;
      const { rerender } = await renderWithAct(element());
      await userEvent.click(screen.getByTestId("chat-session-session-001"));
      expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Untitled conversation");

      // Stage one: the provisional title lands while the reply is still streaming.
      useStreamingChatWith(session("session-001", "Corrige le titre de la conversation"), [other]);
      await act(async () => { rerender(element()); });
      expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Corrige le titre de la conversation");
      expect(screen.getByTestId("chat-session-session-001")).toHaveTextContent("Corrige le titre de la conversation");
      expect(screen.getByTestId("chat-thread-title-trigger")).not.toHaveTextContent("Untitled conversation");

      // Stage two: the refined title replaces it, still mid-stream.
      useStreamingChatWith(session("session-001", "Titre de conversation"), [other]);
      await act(async () => { rerender(element()); });
      expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Titre de conversation");
      expect(screen.getByTestId("chat-session-session-001")).toHaveTextContent("Titre de conversation");

      restoreViewport.mockRestore();
      restoreRect();
    },
  );

  /*
  FNXC:ChatWindows 2026-09-17-11:42:
  FN-505 (o): detached chat windows render the session identity their host hands them, so each naming
  stage must re-notify the host even when `title` is the only field that changed.
  */
  it("re-notifies a detached window host for each naming stage", async () => {
    const onActiveSessionChange = vi.fn();
    const initial = session("session-001", null);
    useStreamingChatWith(initial);
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
    onActiveSessionChange.mockClear();

    useStreamingChatWith(session("session-001", "Corrige le titre de la conversation"));
    await act(async () => { rerender(renderDedicated()); });
    expect(onActiveSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "session-001", title: "Corrige le titre de la conversation" }),
    );

    useStreamingChatWith(session("session-001", "Titre de conversation"));
    await act(async () => { rerender(renderDedicated()); });
    expect(onActiveSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "session-001", title: "Titre de conversation" }),
    );
    expect(headerTitleText()).toContain("Titre de conversation");
  });

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

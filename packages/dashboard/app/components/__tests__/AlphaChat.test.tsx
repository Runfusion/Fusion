import "../../alpha-ui.css";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AlphaProvider, AlphaBoundary } from "../../context/AlphaContext";
import { AlphaTextArea } from "../alpha-ui";
import { StandardChatActionButton } from "../StandardChatSurface";
import { ChatView } from "../ChatView";
import { PoppedOutChatWindows, QuickChatWindow } from "../PoppedOutChatWindows";
import { STATIC_OVERFLOW_VIEW_ENTRIES } from "../overflowViewRegistry";
import { readAppFile } from "../../test/cssFixture";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  mockViewportMode,
  openFirstConversation,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({ useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }) }));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchChatSession: vi.fn().mockResolvedValue({ session: null }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

function ChatFixture({ alpha, streaming = false }: { alpha: boolean; streaming?: boolean }) {
  const [draft, setDraft] = useState("bonjour");
  return (
    <AlphaProvider enabled={alpha}>
      <AlphaBoundary>
        <AlphaTextArea aria-label="Composer" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <StandardChatActionButton isStreaming={streaming} canSend={draft.trim().length > 0} onSend={vi.fn()} onStop={vi.fn()} showSendText />
      </AlphaBoundary>
    </AlphaProvider>
  );
}

describe("homemade Alpha Chat", () => {
  it("scopes compact chat and composer density to Alpha at desktop and mobile", () => {
    const chatCss = readAppFile("components/ChatView.css");
    const composeCss = readAppFile("components/ComposeChatPanel.css");
    expect(chatCss).toContain('[data-alpha-surface="true"] .chat-session-item');
    expect(chatCss).toContain('[data-alpha-surface="true"] .chat-thread-header');
    expect(chatCss).toContain("min-block-size: var(--alpha-control-height)");
    expect(chatCss).toContain("min-block-size: var(--alpha-touch-height)");
    expect(composeCss).toContain('[data-alpha-surface="true"] .compose-chat-panel__actions > .btn');
    expect(composeCss).toContain("flex: 0 1 auto");
  });

  it("keeps a production Chat focus shadow valid, theme-neutral, and light/dark responsive", () => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.colorTheme = "cozy-cartoon";
    render(<ChatFixture alpha streaming />);

    const stopButton = screen.getByRole("button", { name: "Stop generation" });
    stopButton.focus();
    expect(stopButton).toHaveFocus();
    const lightStyle = getComputedStyle(stopButton);
    const lightRing = lightStyle.getPropertyValue("--focus-ring-strong");
    const lightAccent = lightStyle.getPropertyValue("--alpha-neutral-accent");
    expect(lightRing).toMatch(/^\s*0 0 0 0\.125rem color-mix\(/);

    document.documentElement.dataset.colorTheme = "shadcn-purple";
    expect(getComputedStyle(stopButton).getPropertyValue("--focus-ring-strong")).toBe(lightRing);

    document.documentElement.dataset.theme = "dark";
    const darkStyle = getComputedStyle(stopButton);
    expect(darkStyle.getPropertyValue("--focus-ring-strong")).toBe(lightRing);
    expect(darkStyle.getPropertyValue("--alpha-neutral-accent")).not.toBe(lightAccent);
  });

  it("keeps production Chat semantic styles independent from Fusion color themes", async () => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.colorTheme = "cozy-cartoon";
    setupMockChat({
      ...defaultChatState,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
    });
    setupMockRooms();

    try {
      const view = await renderWithAct(<ChatView projectId="project-theme" addToast={vi.fn()} experimentalFeatures={{}} />);
      const chat = view.container.querySelector<HTMLElement>(".chat-view");
      const productionButton = view.container.querySelector<HTMLElement>('[data-alpha-ui="button"]');
      expect(chat).not.toBeNull();
      expect(productionButton).not.toBeNull();
      const semanticPalette = (element: Element) => {
        const style = getComputedStyle(element);
        return [
          style.getPropertyValue("--color-info"),
          style.getPropertyValue("--color-warning"),
          style.getPropertyValue("--color-error"),
          style.getPropertyValue("--color-success"),
          style.getPropertyValue("--todo"),
        ];
      };
      const initial = semanticPalette(chat!);
      expect(initial).toEqual(Array.from({ length: 5 }, () => expect.stringMatching(/\S/)));
      expect(semanticPalette(productionButton!)).toEqual(initial);

      document.documentElement.dataset.colorTheme = "shadcn-purple";
      expect(semanticPalette(chat!)).toEqual(initial);
      expect(semanticPalette(productionButton!)).toEqual(initial);
    } finally {
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.removeAttribute("data-color-theme");
    }
  });

  it.each([
    ["desktop", "desktop", false, false],
    ["mobile", "mobile", false, false],
    ["compact dock", "desktop", false, true],
    ["floating", "desktop", true, false],
  ] as const)("renders the populated production ChatView in %s through homemade Alpha", async (_host, viewport, floating, compactLayout) => {
    const restoreViewport = mockViewportMode(viewport);
    setupMockChat({
      ...defaultChatState,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
      messages: [{ id: "message-alpha", sessionId: activeSessionFixture.id, role: "assistant", content: "Réponse Alpha", createdAt: "2026-09-10T00:00:00.000Z" }],
    });
    setupMockRooms();
    const view = await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{}} floating={floating} compactLayout={compactLayout} />);
    expect(view.container.querySelector('[data-alpha-ui="button"]')).not.toBeNull();
    expect(view.container.querySelector('[data-alpha-ui="input"]')).not.toBeNull();
    expect(screen.getByTestId(`chat-session-${activeSessionFixture.id}`)).toBeInTheDocument();
    restoreViewport();
  });

  it.each(["quick-chat", "popped-out", "right-dock", "right-dock-expanded"] as const)(
    "mounts the real %s host and opens its homemade Alpha conversation menu",
    async (host) => {
      setupMockChat({
        ...defaultChatState,
        sessions: [activeSessionFixture],
        filteredSessions: [activeSessionFixture],
        activeSession: activeSessionFixture,
      });
      setupMockRooms();
      localStorage.clear();

      if (host === "quick-chat") {
        await renderWithAct(
          <QuickChatWindow
            projectId="project-alpha"
            hidden={false}
            closeOnOutsidePointerDown={false}
            addToast={vi.fn()}
            experimentalFeatures={{}}
            onClose={vi.fn()}
          />,
        );
      } else if (host === "popped-out") {
        await renderWithAct(
          <PoppedOutChatWindows
            entries={[{ projectId: "project-alpha", session: activeSessionFixture, focusNonce: 1, cascadeSlot: 0, minimized: false }]}
            projectId="project-alpha"
            addToast={vi.fn()}
            experimentalFeatures={{}}
            onClose={vi.fn()}
            onOpenSessionInNewWindow={vi.fn()}
          />,
        );
      } else {
        const chatEntry = STATIC_OVERFLOW_VIEW_ENTRIES.find((entry) => entry.key === "chat");
        await renderWithAct(<>{chatEntry?.render?.({
          projectId: "project-alpha",
          addToast: vi.fn(),
          experimentalFeatures: {},
          surface: host === "right-dock" ? "dock" : "expand",
          dockWidth: host === "right-dock" ? 480 : undefined,
        })}</>);
      }

      if (host === "popped-out") {
        expect(screen.queryByTestId(`chat-session-${activeSessionFixture.id}`)).toBeNull();
        expect(document.querySelector(".chat-sidebar")).toBeNull();
        expect(screen.queryByTestId("chat-back-btn")).toBeNull();
        expect(screen.queryByTestId("chat-new-btn")).toBeNull();
        expect(screen.queryByTestId("chat-thread-title-switcher")).toBeNull();
        expect(screen.getByTestId("chat-modal-close")).toBeInTheDocument();
        return;
      }
      expect(await screen.findByTestId(`chat-session-${activeSessionFixture.id}`)).toBeInTheDocument();
      expect(document.querySelector('[data-alpha-ui="button"]')).not.toBeNull();
      if (host === "quick-chat") {
        const floatingChat = document.querySelector(".floating-window--chat .chat-view--floating");
        expect(floatingChat?.children[0]).toHaveClass("view-header");
        expect(floatingChat?.children[1]).toHaveClass("chat-view__body");
        expect(floatingChat?.querySelectorAll('[data-testid="chat-modal-close"]')).toHaveLength(1);
        expect(floatingChat?.querySelector('[data-testid="chat-modal-close"]')).toHaveClass("modal-close");
        expect(document.querySelector(".floating-window--chat .floating-window__close")).toBeNull();
      }
      fireEvent.click(screen.getByTestId("chat-session-menu-btn"));
      expect(await screen.findByRole("menu", { name: "Conversation actions" })).toHaveAttribute("data-alpha-ui", "menu");
      fireEvent.click(screen.getByTestId("chat-context-rename"));
      expect(await screen.findByRole("dialog", { name: "Rename Conversation" })).toHaveAttribute("data-alpha-ui", "dialog");
      expect(document.querySelectorAll('[data-alpha-ui="dialog"]')).toHaveLength(1);
    },
  );

  it.each([
    ["quick-chat", "desktop", "empty"],
    ["quick-chat", "desktop", "populated"],
    ["quick-chat", "desktop", "streaming"],
    ["quick-chat", "mobile", "empty"],
    ["quick-chat", "mobile", "populated"],
    ["quick-chat", "mobile", "streaming"],
    ["popped-out", "desktop", "empty"],
    ["popped-out", "desktop", "populated"],
    ["popped-out", "desktop", "streaming"],
    ["popped-out", "mobile", "empty"],
    ["popped-out", "mobile", "populated"],
    ["popped-out", "mobile", "streaming"],
  ] as const)("keeps the real %s History-style shell in %s for %s content", async (host, viewport, state) => {
    const restoreViewport = mockViewportMode(viewport);
    const populated = state !== "empty";
    const dedicated = host === "popped-out";
    setupMockChat({
      ...defaultChatState,
      sessions: populated || dedicated ? [activeSessionFixture] : [],
      filteredSessions: populated || dedicated ? [activeSessionFixture] : [],
      activeSession: populated || dedicated ? activeSessionFixture : null,
      isStreaming: state === "streaming",
      streamingText: state === "streaming" ? "Réponse en cours" : "",
    });
    setupMockRooms();
    localStorage.clear();

    try {
      if (host === "quick-chat") {
        await renderWithAct(
          <QuickChatWindow
            projectId="project-alpha"
            hidden={false}
            closeOnOutsidePointerDown={false}
            addToast={vi.fn()}
            experimentalFeatures={{}}
            onClose={vi.fn()}
          />,
        );
      } else {
        await renderWithAct(
          <PoppedOutChatWindows
            entries={[{ projectId: "project-alpha", session: activeSessionFixture, focusNonce: 1, cascadeSlot: 0, minimized: false }]}
            projectId="project-alpha"
            addToast={vi.fn()}
            experimentalFeatures={{}}
            onClose={vi.fn()}
            onOpenSessionInNewWindow={vi.fn()}
          />,
        );
      }

      const floatingChat = document.querySelector<HTMLElement>(".floating-window--chat .chat-view--floating");
      expect(floatingChat).not.toBeNull();
      expect(floatingChat?.children[0]).toHaveClass("view-header");
      expect(floatingChat?.children[1]).toHaveClass("chat-view__body");
      expect(floatingChat?.querySelectorAll('[data-testid="chat-modal-close"]')).toHaveLength(1);
      expect(document.querySelector(".floating-window--chat .floating-window__close")).toBeNull();
      if (viewport === "mobile") {
        expect(window.innerWidth).toBe(375);
        expect(floatingChat).toHaveClass("chat-view--floating");
      }
      if (dedicated) {
        expect(document.querySelector(".chat-sidebar")).toBeNull();
        expect(screen.queryByTestId(`chat-session-${activeSessionFixture.id}`)).toBeNull();
        expect(document.querySelector(".chat-thread")).toBeInTheDocument();
      } else if (!populated) {
        expect(screen.getByText("No conversations yet")).toBeInTheDocument();
      } else {
        expect(screen.getByTestId(`chat-session-${activeSessionFixture.id}`)).toBeInTheDocument();
      }
      if (state === "streaming") {
        if (!dedicated) await openFirstConversation();
        expect(await screen.findByTestId("chat-message-__streaming__")).toHaveTextContent("Réponse en cours");
      }
    } finally {
      restoreViewport();
    }
  });

  it.each([
    ["quick-chat", "desktop"],
    ["quick-chat", "mobile"],
    ["popped-out", "desktop"],
    ["popped-out", "mobile"],
  ] as const)("keeps the real %s mounted with stable geometry while hidden on %s", async (host, viewport) => {
    const restoreViewport = mockViewportMode(viewport);
    setupMockChat({
      ...defaultChatState,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
      isStreaming: true,
      streamingText: "Réponse persistante",
    });
    setupMockRooms();
    localStorage.clear();
    const onClose = vi.fn();

    const view = host === "quick-chat"
      ? await renderWithAct(
        <QuickChatWindow
          projectId="project-alpha"
          hidden={false}
          closeOnOutsidePointerDown={false}
          addToast={vi.fn()}
          experimentalFeatures={{}}
          onClose={onClose}
        />,
      )
      : await renderWithAct(
        <PoppedOutChatWindows
          entries={[{ projectId: "project-alpha", session: activeSessionFixture, focusNonce: 3, cascadeSlot: 1, minimized: false }]}
          projectId="project-alpha"
          addToast={vi.fn()}
          experimentalFeatures={{}}
          onClose={vi.fn()}
          onOpenSessionInNewWindow={vi.fn()}
        />,
      );
    const windowKey = host === "quick-chat" ? "chat-modal" : `chat-window-project-alpha-${activeSessionFixture.id}`;
    const overlay = screen.getByTestId(`floating-window-overlay-${windowKey}`);
    const panel = screen.getByTestId(`floating-window-${windowKey}`);
    const chat = panel.querySelector(".chat-view--floating");
    const geometry = { left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height };

    if (host === "quick-chat") {
      view.rerender(
        <QuickChatWindow
          projectId="project-alpha"
          hidden
          closeOnOutsidePointerDown={false}
          addToast={vi.fn()}
          experimentalFeatures={{}}
          onClose={onClose}
        />,
      );
    } else {
      view.rerender(
        <PoppedOutChatWindows
          entries={[{ projectId: "project-alpha", session: activeSessionFixture, focusNonce: 3, cascadeSlot: 1, minimized: true }]}
          projectId="project-alpha"
          addToast={vi.fn()}
          experimentalFeatures={{}}
          onClose={vi.fn()}
          onOpenSessionInNewWindow={vi.fn()}
        />,
      );
    }

    expect(screen.getByTestId(`floating-window-overlay-${windowKey}`)).toBe(overlay);
    expect(screen.getByTestId(`floating-window-${windowKey}`)).toBe(panel);
    expect(panel.querySelector(".chat-view--floating")).toBe(chat);
    expect(overlay).toHaveClass("floating-window-overlay--hidden");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect({ left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height }).toEqual(geometry);
    expect(chat?.querySelectorAll('[data-testid="chat-modal-close"]')).toHaveLength(1);

    if (host === "quick-chat") {
      view.rerender(
        <QuickChatWindow
          projectId="project-alpha"
          hidden={false}
          closeOnOutsidePointerDown={false}
          addToast={vi.fn()}
          experimentalFeatures={{}}
          onClose={onClose}
        />,
      );
    } else {
      view.rerender(
        <PoppedOutChatWindows
          entries={[{ projectId: "project-alpha", session: activeSessionFixture, focusNonce: 3, cascadeSlot: 1, minimized: false }]}
          projectId="project-alpha"
          addToast={vi.fn()}
          experimentalFeatures={{}}
          onClose={vi.fn()}
          onOpenSessionInNewWindow={vi.fn()}
        />,
      );
    }
    expect(screen.getByTestId(`floating-window-overlay-${windowKey}`)).toBe(overlay);
    expect(screen.getByTestId(`floating-window-${windowKey}`)).toBe(panel);
    expect(panel.querySelector(".chat-view--floating")).toBe(chat);
    expect(overlay).not.toHaveClass("floating-window-overlay--hidden");
    expect({ left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height }).toEqual(geometry);
    restoreViewport();
  });

  it("pins the floating Chat header and History-matched content paint by contract", () => {
    const chatCss = readAppFile("components/ChatView.css");
    const headerCss = readAppFile("components/ViewHeader.css");
    expect(chatCss).toMatch(/\.chat-view\s*\{[^}]*overflow:\s*hidden;/s);
    expect(chatCss).toMatch(/\.chat-view--floating \.chat-view__body\s*\{[^}]*background:\s*var\(--bg-primary\);/s);
    expect(headerCss).toMatch(/\.view-header\s*\{[^}]*flex-shrink:\s*0;/s);
  });

  it("navigates one sectioned Alpha conversation menu before labelled tag controls", async () => {
    const setSessionTags = vi.fn().mockResolvedValue(undefined);
    const taggedSession = { ...activeSessionFixture, tags: [] };
    setupMockChat({
      ...defaultChatState,
      sessions: [taggedSession],
      filteredSessions: [taggedSession],
      activeSession: taggedSession,
      tags: [{ id: "tag-alpha", name: "Important" }, { id: "tag-later", name: "Later" }],
      setSessionTags,
    } as never);
    setupMockRooms();
    await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("chat-session-menu-btn"));
    const conversationMenu = screen.getByRole("menu", { name: "Conversation actions" });
    const primaryRename = screen.getByTestId("chat-context-rename");
    const assignment = screen.getByTestId("chat-context-tag-tag-alpha");
    const laterAssignment = screen.getByTestId("chat-context-tag-tag-later");
    const archive = screen.getByTestId("chat-context-archive");
    const rename = screen.getByTestId("chat-context-rename-tag-tag-alpha");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(conversationMenu).toContainElement(primaryRename);
    expect(conversationMenu).toContainElement(assignment);
    expect(conversationMenu).toContainElement(archive);
    expect(assignment).not.toContainElement(rename);
    primaryRename.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(assignment).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(laterAssignment).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(archive).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(primaryRename).toHaveFocus();
    archive.focus();
    await userEvent.tab();
    expect(rename).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(archive).toHaveFocus();
    expect(rename.closest(".chat-tag-menu-item")).toHaveTextContent("Important");
    expect(conversationMenu.querySelector("button button")).toBeNull();
    fireEvent.click(assignment);
    expect(setSessionTags).toHaveBeenCalledWith(activeSessionFixture.id, ["tag-alpha"]);
    fireEvent.click(rename);
    expect(await screen.findByRole("dialog")).toHaveAttribute("data-alpha-ui", "dialog");
  });

  it("opens a production rename dialog as one homemade Alpha portal without a historical duplicate shell", async () => {
    setupMockChat({
      ...defaultChatState,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
    });
    setupMockRooms();
    await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId("chat-session-menu-btn"));
    fireEvent.click(screen.getByTestId("chat-context-rename"));

    expect(await screen.findByRole("dialog")).toHaveAttribute("data-alpha-ui", "dialog");
    expect(document.querySelectorAll('[data-alpha-ui="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-alpha-portal="true"]')).not.toBeNull();
  });

  it("keeps the empty and loading production ChatView states inside the Alpha boundary", async () => {
    setupMockChat({ ...defaultChatState, sessionsLoading: true });
    setupMockRooms();
    const view = await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{}} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(view.container.querySelector('[data-alpha-ui="input"]')).not.toBeNull();
  });

  it("keeps a mounted official composer active without losing its draft", () => {
    const view = render(<ChatFixture alpha={false} />);
    fireEvent.change(screen.getByLabelText("Composer"), { target: { value: "brouillon conservé" } });
    expect(view.container.querySelector('[data-alpha-ui="textarea"]')).not.toBeNull();

    view.rerender(<ChatFixture alpha />);
    expect(screen.getByLabelText("Composer")).toHaveValue("brouillon conservé");
    expect(screen.getByLabelText("Composer")).toHaveAttribute("data-alpha-ui", "textarea");
    expect(screen.getByRole("button", { name: /send/i })).toHaveAttribute("data-alpha-ui", "button");

    view.rerender(<ChatFixture alpha={false} />);
    expect(screen.getByLabelText("Composer")).toHaveValue("brouillon conservé");
    expect(view.container.querySelector('[data-alpha-ui="textarea"]')).not.toBeNull();
  });

  it("renders streaming text, thinking, and an errored tool state through the real Alpha chat tree", async () => {
    setupMockChat({
      ...defaultChatState,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
      isStreaming: true,
      streamingText: "Réponse en flux",
      streamingThinking: "Analyse en cours",
      streamingToolCalls: [{ toolName: "verification", status: "completed", isError: true, result: "échec contrôlé" }],
    });
    setupMockRooms();
    const view = await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{}} />);
    fireEvent.click(screen.getByTestId(`chat-session-${activeSessionFixture.id}`));

    expect(await screen.findByText("Réponse en flux")).toBeInTheDocument();
    expect(view.container.querySelector(".chat-tool-call--error")).not.toBeNull();
    expect(view.container.querySelector('[data-alpha-ui="button"]')).not.toBeNull();
  });
});

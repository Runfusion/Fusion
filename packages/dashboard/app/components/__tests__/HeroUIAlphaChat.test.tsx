import "../../hero-ui-alpha.css";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HeroUIAlphaProvider, HeroUIAlphaSurface } from "../../context/HeroUIAlphaContext";
import { AlphaTextArea } from "../hero-ui";
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
    <HeroUIAlphaProvider enabled={alpha}>
      <HeroUIAlphaSurface>
        <AlphaTextArea aria-label="Composer" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <StandardChatActionButton isStreaming={streaming} canSend={draft.trim().length > 0} onSend={vi.fn()} onStop={vi.fn()} showSendText />
      </HeroUIAlphaSurface>
    </HeroUIAlphaProvider>
  );
}

describe("HeroUI Alpha Chat", () => {
  it("scopes compact chat and composer density to Alpha at desktop and mobile", () => {
    const chatCss = readAppFile("components/ChatView.css");
    const composeCss = readAppFile("components/ComposeChatPanel.css");
    expect(chatCss).toContain('[data-heroui-alpha-surface="true"] .chat-session-item');
    expect(chatCss).toContain('[data-heroui-alpha-surface="true"] .chat-thread-header');
    expect(chatCss).toContain("min-block-size: var(--alpha-control-height)");
    expect(chatCss).toContain("min-block-size: var(--alpha-touch-height)");
    expect(composeCss).toContain('[data-heroui-alpha-surface="true"] .compose-chat-panel__actions > .btn');
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
      const view = await renderWithAct(<ChatView projectId="project-theme" addToast={vi.fn()} experimentalFeatures={{ alphaUpdates: true }} />);
      const chat = view.container.querySelector<HTMLElement>(".chat-view");
      const productionButton = view.container.querySelector<HTMLElement>('[data-heroui-alpha="button"]');
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
  ] as const)("renders the populated production ChatView in %s through HeroUI", async (_host, viewport, floating, compactLayout) => {
    const restoreViewport = mockViewportMode(viewport);
    setupMockChat({
      ...defaultChatState,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
      messages: [{ id: "message-alpha", sessionId: activeSessionFixture.id, role: "assistant", content: "Réponse Alpha", createdAt: "2026-09-10T00:00:00.000Z" }],
    });
    setupMockRooms();
    const view = await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{ alphaUpdates: true }} floating={floating} compactLayout={compactLayout} />);
    expect(view.container.querySelector('[data-heroui-alpha="button"]')).not.toBeNull();
    expect(view.container.querySelector('[data-heroui-alpha="input"]')).not.toBeNull();
    expect(screen.getByTestId(`chat-session-${activeSessionFixture.id}`)).toBeInTheDocument();
    restoreViewport();
  });

  it.each(["quick-chat", "popped-out", "right-dock", "right-dock-expanded"] as const)(
    "mounts the real %s host and opens its HeroUI conversation menu",
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
            experimentalFeatures={{ alphaUpdates: true }}
            onClose={vi.fn()}
          />,
        );
      } else if (host === "popped-out") {
        await renderWithAct(
          <PoppedOutChatWindows
            entries={[{ projectId: "project-alpha", session: activeSessionFixture, focusNonce: 1, cascadeSlot: 0, minimized: false }]}
            projectId="project-alpha"
            addToast={vi.fn()}
            experimentalFeatures={{ alphaUpdates: true }}
            onClose={vi.fn()}
            onOpenSessionInNewWindow={vi.fn()}
          />,
        );
      } else {
        const chatEntry = STATIC_OVERFLOW_VIEW_ENTRIES.find((entry) => entry.key === "chat");
        await renderWithAct(<>{chatEntry?.render?.({
          projectId: "project-alpha",
          addToast: vi.fn(),
          experimentalFeatures: { alphaUpdates: true },
          surface: host === "right-dock" ? "dock" : "expand",
          dockWidth: host === "right-dock" ? 480 : undefined,
        })}</>);
      }

      expect(await screen.findByTestId(`chat-session-${activeSessionFixture.id}`)).toBeInTheDocument();
      expect(document.querySelector('[data-heroui-alpha="button"]')).not.toBeNull();
      fireEvent.click(screen.getByTestId("chat-session-menu-btn"));
      expect(await screen.findByRole("menu", { name: "Conversation actions" })).toHaveAttribute("data-heroui-alpha", "menu");
      fireEvent.click(screen.getByTestId("chat-context-rename"));
      expect(await screen.findByRole("dialog")).toHaveAttribute("data-heroui-alpha", "dialog");
      expect(document.querySelectorAll('[data-heroui-alpha="dialog"]')).toHaveLength(1);
    },
  );

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
    await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{ alphaUpdates: true }} />);
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
    expect(await screen.findByRole("dialog")).toHaveAttribute("data-heroui-alpha", "dialog");
  });

  it("opens a production rename dialog as one HeroUI portal without a historical duplicate shell", async () => {
    setupMockChat({
      ...defaultChatState,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
    });
    setupMockRooms();
    await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{ alphaUpdates: true }} />);
    fireEvent.click(screen.getByTestId("chat-session-menu-btn"));
    fireEvent.click(screen.getByTestId("chat-context-rename"));

    expect(await screen.findByRole("dialog")).toHaveAttribute("data-heroui-alpha", "dialog");
    expect(document.querySelectorAll('[data-heroui-alpha="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-heroui-alpha-portal="true"]')).not.toBeNull();
  });

  it("keeps the empty and loading production ChatView states inside the Alpha boundary", async () => {
    setupMockChat({ ...defaultChatState, sessionsLoading: true });
    setupMockRooms();
    const view = await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{ alphaUpdates: true }} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(view.container.querySelector('[data-heroui-alpha="input"]')).not.toBeNull();
  });

  it("switches a mounted composer ON and OFF without losing its draft", () => {
    const view = render(<ChatFixture alpha={false} />);
    fireEvent.change(screen.getByLabelText("Composer"), { target: { value: "brouillon conservé" } });
    expect(view.container.querySelector("[data-heroui-alpha]")).toBeNull();

    view.rerender(<ChatFixture alpha />);
    expect(screen.getByLabelText("Composer")).toHaveValue("brouillon conservé");
    expect(screen.getByLabelText("Composer")).toHaveAttribute("data-heroui-alpha", "textarea");
    expect(screen.getByRole("button", { name: /send/i })).toHaveAttribute("data-heroui-alpha", "button");

    view.rerender(<ChatFixture alpha={false} />);
    expect(screen.getByLabelText("Composer")).toHaveValue("brouillon conservé");
    expect(view.container.querySelector("[data-heroui-alpha]")).toBeNull();
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
    const view = await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{ alphaUpdates: true }} />);
    fireEvent.click(screen.getByTestId(`chat-session-${activeSessionFixture.id}`));

    expect(await screen.findByText("Réponse en flux")).toBeInTheDocument();
    expect(view.container.querySelector(".chat-tool-call--error")).not.toBeNull();
    expect(view.container.querySelector('[data-heroui-alpha="button"]')).not.toBeNull();
  });
});

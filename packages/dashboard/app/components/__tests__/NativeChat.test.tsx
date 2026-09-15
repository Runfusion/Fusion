import "../../native-ui.css";
import "../../ui-style-tokens.css";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UiTextArea } from "../ui";
import { StandardChatActionButton } from "../StandardChatSurface";
import { ChatView } from "../ChatView";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";
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
    <>
      <>
        <UiTextArea aria-label="Composer" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <StandardChatActionButton isStreaming={streaming} canSend={draft.trim().length > 0} onSend={vi.fn()} onStop={vi.fn()} showSendText />
      </>
    </>
  );
}

describe("homemade Alpha Chat", () => {
  it("scopes compact chat and composer density to Alpha at desktop and mobile", () => {
    const chatCss = readAppFile("components/ChatView.css");
    const composeCss = readAppFile("components/ComposeChatPanel.css");
    expect(chatCss).toContain('.chat-session-item');
    expect(chatCss).toContain('.chat-thread-header');
    expect(chatCss).toContain("min-block-size: var(--ui-control-height)");
    expect(chatCss).toContain("min-block-size: var(--ui-touch-height)");
    expect(composeCss).toContain('.compose-chat-panel__actions > .btn');
    expect(composeCss).toContain("flex: 0 1 auto");
  });

  /*
  FNXC:NativeUiPresentation 2026-09-15-00:20:
  The focus ring is now composed from the interface-style GEOMETRY token and the theme's own accent colour,
  so its shape is style-owned and its colour is theme-owned. JSDOM cannot compose the theme stylesheets, so
  this case asserts that split structurally and the visual proof lives in the browser lane.
  */
  it("composes its focus ring from style geometry and theme colour, and keeps focus on a real control", () => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.colorTheme = "cozy-cartoon";
    render(<ChatFixture alpha streaming />);

    const stopButton = screen.getByRole("button", { name: "Stop generation" });
    stopButton.focus();
    expect(stopButton).toHaveFocus();

    // A theme or mode change never disturbs focus ownership on a live control.
    document.documentElement.dataset.colorTheme = "shadcn-purple";
    expect(stopButton).toHaveFocus();
    document.documentElement.dataset.theme = "dark";
    expect(stopButton).toHaveFocus();

    const stylesCss = readAppFile("styles.css");
    expect(stylesCss).toContain("--focus-ring: var(--ui-focus-ring-geometry)");
    expect(stylesCss).toContain("--focus-ring-strong: var(--ui-focus-ring-geometry)");
  });

  /*
  FNXC:NativeUiPresentation 2026-09-15-00:20:
  This case used to assert Chat's semantic colours were IDENTICAL across Fusion colour themes — the defect
  FN-399 fixes, because the boundary pinned a fixed palette. The invariant is inverted: no Chat stylesheet
  pins a semantic colour of its own, so the selected theme reaches the transcript, composer and menus; the
  computed comparison across themes runs in the browser lane.
  */
  it("pins no semantic colour of its own so the selected theme reaches Chat", async () => {
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
      const productionButton = view.container.querySelector<HTMLElement>('[data-ui="button"]');
      expect(chat).not.toBeNull();
      expect(productionButton).not.toBeNull();
      const chatCss = readAppFile("components/ChatView.css").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(chatCss).not.toContain("--alpha-neutral-");
      for (const token of ["--color-info", "--color-warning", "--color-error", "--color-success", "--todo", "--bg", "--surface", "--text", "--accent"]) {
        expect(chatCss).not.toContain(`${token}:`);
      }

      // A theme change leaves the mounted tree and its native markers intact.
      document.documentElement.dataset.colorTheme = "shadcn-purple";
      expect(chat).toBeInTheDocument();
      expect(productionButton).toHaveAttribute("data-ui", "button");
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
    expect(view.container.querySelector('[data-ui="button"]')).not.toBeNull();
    expect(view.container.querySelector('[data-ui="input"]')).not.toBeNull();
    expect(screen.getByTestId(`chat-session-${activeSessionFixture.id}`)).toBeInTheDocument();
    restoreViewport();
  });

  it.each(["popped-out", "right-dock-expanded"] as const)(
    "mounts the real %s host through homemade Alpha",
    async (host) => {
      setupMockChat({
        ...defaultChatState,
        sessions: [activeSessionFixture],
        filteredSessions: [activeSessionFixture],
        activeSession: activeSessionFixture,
      });
      setupMockRooms();
      localStorage.clear();

      if (host === "popped-out") {
        await renderWithAct(
          <PoppedOutChatWindows
            entries={[{ projectId: "project-alpha", session: activeSessionFixture, focusNonce: 1, cascadeSlot: 0 }]}
            projectId="project-alpha"
            addToast={vi.fn()}
            experimentalFeatures={{}}
            onClose={vi.fn()}
            onOpenSessionInNewWindow={vi.fn()}
          />,
        );
        expect(screen.queryByTestId(`chat-session-${activeSessionFixture.id}`)).toBeNull();
        expect(document.querySelector(".chat-sidebar")).toBeNull();
        expect(screen.queryByTestId("chat-new-btn")).toBeNull();
        expect(screen.getByTestId("chat-modal-close")).toBeInTheDocument();
        return;
      }

      const chatEntry = STATIC_OVERFLOW_VIEW_ENTRIES.find((entry) => entry.key === "chat");
      await renderWithAct(<>{chatEntry?.render?.({
        projectId: "project-alpha",
        addToast: vi.fn(),
        experimentalFeatures: {},
        surface: "expand",
      })}</>);
      expect(await screen.findByTestId(`chat-session-${activeSessionFixture.id}`)).toBeInTheDocument();
      expect(document.querySelector('[data-ui="button"]')).not.toBeNull();
      fireEvent.click(screen.getByTestId("chat-session-menu-btn"));
      expect(await screen.findByRole("menu", { name: "Conversation actions" })).toHaveAttribute("data-ui", "menu");
      fireEvent.click(screen.getByTestId("chat-context-rename"));
      expect(await screen.findByRole("dialog", { name: "Rename Conversation" })).toHaveAttribute("data-ui", "dialog");
      expect(document.querySelectorAll('[data-ui="dialog"]')).toHaveLength(1);
    },
  );

  it.each([
    ["desktop", "populated"],
    ["desktop", "streaming"],
    ["mobile", "populated"],
    ["mobile", "streaming"],
  ] as const)("keeps a detached conversation in its real %s shell for %s content", async (viewport, state) => {
    const restoreViewport = mockViewportMode(viewport);
    setupMockChat({
      ...defaultChatState,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
      isStreaming: state === "streaming",
      streamingText: state === "streaming" ? "Réponse en cours" : "",
    });
    setupMockRooms();
    try {
      await renderWithAct(
        <PoppedOutChatWindows
          entries={[{ projectId: "project-alpha", session: activeSessionFixture, focusNonce: 1, cascadeSlot: 0 }]}
          projectId="project-alpha"
          addToast={vi.fn()}
          experimentalFeatures={{}}
          onClose={vi.fn()}
          onOpenSessionInNewWindow={vi.fn()}
        />,
      );
      const floatingChat = document.querySelector<HTMLElement>(".floating-window--chat .chat-view--floating");
      expect(floatingChat).not.toBeNull();
      expect(document.querySelector(".chat-sidebar")).toBeNull();
      expect(document.querySelector(".chat-thread")).toBeInTheDocument();
      if (state === "streaming") {
        expect(await screen.findByTestId("chat-message-__streaming__")).toHaveTextContent("Réponse en cours");
      }
    } finally {
      restoreViewport();
    }
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
    expect(await screen.findByRole("dialog")).toHaveAttribute("data-ui", "dialog");
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

    expect(await screen.findByRole("dialog")).toHaveAttribute("data-ui", "dialog");
    expect(document.querySelectorAll('[data-ui="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-ui-portal="true"]')).not.toBeNull();
  });

  it("keeps the empty and loading production ChatView states inside the Alpha boundary", async () => {
    setupMockChat({ ...defaultChatState, sessionsLoading: true });
    setupMockRooms();
    const view = await renderWithAct(<ChatView projectId="project-alpha" addToast={vi.fn()} experimentalFeatures={{}} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(view.container.querySelector('[data-ui="input"]')).not.toBeNull();
  });

  it("keeps a mounted official composer active without losing its draft", () => {
    const view = render(<ChatFixture alpha={false} />);
    fireEvent.change(screen.getByLabelText("Composer"), { target: { value: "brouillon conservé" } });
    expect(view.container.querySelector('[data-ui="textarea"]')).not.toBeNull();

    view.rerender(<ChatFixture alpha />);
    expect(screen.getByLabelText("Composer")).toHaveValue("brouillon conservé");
    expect(screen.getByLabelText("Composer")).toHaveAttribute("data-ui", "textarea");
    expect(screen.getByRole("button", { name: /send/i })).toHaveAttribute("data-ui", "button");

    view.rerender(<ChatFixture alpha={false} />);
    expect(screen.getByLabelText("Composer")).toHaveValue("brouillon conservé");
    expect(view.container.querySelector('[data-ui="textarea"]')).not.toBeNull();
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
    expect(view.container.querySelector('[data-ui="button"]')).not.toBeNull();
  });
});

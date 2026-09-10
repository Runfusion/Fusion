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

function ChatFixture({ alpha }: { alpha: boolean }) {
  const [draft, setDraft] = useState("bonjour");
  return (
    <HeroUIAlphaProvider enabled={alpha}>
      <HeroUIAlphaSurface>
        <AlphaTextArea aria-label="Composer" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <StandardChatActionButton isStreaming={false} canSend={draft.trim().length > 0} onSend={vi.fn()} showSendText />
      </HeroUIAlphaSurface>
    </HeroUIAlphaProvider>
  );
}

describe("HeroUI Alpha Chat", () => {
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

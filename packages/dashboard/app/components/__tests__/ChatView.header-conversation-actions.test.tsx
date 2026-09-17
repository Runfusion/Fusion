import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { ChatView } from "../ChatView";
import {
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

/*
FNXC:ChatNavigation 2026-09-17-10:37:
FN-506 : dans une conversation ouverte, l'en-tête doit porter les actions rapides DE CETTE conversation
(« … ») et non un « + » de création. L'invariant couvert ici : l'affordance d'en-tête dépend de l'état de
l'hôte (liste vs conversation résolue), le menu ouvert est le menu de conversation EXISTANT, la création
survit à l'intérieur de ce menu, et aucune coquille de bouton ne subsiste. Recensé sur tous les hôtes réels
de ChatView : desktop avec rail docké, état liste, flottant, dock `listOnly`, fenêtre dédiée et téléphone.
*/

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
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

const session = {
  id: "session-001",
  agentId: "agent-001",
  status: "active" as const,
  title: "Architecture discussion",
  lastMessagePreview: "The latest conversation message",
  modelProvider: "anthropic",
  modelId: "claude-sonnet-4-5",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
};

async function renderChat(props: Partial<React.ComponentProps<typeof ChatView>> = {}, chatOverrides = {}) {
  setupMockChat({ activeSession: session, sessions: [session], filteredSessions: [session], ...chatOverrides });
  return renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} {...props} />);
}

async function openConversationRow() {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`chat-session-${session.id}`));
  });
}

/** Aucun bouton d'en-tête ne doit rester sans nom accessible après le retrait du « + ». */
function expectNoEmptyHeaderButtons() {
  const banner = screen.getByRole("banner");
  for (const button of within(banner).getAllByRole("button")) {
    const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
    expect(name.length).toBeGreaterThan(0);
  }
}

describe("ChatView header conversation actions (FN-506)", () => {
  // Cas (a) : desktop avec rail docké, conversation ouverte.
  it("replaces New Chat with a conversation actions menu once a conversation is open", async () => {
    const view = await renderChat();
    await openConversationRow();

    const banner = screen.getByRole("banner");
    expect(within(banner).queryByTestId("chat-new-btn")).toBeNull();
    const trigger = within(banner).getByTestId("chat-header-actions-btn");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.getAttribute("aria-label")).toContain("Architecture discussion");
    expectNoEmptyHeaderButtons();

    await act(async () => { fireEvent.click(trigger); });

    expect(screen.getByTestId("chat-context-new-chat")).toBeInTheDocument();
    expect(screen.getByTestId("chat-context-rename")).toBeInTheDocument();
    expect(screen.getByTestId("chat-context-pin")).toBeInTheDocument();
    expect(screen.getByTestId("chat-context-delete")).toBeInTheDocument();
    expect(screen.getByTestId("chat-context-copy-id")).toBeInTheDocument();
    // Un seul rendu de menu : l'en-tête réutilise `.chat-session-context-menu`.
    expect(document.querySelectorAll(".chat-session-context-menu")).toHaveLength(1);
    expect(within(banner).getByTestId("chat-header-actions-btn")).toHaveAttribute("aria-expanded", "true");

    // Le déclencheur est une bascule : un second clic referme.
    await act(async () => { fireEvent.click(within(banner).getByTestId("chat-header-actions-btn")); });
    expect(document.querySelector(".chat-session-context-menu")).toBeNull();

    view.unmount();
  });

  // Cas (b) : l'état liste garde strictement le « + ».
  it("keeps New Chat in the list state", async () => {
    const view = await renderChat({}, { activeSession: null, sessions: [session], filteredSessions: [session] });

    const banner = screen.getByRole("banner");
    expect(within(banner).getByTestId("chat-new-btn")).toBeInTheDocument();
    expect(within(banner).queryByTestId("chat-header-actions-btn")).toBeNull();

    view.unmount();
  });

  // Cas (c) : l'hôte flottant suit la même règle.
  it("applies the same rule in the floating host", async () => {
    const view = await renderChat({ floating: true, persistChatPreferences: false });
    await openConversationRow();

    const banner = screen.getByRole("banner");
    expect(within(banner).queryByTestId("chat-new-btn")).toBeNull();
    expect(within(banner).getByTestId("chat-header-actions-btn")).toBeInTheDocument();

    view.unmount();
  });

  // Cas (d) : contrôle négatif — le dock est propriétaire de liste, il garde toujours le « + ».
  it("keeps New Chat permanently in a listOnly dock host", async () => {
    const view = await renderChat({ listOnly: true });
    await openConversationRow();

    const banner = screen.getByRole("banner");
    expect(within(banner).getByTestId("chat-new-btn")).toBeInTheDocument();
    expect(within(banner).queryByTestId("chat-header-actions-btn")).toBeNull();

    view.unmount();
  });

  // Cas (e) : exemption documentée — la fenêtre dédiée ne rend NI « + » NI « … ».
  it("renders neither affordance in a dedicated conversation window", async () => {
    setupMockChat({ activeSession: session, sessions: [session], filteredSessions: [session] });
    const view = await renderWithAct(
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        floating
        dedicatedConversation
        initialDirectSession={session}
        persistChatPreferences={false}
      />,
    );

    expect(screen.queryByTestId("chat-new-btn")).toBeNull();
    expect(screen.queryByTestId("chat-header-actions-btn")).toBeNull();

    view.unmount();
  });

  // Cas (f) : téléphone — « + » en liste, « … » après ouverture, retour conservé.
  it("swaps the affordance on the phone breakpoint and keeps Back", async () => {
    const restore = mockViewportMode("mobile");
    try {
      const listView = await renderChat({}, { activeSession: null, sessions: [session], filteredSessions: [session] });
      expect(within(screen.getByRole("banner")).getByTestId("chat-new-btn")).toBeInTheDocument();
      listView.unmount();

      const view = await renderChat();
      await openConversationRow();

      const banner = screen.getByRole("banner");
      expect(within(banner).queryByTestId("chat-new-btn")).toBeNull();
      expect(within(banner).getByTestId("chat-header-actions-btn")).toBeInTheDocument();
      expect(within(banner).getByTestId("chat-back-btn")).toBeInTheDocument();
      expectNoEmptyHeaderButtons();

      view.unmount();
    } finally {
      restore();
    }
  });

  // Cas (g) : état détail sans session résolue — repli sur « + », jamais un « … » sans cible.
  it("falls back to New Chat when the detail pane has no resolved session", async () => {
    const view = await renderChat({}, { activeSession: null, sessions: [session], filteredSessions: [session] });
    await openConversationRow();

    const banner = screen.getByRole("banner");
    expect(within(banner).queryByTestId("chat-header-actions-btn")).toBeNull();
    expect(within(banner).getByTestId("chat-new-btn")).toBeInTheDocument();

    view.unmount();
  });

  // La création reste atteignable : l'entrée de menu ouvre une nouvelle conversation.
  it("creates a conversation from the header menu entry", async () => {
    const view = await renderChat();
    await openConversationRow();

    await act(async () => { fireEvent.click(screen.getByTestId("chat-header-actions-btn")); });
    await act(async () => { fireEvent.click(screen.getByTestId("chat-context-new-chat")); });

    expect(document.querySelector(".chat-session-context-menu")).toBeNull();
    view.unmount();
  });

  // Le menu ouvert depuis une LIGNE est inchangé : aucune entrée de création.
  it("does not add New Chat to the row context menu", async () => {
    const view = await renderChat();

    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId(`chat-session-${session.id}`));
    });

    expect(screen.getByTestId("chat-context-rename")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-context-new-chat")).toBeNull();

    view.unmount();
  });
});

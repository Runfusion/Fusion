import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import * as apiModule from "../../api";
import * as viewportModule from "../../hooks/useViewportMode";
import * as mobileKeyboardModule from "../../hooks/useMobileKeyboard";
import type { Agent } from "../../api";
import type { Message } from "@fusion/core";

/*
FNXC:Navigation 2026-09-17-10:37:
FN-506 : le compteur de non-lus est une information de la BOÎTE DE RÉCEPTION. Il était rendu sur la seule
condition `unreadCount > 0`, donc il restait visible dans l'en-tête pendant que l'onglet Outbox était actif —
un chiffre que l'opérateur ne peut pas traiter depuis là. Les deux hôtes Mailbox (destination plein écran et
fenêtre flottante) sont deux implémentations complètes du même en-tête, donc l'invariant est prouvé sur les
deux : badge présent sur Inbox (toutes portées comprises), absent sur Outbox, absent quand le composeur
occupe l'en-tête.
*/

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(),
  fetchOutbox: vi.fn(),
  fetchUnreadCount: vi.fn(),
  fetchAgentMailbox: vi.fn(),
  fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(),
  markAllMessagesRead: vi.fn(),
  deleteMessage: vi.fn(),
  fetchConversation: vi.fn(),
  fetchMessage: vi.fn(),
  sendMessage: vi.fn(),
  fetchAgents: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchApprovalDetail: vi.fn(),
  decideApproval: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(),
  artifactMediaUrl: vi.fn(),
  fetchNativeStructurePreview: vi.fn(),
}));

vi.mock("../../hooks/useViewportMode", () => {
  const useViewportMode = vi.fn();
  return {
    isFullScreenSheetViewport: () => false,
    isShortViewport: () => false,
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    getViewportMode: () => useViewportMode(),
    isMobileViewport: () => useViewportMode() === "mobile",
    isTabletTouchViewport: (mode?: string) => mode === "tablet",
    useViewportMode,
  };
});

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: vi.fn(),
}));

vi.mock("../Header", () => ({
  useViewportMode: vi.fn(() => "desktop"),
}));

vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));

vi.mock("../../hooks/useTaskRecommendations", () => ({
  useTaskRecommendations: () => ({
    items: [], loading: false, loadingMore: false, error: null, hasMore: false,
    truncated: false, createStates: new Map(), createTask: vi.fn(), loadMore: vi.fn(), refresh: vi.fn(),
  }),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

const mockFetchInbox = vi.mocked(apiModule.fetchInbox);
const mockFetchOutbox = vi.mocked(apiModule.fetchOutbox);
const mockFetchUnreadCount = vi.mocked(apiModule.fetchUnreadCount);
const mockFetchAllAgentMailbox = vi.mocked(apiModule.fetchAllAgentMailbox);
const mockFetchAgents = vi.mocked(apiModule.fetchAgents);
const mockFetchApprovals = vi.mocked(apiModule.fetchApprovals);
const mockMarkMessageRead = vi.mocked(apiModule.markMessageRead);
const mockFetchConversation = vi.mocked(apiModule.fetchConversation);
const mockFetchMessage = vi.mocked(apiModule.fetchMessage);
const mockUseViewportMode = vi.mocked(viewportModule.useViewportMode);
const mockUseMobileKeyboard = vi.mocked(mobileKeyboardModule.useMobileKeyboard);

const mockAgents: Agent[] = [
  {
    id: "agent-001",
    name: "Test Agent 1",
    role: "executor",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

const unreadMessage: Message = {
  id: "msg-001",
  fromId: "agent-001",
  fromType: "agent",
  toId: "dashboard",
  toType: "user",
  content: "Unread inbox message.",
  type: "agent-to-user",
  read: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function openOutboxTab() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));
  });
}

async function openInboxTab() {
  await act(async () => {
    fireEvent.click(screen.getByTestId("mailbox-tab-inbox"));
  });
}

async function selectInboxScope(scope: string) {
  await act(async () => {
    fireEvent.click(screen.getByTestId("mailbox-inbox-filter"));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId(`mailbox-inbox-filter-option-${scope}`));
  });
}

/*
Le bouton Compose vit sur l'onglet Outbox (FNXC:MailboxTwoTabs), donc le seul moyen d'ouvrir le composeur
SANS quitter l'onglet Inbox est la réponse à un message reçu — exactement le chemin où la garde
`!showComposer` du badge est observable.
*/
async function openComposerFromInboxReply() {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`mailbox-item-${unreadMessage.id}`));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("mailbox-reply"));
  });
}

describe("Mailbox unread badge scope (FN-506)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    mockUseViewportMode.mockReturnValue("desktop");
    mockUseMobileKeyboard.mockReturnValue({
      keyboardOverlap: 0,
      viewportHeight: null,
      viewportOffsetTop: 0,
      keyboardOpen: false,
    });
    mockFetchInbox.mockResolvedValue({ messages: [unreadMessage], total: 1, unreadCount: 3 });
    mockFetchOutbox.mockResolvedValue({ messages: [], total: 0 });
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 3 });
    mockFetchAllAgentMailbox.mockResolvedValue({ messages: [], total: 0 });
    mockFetchAgents.mockResolvedValue(mockAgents);
    mockFetchApprovals.mockResolvedValue({ requests: [], total: 0, pendingCount: 0 });
    mockMarkMessageRead.mockResolvedValue({ ...unreadMessage, read: true });
    mockFetchConversation.mockResolvedValue([unreadMessage]);
    mockFetchMessage.mockResolvedValue(unreadMessage);
  });

  const hosts = [
    {
      name: "MailboxView",
      mount: () => render(
        <MailboxView addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />,
      ),
    },
    {
      name: "MailboxModal",
      mount: () => render(
        <MailboxModal
          isOpen
          onClose={vi.fn()}
          addToast={vi.fn()}
          onOpenNativeStructure={vi.fn()}
          nativeStructureCandidates={[]}
          agents={mockAgents}
        />,
      ),
    },
  ] as const;

  for (const host of hosts) {
    // Cas (a)/(c) : l'onglet Inbox garde le compteur.
    it(`${host.name} renders the unread badge while the Inbox tab is active`, async () => {
      host.mount();
      expect(await screen.findByTestId("mailbox-unread-badge")).toHaveTextContent("3");
    });

    // Cas (b)/(d) : la bascule sur Outbox retire le compteur du DOM, et le retour sur Inbox le restaure.
    it(`${host.name} removes the unread badge on the Outbox tab and restores it on Inbox`, async () => {
      host.mount();
      expect(await screen.findByTestId("mailbox-unread-badge")).toBeInTheDocument();

      await openOutboxTab();
      await waitFor(() => {
        expect(screen.queryByTestId("mailbox-unread-badge")).toBeNull();
      });

      await openInboxTab();
      expect(await screen.findByTestId("mailbox-unread-badge")).toBeInTheDocument();
    });

    // Cas (f) : le composeur porte l'identité de l'en-tête, le compteur est masqué.
    it(`${host.name} hides the unread badge while the composer owns the header`, async () => {
      host.mount();
      expect(await screen.findByTestId("mailbox-unread-badge")).toBeInTheDocument();

      await openComposerFromInboxReply();
      await waitFor(() => {
        expect(screen.queryByTestId("mailbox-unread-badge")).toBeNull();
      });
    });
  }

  // Cas (e) : les portées restent sous `activeTab === "inbox"`, le compteur ne bouge pas.
  it("keeps the unread badge on a non-All inbox scope", async () => {
    render(<MailboxView addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
    expect(await screen.findByTestId("mailbox-unread-badge")).toBeInTheDocument();

    await selectInboxScope("archived");

    expect(screen.getByTestId("mailbox-unread-badge")).toBeInTheDocument();
  });

  // Comportement inchangé : zéro non-lu ⇒ aucun badge sur aucun onglet.
  it("renders no badge on any tab when the unread count is zero", async () => {
    mockFetchInbox.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    mockFetchUnreadCount.mockResolvedValue({ unreadCount: 0 });
    render(<MailboxView addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);

    await screen.findByTestId("mailbox-tabs");
    expect(screen.queryByTestId("mailbox-unread-badge")).toBeNull();

    await openOutboxTab();
    expect(screen.queryByTestId("mailbox-unread-badge")).toBeNull();
  });
});

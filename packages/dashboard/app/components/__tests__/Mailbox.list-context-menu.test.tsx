import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Message } from "@fusion/core";
import { MailboxView } from "../MailboxView";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { LIST_ITEM_LONG_PRESS_DELAY_MS, LIST_ITEM_ROW_ATTRIBUTE } from "../../utils/listItemGesture";

/*
FNXC:MailboxRowActions 2026-09-17-03:18:
FN-486 : toutes les collections de lignes de mail offrent les mêmes actions par clic droit, clavier et appui
long. Ces cas prouvent qu'aucune lecture ni mutation n'a lieu à l'ouverture du menu, que Archiver/Restaurer
suivent l'état, que Supprimer passe par une confirmation applicative sans ouvrir le message, qu'aucun
« Modifier » n'est inventé, et qu'une mutation déclenchée depuis une AUTRE ligne ne ferme pas le détail ouvert.
*/

const fetchInbox = vi.fn();
const fetchOutbox = vi.fn();
const fetchUnreadCount = vi.fn();
const fetchAgentMailbox = vi.fn();
const fetchAllAgentMailbox = vi.fn();
const markMessageRead = vi.fn();
const markAllMessagesRead = vi.fn();
const archiveMessage = vi.fn();
const unarchiveMessage = vi.fn();
const deleteMessage = vi.fn();
const fetchConversation = vi.fn();
const fetchAgents = vi.fn();
const fetchApprovals = vi.fn();

vi.mock("../../api", () => ({
  fetchInbox: (...args: unknown[]) => fetchInbox(...args),
  fetchOutbox: (...args: unknown[]) => fetchOutbox(...args),
  fetchUnreadCount: (...args: unknown[]) => fetchUnreadCount(...args),
  fetchAgentMailbox: (...args: unknown[]) => fetchAgentMailbox(...args),
  fetchAllAgentMailbox: (...args: unknown[]) => fetchAllAgentMailbox(...args),
  markMessageRead: (...args: unknown[]) => markMessageRead(...args),
  markAllMessagesRead: (...args: unknown[]) => markAllMessagesRead(...args),
  archiveMessage: (...args: unknown[]) => archiveMessage(...args),
  unarchiveMessage: (...args: unknown[]) => unarchiveMessage(...args),
  deleteMessage: (...args: unknown[]) => deleteMessage(...args),
  fetchConversation: (...args: unknown[]) => fetchConversation(...args),
  sendMessage: vi.fn(),
  fetchAgents: (...args: unknown[]) => fetchAgents(...args),
  fetchApprovals: (...args: unknown[]) => fetchApprovals(...args),
  fetchApprovalDetail: vi.fn(),
  decideApproval: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(),
  artifactMediaUrl: vi.fn(),
  fetchNativeStructurePreview: vi.fn(),
}));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => "desktop",
  isMobileViewport: () => false,
  isTabletTouchViewport: () => false,
  useViewportMode: () => "desktop",
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    fromId: "agent-1", fromType: "agent", toId: "dashboard", toType: "user",
    content: "Body of the message", type: "agent-to-user", read: true,
    createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  } as Message;
}

const inboxA = message({ id: "m-a", content: "First message" });
const inboxB = message({ id: "m-b", content: "Second message" });
const sent = message({ id: "m-sent", fromId: "dashboard", fromType: "user", toId: "agent-1", toType: "agent", content: "Sent message" });
const archived = message({ id: "m-arch", content: "Archived message", archived: true });

function renderMailbox() {
  return render(<ConfirmDialogProvider><MailboxView projectId="p1" addToast={vi.fn()} /></ConfirmDialogProvider>);
}

async function selectInboxScope(scope: string) {
  await act(async () => { fireEvent.click(screen.getByTestId("mailbox-inbox-filter")); });
  await act(async () => { fireEvent.click(screen.getByTestId(`mailbox-inbox-filter-option-${scope}`)); });
}

function openRowMenu(id: string): HTMLElement {
  fireEvent.contextMenu(screen.getByTestId(`mailbox-item-${id}`), { clientX: 30, clientY: 30 });
  return screen.getByTestId("mailbox-row-context-menu");
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchInbox.mockResolvedValue({ messages: [inboxA, inboxB], total: 2, unreadCount: 0 });
  fetchOutbox.mockResolvedValue({ messages: [sent], total: 1 });
  fetchUnreadCount.mockResolvedValue({ count: 0 });
  fetchAgents.mockResolvedValue([{ id: "agent-1", name: "Agent One", role: "executor", state: "idle", createdAt: "", updatedAt: "", metadata: {} }]);
  fetchAgentMailbox.mockResolvedValue({ inbox: [inboxA], outbox: [sent] });
  fetchAllAgentMailbox.mockResolvedValue({ messages: [inboxA] });
  fetchApprovals.mockResolvedValue({ requests: [], pendingCount: 0 });
  fetchConversation.mockImplementation(() => Promise.resolve([inboxA, inboxB]));
  markMessageRead.mockResolvedValue(undefined);
  archiveMessage.mockResolvedValue(undefined);
  unarchiveMessage.mockResolvedValue(undefined);
  deleteMessage.mockResolvedValue(undefined);
});

describe("Mailbox — menu contextuel des lignes de message", () => {
  it("qualifie chaque ligne pour le geste de fermeture et l'active au clavier", async () => {
    renderMailbox();
    const row = await screen.findByTestId("mailbox-item-m-a");
    expect(row.getAttribute(LIST_ITEM_ROW_ATTRIBUTE)).toBe("true");
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    expect(row).toHaveAttribute("role", "button");
    expect(row).toHaveAttribute("tabindex", "0");
  });

  it("n'exécute ni lecture ni mutation à l'ouverture du menu", async () => {
    renderMailbox();
    await screen.findByTestId("mailbox-item-m-a");
    const menu = openRowMenu("m-a");
    expect(within(menu).getByTestId("mailbox-menu-archive-m-a")).toBeInTheDocument();
    expect(markMessageRead).not.toHaveBeenCalled();
    expect(fetchConversation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mailbox-message-detail")).toBeNull();
  });

  it("offre Archiver et jamais Modifier pour un message de réception", async () => {
    renderMailbox();
    await screen.findByTestId("mailbox-item-m-a");
    const menu = openRowMenu("m-a");
    expect(within(menu).getByTestId("mailbox-menu-archive-m-a")).toBeInTheDocument();
    expect(within(menu).getByTestId("mailbox-menu-delete-m-a")).toBeInTheDocument();
    expect(within(menu).getByTestId("mailbox-menu-reply-m-a")).toBeInTheDocument();
    expect(within(menu).queryByTestId("mailbox-menu-restore-m-a")).toBeNull();
    expect(within(menu).queryByText(/edit/i)).toBeNull();
  });

  it("n'offre pas Répondre pour un message envoyé par l'opérateur", async () => {
    renderMailbox();
    await screen.findByTestId("mailbox-item-m-a");
    await selectInboxScope("all");
    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));
    await screen.findByTestId("mailbox-item-m-sent");
    const menu = openRowMenu("m-sent");
    expect(within(menu).queryByTestId("mailbox-menu-reply-m-sent")).toBeNull();
    expect(within(menu).getByTestId("mailbox-menu-archive-m-sent")).toBeInTheDocument();
    expect(within(menu).getByTestId("mailbox-menu-delete-m-sent")).toBeInTheDocument();
  });

  it("offre Restaurer, jamais Archiver, sur une ligne archivée", async () => {
    fetchInbox.mockImplementation((options?: { archived?: boolean }) =>
      Promise.resolve(options?.archived ? { messages: [archived], total: 1, unreadCount: 0 } : { messages: [inboxA, inboxB], total: 2, unreadCount: 0 }));
    fetchOutbox.mockResolvedValue({ messages: [], total: 0 });
    fetchAllAgentMailbox.mockResolvedValue({ messages: [] });
    renderMailbox();
    await screen.findByTestId("mailbox-item-m-a");
    await selectInboxScope("archived");
    await screen.findByTestId("mailbox-item-m-arch");
    const menu = openRowMenu("m-arch");
    expect(within(menu).getByTestId("mailbox-menu-restore-m-arch")).toBeInTheDocument();
    expect(within(menu).queryByTestId("mailbox-menu-archive-m-arch")).toBeNull();
    fireEvent.click(within(menu).getByTestId("mailbox-menu-restore-m-arch"));
    await waitFor(() => expect(unarchiveMessage).toHaveBeenCalledWith("m-arch", "p1"));
  });

  it("archive la ligne ciblée sans fermer le détail d'une autre ligne ouverte", async () => {
    renderMailbox();
    await screen.findByTestId("mailbox-item-m-a");
    fireEvent.click(screen.getByTestId("mailbox-item-m-a"));
    await screen.findByTestId("mailbox-message-detail");

    fireEvent.click(within(openRowMenu("m-b")).getByTestId("mailbox-menu-archive-m-b"));
    await waitFor(() => expect(archiveMessage).toHaveBeenCalledWith("m-b", "p1"));
    expect(screen.getByTestId("mailbox-message-detail")).toBeInTheDocument();
  });

  it("ferme le détail lorsque la mutation vise la ligne sélectionnée", async () => {
    renderMailbox();
    await screen.findByTestId("mailbox-item-m-a");
    fireEvent.click(screen.getByTestId("mailbox-item-m-a"));
    await screen.findByTestId("mailbox-message-detail");

    fireEvent.click(within(openRowMenu("m-a")).getByTestId("mailbox-menu-archive-m-a"));
    await waitFor(() => expect(archiveMessage).toHaveBeenCalledWith("m-a", "p1"));
    await waitFor(() => expect(screen.queryByTestId("mailbox-message-detail")).toBeNull());
  });

  it("supprime exactement une fois après confirmation, et pas du tout si elle est annulée", async () => {
    renderMailbox();
    await screen.findByTestId("mailbox-item-m-a");

    fireEvent.click(within(openRowMenu("m-a")).getByTestId("mailbox-menu-delete-m-a"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(deleteMessage).not.toHaveBeenCalled());

    fireEvent.click(within(openRowMenu("m-a")).getByTestId("mailbox-menu-delete-m-a"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("m-a", "p1"));
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mailbox-message-detail")).toBeNull();
  });

  it("ouvre le menu par appui long sans ouvrir le message", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderMailbox();
      const row = await screen.findByTestId("mailbox-item-m-a");
      fireEvent.pointerDown(row, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 8, clientY: 8 });
      act(() => { vi.advanceTimersByTime(LIST_ITEM_LONG_PRESS_DELAY_MS); });
      expect(screen.getByTestId("mailbox-row-context-menu")).toBeInTheDocument();
      fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1 });
      fireEvent.click(row);
      expect(markMessageRead).not.toHaveBeenCalled();
      expect(screen.queryByTestId("mailbox-message-detail")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("n'expose aucune commande destructive de message sur une demande d'approbation", async () => {
    fetchApprovals.mockResolvedValue({ requests: [{ id: "ap-1", agentId: "agent-1", actionCategory: "shell", actionSummary: "run a command", status: "pending", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" }], pendingCount: 1 });
    renderMailbox();
    await screen.findByTestId("mailbox-item-m-a");
    await selectInboxScope("approvals");
    const approval = await screen.findByTestId("mailbox-approval-item-ap-1");
    fireEvent.contextMenu(approval, { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId("mailbox-row-context-menu")).toBeNull();
  });
});

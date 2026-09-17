import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import {
  mockArchiveMessage,
  mockConfirm,
  mockDeleteMessage,
  mockFetchAgentMailbox,
  setupAgentDetailMocks,
} from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";
import { LIST_ITEM_ROW_ATTRIBUTE } from "../../utils/listItemGesture";

/*
FNXC:MailboxRowActions 2026-09-17-03:18:
FN-486 : l'onglet Mail d'un agent est le TROISIÈME producteur de lignes de mail. Il sert les mêmes commandes
par le menu contextuel de la ligne, mais il ne dispose d'aucun composeur : aucune commande « Répondre » ne
doit y apparaître, et aucune « Modifier » n'existe nulle part. La suppression garde une confirmation.
*/

const received = {
  id: "msg-in", fromId: "agent-002", fromType: "agent", toId: "agent-001", toType: "agent",
  content: "Received body", type: "agent-to-agent", read: true,
  createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z",
};
const sent = { ...received, id: "msg-out", fromId: "agent-001", toId: "agent-002", content: "Sent body" };

async function openMailTab() {
  const user = userEvent.setup();
  render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("Mail")).toBeInTheDocument());
  await user.click(screen.getByText("Mail"));
  await waitFor(() => expect(mockFetchAgentMailbox).toHaveBeenCalled());
  return user;
}

function openRowMenu(id: string): HTMLElement {
  const row = screen.getByTestId(`mailbox-item-subject-${id}`).closest(".agent-mail-tab-message") as HTMLElement;
  fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
  return screen.getByTestId("agent-detail-mail-context-menu");
}

describe("AgentDetailView — menu contextuel des lignes de mail", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
    mockFetchAgentMailbox.mockResolvedValue({
      ownerId: "agent-001", ownerType: "agent", unreadCount: 0, messages: [], inbox: [received], outbox: [sent],
    } as never);
    mockArchiveMessage.mockResolvedValue(undefined as never);
    mockDeleteMessage.mockResolvedValue(undefined as never);
  });

  it("qualifie la ligne et offre Archiver et Supprimer, jamais Répondre ni Modifier", async () => {
    await openMailTab();
    await screen.findByTestId("mailbox-item-subject-msg-in");
    const row = screen.getByTestId("mailbox-item-subject-msg-in").closest(".agent-mail-tab-message") as HTMLElement;
    expect(row.getAttribute(LIST_ITEM_ROW_ATTRIBUTE)).toBe("true");

    const menu = openRowMenu("msg-in");
    expect(within(menu).getByTestId("mailbox-menu-archive-msg-in")).toBeInTheDocument();
    expect(within(menu).getByTestId("mailbox-menu-delete-msg-in")).toBeInTheDocument();
    expect(within(menu).queryByTestId("mailbox-menu-reply-msg-in")).toBeNull();
    expect(within(menu).queryByText(/edit/i)).toBeNull();
  });

  it("archive la ligne ciblée et rafraîchit sans ouvrir le message", async () => {
    await openMailTab();
    await screen.findByTestId("mailbox-item-subject-msg-in");
    fireEvent.click(within(openRowMenu("msg-in")).getByTestId("mailbox-menu-archive-msg-in"));
    await waitFor(() => expect(mockArchiveMessage).toHaveBeenCalledWith("msg-in", undefined));
    expect(screen.queryByTestId("agent-detail-mail-message")).toBeNull();
  });

  it("ne supprime pas quand la confirmation est refusée, puis supprime exactement une fois", async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const user = await openMailTab();
    await screen.findByTestId("mailbox-item-subject-msg-in");
    await user.click(screen.getByText("Outbox"));
    await screen.findByTestId("mailbox-item-subject-msg-out");

    fireEvent.click(within(openRowMenu("msg-out")).getByTestId("mailbox-menu-delete-msg-out"));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockDeleteMessage).not.toHaveBeenCalled();

    mockConfirm.mockResolvedValueOnce(true);
    fireEvent.click(within(openRowMenu("msg-out")).getByTestId("mailbox-menu-delete-msg-out"));
    await waitFor(() => expect(mockDeleteMessage).toHaveBeenCalledWith("msg-out", undefined));
    expect(mockDeleteMessage).toHaveBeenCalledTimes(1);
  });
});

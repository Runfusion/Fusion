import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import {
  mockFetchAgentMailbox,
  setupAgentDetailMocks,
} from "./AgentDetailView.test-helpers";
import { AgentDetailView } from "../AgentDetailView";

/*
FNXC:MailboxSubject 2026-09-15-04:40:
The agent Mail tab is the third mailbox list surface. It showed the author then the raw head of the
body, so a completion notice read literally as "## Task completed: FN-325". It must now show the
author AND the derived subject, with no Markdown leakage and no empty preview shell, in both the
inbox and outbox sub-tabs, and the opened mail must state its subject alongside From/To.
*/

const completionNotice = {
  id: "msg-completion",
  fromId: "agent-002",
  fromType: "agent",
  toId: "agent-001",
  toType: "agent",
  content: "## Task completed: FN-325\n\nDelivered the unified mail.",
  type: "agent-to-agent",
  read: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  metadata: { kind: "task-completion-notice", taskId: "FN-325" },
};

const singleLineSent = {
  ...completionNotice,
  id: "msg-sent",
  fromId: "agent-001",
  toId: "agent-002",
  content: "**FN-1 needs operator action**",
  metadata: undefined,
};

async function openMailTab() {
  const user = userEvent.setup();
  render(<AgentDetailView agentId="agent-001" onClose={vi.fn()} addToast={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("Mail")).toBeInTheDocument());
  await user.click(screen.getByText("Mail"));
  await waitFor(() => expect(mockFetchAgentMailbox).toHaveBeenCalled());
  return user;
}

describe("AgentDetailView — Mail tab subject", () => {
  beforeEach(() => {
    setupAgentDetailMocks();
    mockFetchAgentMailbox.mockResolvedValue({
      ownerId: "agent-001",
      ownerType: "agent",
      unreadCount: 0,
      messages: [],
      inbox: [completionNotice],
      outbox: [singleLineSent],
    } as never);
  });

  it("shows the author and a Markdown-free subject in the inbox sub-tab", async () => {
    await openMailTab();
    const row = await screen.findByTestId("mailbox-item-subject-msg-completion");
    expect(row).toHaveTextContent("FN-325 completed");

    const item = row.closest(".agent-mail-tab-message") as HTMLElement;
    expect(item.textContent ?? "").not.toContain("##");
    expect(item.textContent ?? "").not.toContain("**");
    expect(item.textContent ?? "").toContain("Manager Agent");
    expect(within(item).getByText("Delivered the unified mail.")).toBeInTheDocument();
  });

  it("shows the recipient and subject in the outbox sub-tab without an empty preview shell", async () => {
    const user = await openMailTab();
    await user.click(screen.getByText("Outbox"));

    const row = await screen.findByTestId("mailbox-item-subject-msg-sent");
    expect(row).toHaveTextContent("FN-1 needs operator action");

    const item = row.closest(".agent-mail-tab-message") as HTMLElement;
    expect(item.textContent ?? "").not.toContain("**");
    expect(item.textContent ?? "").toContain("To:");
    // Single-line body: nothing remains to preview, so no preview element is rendered at all.
    expect(item.querySelector(".mailbox-item-preview")).toBeNull();
  });

  it("states the subject alongside From and To in the opened mail", async () => {
    const user = await openMailTab();
    await user.click(await screen.findByTestId("mailbox-item-subject-msg-completion"));

    const detail = await screen.findByTestId("agent-detail-mail-message");
    expect(within(detail).getByTestId("agent-mail-tab-detail-subject")).toHaveTextContent("FN-325 completed");
    expect(within(detail).getByText("Subject")).toBeInTheDocument();
    expect(within(detail).getByText("From")).toBeInTheDocument();
    expect(within(detail).getByText("To")).toBeInTheDocument();
  });
});

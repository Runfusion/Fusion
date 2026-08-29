import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Message, MessageMetadata } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { createProposedTask } from "../../api";
import { MailboxTaskProposal } from "../MailboxTaskProposal";

vi.mock("../../api", () => ({ createProposedTask: vi.fn() }));

const proposalMetadata: MessageMetadata = {
  kind: "task-proposal",
  proposalStatus: "pending",
  proposalIdempotencyKey: "proposal-key",
  proposedTask: { title: "Follow up", description: "Implement the follow-up." },
};

function createdMessage(): Message {
  return {
    id: "message-1", fromId: "agent-1", fromType: "agent", toId: "dashboard-user", toType: "user",
    content: "Proposal", type: "agent-to-user", read: false, metadata: {
      ...proposalMetadata, proposalStatus: "created", createdTaskId: "FN-8265",
    }, createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("MailboxTaskProposal", () => {
  it("renders nothing for non-proposal metadata", () => {
    const { container } = render(<MailboxTaskProposal messageId="message-1" metadata={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("replaces Create task with the created-task affordance from the successful response", async () => {
    const onOpenTask = vi.fn();
    vi.mocked(createProposedTask).mockResolvedValue({ task: { id: "FN-8265" } as never, proposal: createdMessage() });
    render(<MailboxTaskProposal messageId="message-1" metadata={proposalMetadata} projectId="project-1" onOpenTask={onOpenTask} />);

    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Task FN-8265 created — View task" })).toBeInTheDocument());
    expect(createProposedTask).toHaveBeenCalledWith("message-1", "project-1");
    fireEvent.click(screen.getByRole("button", { name: "Task FN-8265 created — View task" }));
    expect(onOpenTask).toHaveBeenCalledWith("FN-8265");
  });
});

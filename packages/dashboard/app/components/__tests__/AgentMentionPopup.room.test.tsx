import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@fusion/core";
import { AgentMentionPopup } from "../AgentMentionPopup";

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Bot: ({ "data-testid": testId, ...props }: any) => (
      <svg data-testid={testId || "icon-bot"} {...props} />
    ),
  };
});

const agents: Agent[] = [
  { id: "agent-001", name: "Alpha", role: "executor", state: "idle", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z", metadata: {} },
  { id: "agent-002", name: "Alfred", role: "reviewer", state: "idle", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z", metadata: {} },
  { id: "agent-003", name: "Alex", role: "triage", state: "idle", createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z", metadata: {} },
];

describe("AgentMentionPopup room behavior", () => {
  it("shows only members with hint on empty filter", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter=""
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
        roomMemberIds={new Set(["agent-001", "agent-003"])}
      />,
    );

    expect(screen.getByTestId("agent-mention-item-agent-001")).toBeInTheDocument();
    expect(screen.getByTestId("agent-mention-item-agent-003")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-mention-item-agent-002")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-mention-other-hint")).toBeInTheDocument();
  });

  it("shows matching members before matching non-members when filtering", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter="al"
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
        roomMemberIds={new Set(["agent-003"])}
      />,
    );

    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("data-testid", "agent-mention-item-agent-003");
    expect(options[1]).toHaveAttribute("data-testid", "agent-mention-item-agent-001");
  });

  it("supports keyboard-index traversal across members then non-members", () => {
    const roomMemberIds = new Set(["agent-003"]);
    const { rerender } = render(
      <AgentMentionPopup
        agents={agents}
        filter="al"
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
        roomMemberIds={roomMemberIds}
      />,
    );

    expect(screen.getByTestId("agent-mention-item-agent-003")).toHaveClass("agent-mention-item--highlighted");
    expect(screen.getByTestId("agent-mention-item-agent-003")).toHaveAttribute("aria-selected", "true");

    rerender(
      <AgentMentionPopup
        agents={agents}
        filter="al"
        highlightedIndex={1}
        visible={true}
        onSelect={vi.fn()}
        roomMemberIds={roomMemberIds}
      />,
    );

    expect(screen.getByTestId("agent-mention-item-agent-001")).toHaveClass("agent-mention-item--highlighted");
    expect(screen.getByTestId("agent-mention-item-agent-001")).toHaveAttribute("aria-selected", "true");
  });

  it("selects non-members and includes accessible member dot labels", () => {
    const onSelect = vi.fn();
    render(
      <AgentMentionPopup
        agents={agents}
        filter="al"
        highlightedIndex={0}
        visible={true}
        onSelect={onSelect}
        roomMemberIds={new Set(["agent-001"])}
      />,
    );

    fireEvent.click(screen.getByTestId("agent-mention-item-agent-002"));
    expect(onSelect).toHaveBeenCalledWith(agents[1]);
    expect(screen.getAllByLabelText("Room member")).toHaveLength(1);
  });
});

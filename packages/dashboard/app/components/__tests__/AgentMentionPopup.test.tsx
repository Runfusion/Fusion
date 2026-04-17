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
  {
    id: "agent-001",
    name: "Alpha",
    role: "executor",
    state: "idle",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    metadata: {},
  },
  {
    id: "agent-002",
    name: "Beta Reviewer",
    role: "reviewer",
    state: "idle",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    metadata: {},
  },
];

describe("AgentMentionPopup", () => {
  it("renders agent list when visible", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter=""
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("agent-mention-popup")).toBeInTheDocument();
    expect(screen.getByTestId("agent-mention-item-agent-001")).toBeInTheDocument();
    expect(screen.getByTestId("agent-mention-item-agent-002")).toBeInTheDocument();
  });

  it("filters agents by name case-insensitively", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter="review"
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("agent-mention-item-agent-001")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-mention-item-agent-002")).toBeInTheDocument();
  });

  it("highlights the item at highlightedIndex", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter=""
        highlightedIndex={1}
        visible={true}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("agent-mention-item-agent-001")).not.toHaveClass(
      "agent-mention-item--highlighted",
    );
    expect(screen.getByTestId("agent-mention-item-agent-002")).toHaveClass(
      "agent-mention-item--highlighted",
    );
  });

  it("calls onSelect when item is clicked", () => {
    const onSelect = vi.fn();

    render(
      <AgentMentionPopup
        agents={agents}
        filter=""
        highlightedIndex={0}
        visible={true}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId("agent-mention-item-agent-002"));
    expect(onSelect).toHaveBeenCalledWith(agents[1]);
  });

  it("shows empty state when filter has no matches", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter="zzz"
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("No agents found")).toBeInTheDocument();
  });

  it("renders nothing when visible is false", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter=""
        highlightedIndex={0}
        visible={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("agent-mention-popup")).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@fusion/core";
import { AgentMentionPopup } from "../AgentMentionPopup";
import { loadAllAppCss } from "../../test/cssFixture";

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
  {
    id: "agent-003",
    name: "Gamma",
    role: "triage",
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

  it.each([
    ["review", "filters agents by name case-insensitively"],
    ["beta_re", "matches underscore handles for agents with spaces"],
  ])("%s %s", (filter) => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter={filter}
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

  it("keeps the below modifier class when rendered below", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter=""
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
        position="below"
      />,
    );

    expect(screen.getByTestId("agent-mention-popup")).toHaveClass("agent-mention-popup--below");
  });

  it("keeps the above modifier class when rendered above", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter=""
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
        position="above"
      />,
    );

    expect(screen.getByTestId("agent-mention-popup")).toHaveClass("agent-mention-popup--above");
  });

  it("anchors the below modifier above the input inside the mobile media query", async () => {
    const css = await loadAllAppCss();

    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)\s*\{\s*\.agent-mention-popup\s*\{[^}]*\}\s*\.agent-mention-popup--below,\s*\.agent-mention-popup--above\s*\{[^}]*bottom:\s*calc\(100%\s*\+\s*var\(--space-xs\)\);[^}]*top:\s*auto;[^}]*\}/,
    );
  });

  it("shows room sections with members first and member dot label", () => {
    render(
      <AgentMentionPopup
        agents={agents}
        filter="a"
        highlightedIndex={0}
        visible={true}
        onSelect={vi.fn()}
        roomMemberIds={new Set(["agent-003", "agent-001"])}
        roomName="engineering"
      />,
    );

    expect(screen.getByTestId("agent-mention-members-header")).toHaveTextContent("Members of #engineering");
    expect(screen.getByTestId("agent-mention-others-header")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Room member")).toHaveLength(2);
  });

  it("room mode hides other section when filter is empty and still allows selecting non-member when searching", () => {
    const onSelect = vi.fn();
    const roomMemberIds = new Set(["agent-001"]);
    const { rerender } = render(
      <AgentMentionPopup
        agents={agents}
        filter=""
        highlightedIndex={0}
        visible={true}
        onSelect={onSelect}
        roomMemberIds={roomMemberIds}
      />,
    );

    expect(screen.queryByTestId("agent-mention-others-header")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-mention-other-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-mention-item-agent-002")).not.toBeInTheDocument();

    rerender(
      <AgentMentionPopup
        agents={agents}
        filter="be"
        highlightedIndex={1}
        visible={true}
        onSelect={onSelect}
        roomMemberIds={roomMemberIds}
      />,
    );

    fireEvent.click(screen.getByTestId("agent-mention-item-agent-002"));
    expect(onSelect).toHaveBeenCalledWith(agents[1]);
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

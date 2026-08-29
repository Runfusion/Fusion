import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentsOverviewBar } from "../AgentsOverviewBar";
import type { Agent } from "../../api";

vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    ChevronDown: () => <span data-testid="chevron-down" />,
    ChevronRight: () => <span data-testid="chevron-right" />,
  };
});

vi.mock("../AgentMetricsBar", () => ({
  AgentMetricsBar: () => <div data-testid="agent-metrics-bar" />,
}));

vi.mock("../ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => <div data-testid="active-agents-panel" />,
}));

function makeAgent(id: string, state: Agent["state"]): Agent {
  return {
    id,
    name: id,
    role: "executor",
    state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  };
}

describe("AgentsOverviewBar", () => {
  it("counts active and running states separately in the meta label", () => {
    // Three in 'active' (idle/enabled) and one in 'running' (mid-heartbeat).
    // The label must reflect the distinction — previously both buckets were
    // displayed under "running", which was misleading when only some were
    // actually executing.
    const agents = [
      makeAgent("a-1", "active"),
      makeAgent("a-2", "active"),
      makeAgent("a-3", "active"),
      makeAgent("a-4", "running"),
    ];

    render(
      <AgentsOverviewBar
        stats={null}
        activeAgents={agents}
        isOpen={false}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByText("3 active · 1 running")).toBeInTheDocument();
  });

  it("shows zero counts when no agents are active or running", () => {
    render(
      <AgentsOverviewBar
        stats={null}
        activeAgents={[]}
        isOpen={false}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByText("0 active · 0 running")).toBeInTheDocument();
  });

  it("renders metrics bar and active agents panel when open", () => {
    render(
      <AgentsOverviewBar
        stats={null}
        activeAgents={[]}
        isOpen
        onToggle={() => {}}
      />,
    );

    expect(screen.getByTestId("agent-metrics-bar")).toBeInTheDocument();
    expect(screen.getByTestId("active-agents-panel")).toBeInTheDocument();
  });

  it("hides content when collapsed", () => {
    render(
      <AgentsOverviewBar
        stats={null}
        activeAgents={[]}
        isOpen={false}
        onToggle={() => {}}
      />,
    );

    expect(screen.queryByTestId("agent-metrics-bar")).toBeNull();
    expect(screen.queryByTestId("active-agents-panel")).toBeNull();
  });
});

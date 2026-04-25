import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AgentTokenStatsPanel } from "../AgentTokenStatsPanel";
import type { Agent } from "../../api";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-default",
    name: "Default Agent",
    role: "executor",
    state: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

describe("AgentTokenStatsPanel", () => {
  it("renders aggregate totals from agent cumulative token fields", () => {
    render(
      <AgentTokenStatsPanel
        agents={[
          makeAgent({ id: "a-1", name: "Alpha", totalInputTokens: 100, totalOutputTokens: 40 }),
          makeAgent({ id: "a-2", name: "Beta", totalInputTokens: 10, totalOutputTokens: 5 }),
        ]}
      />,
    );

    expect(screen.getByText("Input Tokens")).toBeInTheDocument();
    expect(screen.getByText("110")).toBeInTheDocument();
    expect(screen.getByText("Output Tokens")).toBeInTheDocument();
    expect(screen.getByText("45")).toBeInTheDocument();
    expect(screen.getByText("Combined Tokens")).toBeInTheDocument();
    expect(screen.getByText("155")).toBeInTheDocument();
  });

  it("sorts per-agent rows by total usage descending", () => {
    render(
      <AgentTokenStatsPanel
        agents={[
          makeAgent({ id: "a-1", name: "Alpha", totalInputTokens: 50, totalOutputTokens: 20 }),
          makeAgent({ id: "a-2", name: "Beta", totalInputTokens: 5, totalOutputTokens: 5 }),
          makeAgent({ id: "a-3", name: "Gamma", totalInputTokens: 20, totalOutputTokens: 40 }),
        ]}
      />,
    );

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Alpha")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Gamma")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Beta")).toBeInTheDocument();
  });

  it("treats missing token fields as zero and shows empty state when there is no usage", () => {
    render(
      <AgentTokenStatsPanel
        agents={[
          makeAgent({ id: "a-1", name: "Zero One", totalInputTokens: undefined, totalOutputTokens: undefined }),
          makeAgent({ id: "a-2", name: "Zero Two" }),
        ]}
      />,
    );

    expect(screen.getByText("No token usage recorded yet. Token totals appear here once agents run.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(3);
  });
});

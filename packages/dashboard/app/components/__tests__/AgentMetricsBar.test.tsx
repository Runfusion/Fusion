import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentMetricsBar } from "../AgentMetricsBar";
import type { AgentStats } from "../../api";

// Mock lucide-react icons
vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    Activity: () => <span data-testid="activity-icon">Activity</span>,
    ListTodo: () => <span data-testid="list-todo-icon">ListTodo</span>,
    CheckCircle: () => <span data-testid="check-circle-icon">CheckCircle</span>,
    Zap: () => <span data-testid="zap-icon">Zap</span>,
  };
});

function makeStats(overrides: Partial<AgentStats> = {}): AgentStats {
  return {
    activeCount: 3,
    assignedTaskCount: 5,
    completedRuns: 42,
    failedRuns: 3,
    successRate: 0.933,
    ...overrides,
  };
}

describe("AgentMetricsBar", () => {
  it("renders null when stats is null", () => {
    const { container } = render(<AgentMetricsBar stats={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders all four metric cards", () => {
    render(<AgentMetricsBar stats={makeStats()} />);

    expect(screen.getByText("Active Agents")).toBeInTheDocument();
    expect(screen.getByText("Assigned Tasks")).toBeInTheDocument();
    expect(screen.getByText("Success Rate")).toBeInTheDocument();
    expect(screen.getByText("Total Runs")).toBeInTheDocument();
  });

  it("displays correct values for each metric", () => {
    const stats = makeStats({
      activeCount: 5,
      assignedTaskCount: 10,
      completedRuns: 100,
      successRate: 0.85,
    });
    render(<AgentMetricsBar stats={stats} />);

    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("85%")).toBeInTheDocument();
  });

  it("displays Total Runs with completedRuns value", () => {
    const stats = makeStats({ completedRuns: 42 });
    render(<AgentMetricsBar stats={stats} />);

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Total Runs")).toBeInTheDocument();
  });

  it("displays zero Total Runs when completedRuns is 0", () => {
    const stats = makeStats({ completedRuns: 0 });
    render(<AgentMetricsBar stats={stats} />);

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Total Runs")).toBeInTheDocument();
  });

  it("displays large Total Runs values correctly", () => {
    const stats = makeStats({ completedRuns: 99999 });
    render(<AgentMetricsBar stats={stats} />);

    expect(screen.getByText("99999")).toBeInTheDocument();
  });

  it("displays success rate rounded to nearest integer", () => {
    const stats = makeStats({ successRate: 0.876 });
    render(<AgentMetricsBar stats={stats} />);

    expect(screen.getByText("88%")).toBeInTheDocument();
  });

  it("displays 0% when successRate is 0", () => {
    const stats = makeStats({ successRate: 0 });
    render(<AgentMetricsBar stats={stats} />);

    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("displays 100% when successRate is 1", () => {
    const stats = makeStats({ successRate: 1 });
    render(<AgentMetricsBar stats={stats} />);

    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("renders all icon types", () => {
    render(<AgentMetricsBar stats={makeStats()} />);

    expect(screen.getByTestId("activity-icon")).toBeInTheDocument();
    expect(screen.getByTestId("list-todo-icon")).toBeInTheDocument();
    expect(screen.getByTestId("check-circle-icon")).toBeInTheDocument();
    expect(screen.getByTestId("zap-icon")).toBeInTheDocument();
  });
});

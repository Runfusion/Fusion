import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentReflectionsTab } from "./AgentReflectionsTab";
import {
  fetchAgentReflections,
  fetchAgentPerformance,
  triggerAgentReflection,
} from "../api";

vi.mock("../api", () => ({
  fetchAgentReflections: vi.fn(),
  fetchAgentPerformance: vi.fn(),
  triggerAgentReflection: vi.fn(),
}));

const mockedFetchAgentReflections = vi.mocked(fetchAgentReflections);
const mockedFetchAgentPerformance = vi.mocked(fetchAgentPerformance);
const mockedTriggerAgentReflection = vi.mocked(triggerAgentReflection);

describe("AgentReflectionsTab", () => {
  const mockReflections = [
    {
      id: "ref-001",
      agentId: "agent-001",
      timestamp: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      trigger: "periodic",
      metrics: {
        tasksCompleted: 5,
        tasksFailed: 1,
        avgDurationMs: 120000,
      },
      insights: ["Insight 1", "Insight 2"],
      suggestedImprovements: ["Improve X", "Fix Y"],
      summary: "Test summary for the reflection",
    },
    {
      id: "ref-002",
      agentId: "agent-001",
      timestamp: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
      trigger: "manual",
      metrics: {
        tasksCompleted: 3,
        tasksFailed: 0,
        avgDurationMs: 90000,
      },
      insights: ["Another insight"],
      suggestedImprovements: ["Another suggestion"],
      summary: "Another summary",
    },
  ];

  const mockPerformance = {
    agentId: "agent-001",
    totalTasksCompleted: 10,
    totalTasksFailed: 2,
    avgDurationMs: 110000,
    successRate: 0.833,
    commonErrors: ["Error 1"],
    strengths: ["Strong point"],
    weaknesses: ["Weak point"],
    recentReflectionCount: 3,
    computedAt: new Date().toISOString(),
  };

  const addToast = vi.fn();

  beforeEach(() => {
    mockedFetchAgentReflections.mockReset();
    mockedFetchAgentPerformance.mockReset();
    mockedTriggerAgentReflection.mockReset();
    mockedFetchAgentReflections.mockResolvedValue(mockReflections);
    mockedFetchAgentPerformance.mockResolvedValue(mockPerformance);
    addToast.mockReset();
  });

  it("renders loading state initially", () => {
    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    expect(screen.getByText("Loading reflections...")).toBeInTheDocument();
  });

  it("renders performance summary cards with data", async () => {
    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Tasks Completed")).toBeInTheDocument();
    });

    expect(screen.getByText("10")).toBeInTheDocument(); // totalTasksCompleted
    expect(screen.getByText("2")).toBeInTheDocument(); // totalTasksFailed
    expect(screen.getByText("83%")).toBeInTheDocument(); // successRate
    expect(screen.getByText("3")).toBeInTheDocument(); // recentReflectionCount
  });

  it("renders reflections list with correct timestamps and trigger badges", async () => {
    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Reflection History")).toBeInTheDocument();
    });

    // Check trigger badges
    expect(screen.getByText("Periodic")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();

    // Check summaries are shown
    expect(screen.getByText("Test summary for the reflection")).toBeInTheDocument();
    expect(screen.getByText("Another summary")).toBeInTheDocument();
  });

  it("shows empty state when no reflections exist", async () => {
    mockedFetchAgentReflections.mockResolvedValue([]);
    mockedFetchAgentPerformance.mockResolvedValue({
      ...mockPerformance,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
      recentReflectionCount: 0,
    });

    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("No reflections yet")).toBeInTheDocument();
    });

    expect(screen.getByText("Trigger a reflection to get started")).toBeInTheDocument();
  });

  it("shows 'no performance data' when summary has zeros", async () => {
    mockedFetchAgentPerformance.mockResolvedValue({
      ...mockPerformance,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
      recentReflectionCount: 0,
    });

    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("No performance data yet")).toBeInTheDocument();
    });
  });

  it("clicking a reflection card expands it to show insights and suggestions", async () => {
    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Test summary for the reflection")).toBeInTheDocument();
    });

    // Click on the first reflection card
    const firstCard = screen.getByText("Test summary for the reflection").closest(".reflection-card");
    expect(firstCard).toBeInTheDocument();
    fireEvent.click(firstCard!);

    // Check expanded content
    await waitFor(() => {
      expect(screen.getByText("Insights")).toBeInTheDocument();
      expect(screen.getByText("Suggested Improvements")).toBeInTheDocument();
    });

    expect(screen.getByText("Insight 1")).toBeInTheDocument();
    expect(screen.getByText("Improve X")).toBeInTheDocument();
  });

  it("clicking Reflect Now calls triggerAgentReflection and refreshes data", async () => {
    mockedTriggerAgentReflection.mockResolvedValue({
      ...mockReflections[0],
      id: "ref-003",
    });

    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Reflect Now")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Reflect Now"));

    // Should call triggerAgentReflection
    await waitFor(() => {
      expect(mockedTriggerAgentReflection).toHaveBeenCalledWith("agent-001", "test-project");
    });

    // Should show success toast
    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Reflection generated successfully", "success");
    });

    // Should refresh data
    expect(mockedFetchAgentReflections).toHaveBeenCalledTimes(2); // Initial + refresh
    expect(mockedFetchAgentPerformance).toHaveBeenCalledTimes(2); // Initial + refresh
  });

  it("shows error toast when Reflect Now fails", async () => {
    mockedTriggerAgentReflection.mockRejectedValue(new Error("Service unavailable"));

    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Reflect Now")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Reflect Now"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Service unavailable"), "error");
    });
  });

  it("disables Reflect Now button while reflecting is in progress", async () => {
    mockedTriggerAgentReflection.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(mockReflections[0]), 1000))
    );

    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Reflect Now")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Reflect Now"));

    // Should show "Reflecting..." text
    await waitFor(() => {
      expect(screen.getByText("Reflecting...")).toBeInTheDocument();
    });

    // Button should be disabled
    const button = screen.getByText("Reflecting...").closest("button");
    expect(button).toBeDisabled();
  });

  it("shows error toast when loading data fails", async () => {
    mockedFetchAgentReflections.mockRejectedValue(new Error("Network error"));
    mockedFetchAgentPerformance.mockResolvedValue(mockPerformance);

    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Failed to load reflections"), "error");
    });
  });

  it("displays metrics when expanded", async () => {
    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Test summary for the reflection")).toBeInTheDocument();
    });

    const firstCard = screen.getByText("Test summary for the reflection").closest(".reflection-card");
    fireEvent.click(firstCard!);

    await waitFor(() => {
      expect(screen.getByText("Metrics")).toBeInTheDocument();
    });

    expect(screen.getByText(/Tasks:/)).toBeInTheDocument();
    expect(screen.getByText(/Failed:/)).toBeInTheDocument();
  });

  it("collapses reflection when clicking again", async () => {
    render(
      <AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />
    );

    await waitFor(() => {
      expect(screen.getByText("Test summary for the reflection")).toBeInTheDocument();
    });

    const firstCard = screen.getByText("Test summary for the reflection").closest(".reflection-card");
    fireEvent.click(firstCard!);

    await waitFor(() => {
      expect(screen.getByText("Insights")).toBeInTheDocument();
    });

    // Click again to collapse
    fireEvent.click(firstCard!);

    await waitFor(() => {
      expect(screen.queryByText("Insights")).not.toBeInTheDocument();
    });
  });
});

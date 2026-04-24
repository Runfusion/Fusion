import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentReflectionsTab } from "./AgentReflectionsTab";
import {
  addAgentRating,
  deleteAgentRating,
  fetchAgentPerformance,
  fetchAgentRatings,
  fetchAgentRatingSummary,
  fetchAgentReflections,
  triggerAgentReflection,
} from "../api";

vi.mock("../api", () => ({
  addAgentRating: vi.fn(),
  deleteAgentRating: vi.fn(),
  fetchAgentPerformance: vi.fn(),
  fetchAgentRatings: vi.fn(),
  fetchAgentRatingSummary: vi.fn(),
  fetchAgentReflections: vi.fn(),
  triggerAgentReflection: vi.fn(),
}));

const mockedAddAgentRating = vi.mocked(addAgentRating);
const mockedDeleteAgentRating = vi.mocked(deleteAgentRating);
const mockedFetchAgentReflections = vi.mocked(fetchAgentReflections);
const mockedFetchAgentPerformance = vi.mocked(fetchAgentPerformance);
const mockedFetchAgentRatings = vi.mocked(fetchAgentRatings);
const mockedFetchAgentRatingSummary = vi.mocked(fetchAgentRatingSummary);
const mockedTriggerAgentReflection = vi.mocked(triggerAgentReflection);

describe("AgentReflectionsTab", () => {
  const mockReflections = [
    {
      id: "ref-001",
      agentId: "agent-001",
      timestamp: new Date(Date.now() - 3_600_000).toISOString(),
      trigger: "periodic",
      metrics: {
        tasksCompleted: 5,
        tasksFailed: 1,
        avgDurationMs: 120_000,
      },
      insights: ["Insight 1", "Insight 2"],
      suggestedImprovements: ["Improve X", "Fix Y"],
      summary: "Test summary for the reflection",
    },
  ];

  const mockPerformance = {
    agentId: "agent-001",
    totalTasksCompleted: 10,
    totalTasksFailed: 2,
    avgDurationMs: 110_000,
    successRate: 0.833,
    commonErrors: ["Error 1"],
    strengths: ["Strong point"],
    weaknesses: ["Weak point"],
    recentReflectionCount: 3,
    computedAt: new Date().toISOString(),
  };

  const mockRatingSummary = {
    agentId: "agent-001",
    averageScore: 4.2,
    totalRatings: 5,
    trend: "improving" as const,
    categoryAverages: {
      quality: 4.5,
      speed: 4,
    },
    recentRatings: [],
  };

  const mockRatings = [
    {
      id: "rating-1",
      agentId: "agent-001",
      score: 4,
      category: "quality",
      comment: "Great execution",
      raterType: "user" as const,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    },
  ];

  const addToast = vi.fn();

  beforeEach(() => {
    mockedAddAgentRating.mockReset();
    mockedDeleteAgentRating.mockReset();
    mockedFetchAgentReflections.mockReset();
    mockedFetchAgentPerformance.mockReset();
    mockedFetchAgentRatings.mockReset();
    mockedFetchAgentRatingSummary.mockReset();
    mockedTriggerAgentReflection.mockReset();

    mockedFetchAgentReflections.mockResolvedValue(mockReflections);
    mockedFetchAgentPerformance.mockResolvedValue(mockPerformance);
    mockedFetchAgentRatings.mockResolvedValue(mockRatings);
    mockedFetchAgentRatingSummary.mockResolvedValue(mockRatingSummary);
    mockedTriggerAgentReflection.mockResolvedValue(mockReflections[0]);

    addToast.mockReset();
  });

  it("renders loading state initially", () => {
    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);
    expect(screen.getByText("Loading evaluation...")).toBeInTheDocument();
  });

  it("loads and renders reflections, performance, and ratings", async () => {
    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Performance, Reflections & Ratings")).toBeInTheDocument();
    });

    expect(screen.getByText("Tasks Completed")).toBeInTheDocument();
    expect(screen.getByText("User Ratings")).toBeInTheDocument();
    expect(screen.getByText("Category Averages")).toBeInTheDocument();
    expect(screen.getByText("Reflection History")).toBeInTheDocument();
    expect(screen.getByText("Rating History")).toBeInTheDocument();
    expect(screen.getByText("Great execution")).toBeInTheDocument();
  });

  it("shows empty ratings history state", async () => {
    mockedFetchAgentRatings.mockResolvedValue([]);

    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("No ratings yet")).toBeInTheDocument();
    });
  });

  it("submits a new rating and refreshes rating data", async () => {
    mockedAddAgentRating.mockResolvedValue(mockRatings[0]);

    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Submit Rating")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("4 stars"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "speed" } });
    fireEvent.change(screen.getByPlaceholderText("Optional comment..."), { target: { value: "Fast" } });
    fireEvent.click(screen.getByText("Submit Rating"));

    await waitFor(() => {
      expect(mockedAddAgentRating).toHaveBeenCalledWith(
        "agent-001",
        {
          score: 4,
          category: "speed",
          comment: "Fast",
          raterType: "user",
        },
        "test-project",
      );
    });

    expect(addToast).toHaveBeenCalledWith("Rating added", "success");
    expect(mockedFetchAgentRatings).toHaveBeenCalledTimes(2);
    expect(mockedFetchAgentRatingSummary).toHaveBeenCalledTimes(2);
  });

  it("deletes a rating and refreshes rating data", async () => {
    mockedDeleteAgentRating.mockResolvedValue();

    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTitle("Delete rating")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Delete rating"));

    await waitFor(() => {
      expect(mockedDeleteAgentRating).toHaveBeenCalledWith("agent-001", "rating-1", "test-project");
    });

    expect(addToast).toHaveBeenCalledWith("Rating deleted", "success");
  });

  it("refreshes reflections and performance after Reflect Now", async () => {
    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Reflect Now")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Reflect Now"));

    await waitFor(() => {
      expect(mockedTriggerAgentReflection).toHaveBeenCalledWith("agent-001", "test-project");
    });

    expect(addToast).toHaveBeenCalledWith("Reflection generated successfully", "success");
    expect(mockedFetchAgentReflections).toHaveBeenCalledTimes(2);
    expect(mockedFetchAgentPerformance).toHaveBeenCalledTimes(2);
  });

  it("shows not-enough-history toast when Reflect Now returns null", async () => {
    mockedTriggerAgentReflection.mockResolvedValue(null);

    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Reflect Now")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Reflect Now"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Not enough history to generate a reflection yet", "error");
    });
  });

  it("shows error toast when ratings load fails", async () => {
    mockedFetchAgentRatingSummary.mockRejectedValue(new Error("ratings unavailable"));

    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Failed to load ratings"), "error");
    });
  });

  it("shows error toast when add rating fails", async () => {
    mockedAddAgentRating.mockRejectedValue(new Error("save failed"));

    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Submit Rating")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("3 stars"));
    fireEvent.click(screen.getByText("Submit Rating"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Failed to add rating: save failed"), "error");
    });
  });

  it("shows error toast when delete rating fails", async () => {
    mockedDeleteAgentRating.mockRejectedValue(new Error("delete failed"));

    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByTitle("Delete rating")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Delete rating"));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining("Failed to delete rating: delete failed"), "error");
    });
  });

  it("expands and collapses reflection details", async () => {
    render(<AgentReflectionsTab agentId="agent-001" projectId="test-project" addToast={addToast} />);

    await waitFor(() => {
      expect(screen.getByText("Test summary for the reflection")).toBeInTheDocument();
    });

    const card = screen.getByText("Test summary for the reflection").closest(".reflection-card");
    expect(card).toBeInTheDocument();

    fireEvent.click(card!);
    await waitFor(() => {
      expect(screen.getByText("Insights")).toBeInTheDocument();
    });

    fireEvent.click(card!);
    await waitFor(() => {
      expect(screen.queryByText("Insights")).not.toBeInTheDocument();
    });
  });
});

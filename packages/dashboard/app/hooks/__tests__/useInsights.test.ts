/**
 * useInsights Hook Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useInsights, INSIGHT_CATEGORIES } from "../useInsights";

// Mock the API module
vi.mock("../../api", () => ({
  fetchInsights: vi.fn(),
  dismissInsight: vi.fn(),
  triggerInsightRun: vi.fn(),
  fetchInsightRuns: vi.fn(),
  getInsightCreateTaskData: vi.fn(),
}));

// Mock lucide-react icons used in the view
vi.mock("lucide-react", () => ({
  RefreshCw: () => "RefreshCw",
  Play: () => "Play",
  X: () => "X",
  Plus: () => "Plus",
  AlertCircle: () => "AlertCircle",
  CheckCircle: () => "CheckCircle",
  Sparkles: () => "Sparkles",
  Lightbulb: () => "Lightbulb",
  Building: () => "Building",
  Users: () => "Users",
  LineChart: () => "LineChart",
  TrendingUp: () => "TrendingUp",
  MoreVertical: () => "MoreVertical",
  ExternalLink: () => "ExternalLink",
  Archive: () => "Archive",
  Clock: () => "Clock",
  FileText: () => "FileText",
}));

import {
  fetchInsights,
  dismissInsight,
  triggerInsightRun,
  fetchInsightRuns,
  getInsightCreateTaskData,
} from "../../api";

const mockFetchInsights = vi.mocked(fetchInsights);
const mockDismissInsight = vi.mocked(dismissInsight);
const mockTriggerInsightRun = vi.mocked(triggerInsightRun);
const mockFetchInsightRuns = vi.mocked(fetchInsightRuns);
const mockGetInsightCreateTaskData = vi.mocked(getInsightCreateTaskData);

describe("useInsights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initial state", () => {
    it("should start with loading state", async () => {
      mockFetchInsights.mockImplementation(() => new Promise(() => {})); // Never resolves
      mockFetchInsightRuns.mockImplementation(() => new Promise(() => {}));

      const { result } = renderHook(() => useInsights("project-1"));

      expect(result.current.loading).toBe(true);
      expect(result.current.sections).toHaveLength(INSIGHT_CATEGORIES.length);
      expect(result.current.isRunInFlight).toBe(false);
    });

    it("should initialize with all canonical sections", async () => {
      mockFetchInsights.mockResolvedValue({ insights: [], count: 0 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.sections).toHaveLength(INSIGHT_CATEGORIES.length);
      expect(result.current.sections.map((s) => s.category)).toEqual(INSIGHT_CATEGORIES);
    });
  });

  describe("fetching insights", () => {
    it("should fetch and group insights by category", async () => {
      const mockInsights = [
        {
          id: "INS-1",
          projectId: "project-1",
          title: "Feature Insight 1",
          content: "Content 1",
          category: "features",
          status: "generated",
          fingerprint: "fp1",
          provenance: { trigger: "manual" },
          lastRunId: "RUN-1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "INS-2",
          projectId: "project-1",
          title: "Architecture Insight 1",
          content: "Content 2",
          category: "architecture",
          status: "confirmed",
          fingerprint: "fp2",
          provenance: { trigger: "manual" },
          lastRunId: "RUN-1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ];

      mockFetchInsights.mockResolvedValue({ insights: mockInsights, count: 2 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });

      const { result } = renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const featuresSection = result.current.sections.find((s) => s.category === "features");
      const architectureSection = result.current.sections.find((s) => s.category === "architecture");

      expect(featuresSection?.items).toHaveLength(1);
      expect(featuresSection?.items[0].id).toBe("INS-1");

      expect(architectureSection?.items).toHaveLength(1);
      expect(architectureSection?.items[0].id).toBe("INS-2");
    });

    it("should filter out dismissed insights", async () => {
      const mockInsights = [
        {
          id: "INS-1",
          projectId: "project-1",
          title: "Active Insight",
          content: "Content",
          category: "features",
          status: "generated",
          fingerprint: "fp1",
          provenance: { trigger: "manual" },
          lastRunId: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "INS-2",
          projectId: "project-1",
          title: "Dismissed Insight",
          content: "Content",
          category: "features",
          status: "dismissed",
          fingerprint: "fp2",
          provenance: { trigger: "manual" },
          lastRunId: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ];

      mockFetchInsights.mockResolvedValue({ insights: mockInsights, count: 1 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const featuresSection = result.current.sections.find((s) => s.category === "features");
      expect(featuresSection?.items).toHaveLength(1);
      expect(featuresSection?.items[0].id).toBe("INS-1");
    });

    it("should handle fetch errors", async () => {
      mockFetchInsights.mockRejectedValue(new Error("Network error"));
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBe("Network error");
    });
  });

  describe("runInsights", () => {
    it("should trigger manual insight run and refresh when run completes", async () => {
      const completedRun = {
        id: "RUN-1",
        projectId: "project-1",
        trigger: "manual" as const,
        status: "completed" as const,
        summary: "Generated insights",
        error: null,
        insightsCreated: 3,
        insightsUpdated: 1,
        inputMetadata: {},
        outputMetadata: {},
        createdAt: "2024-01-01T00:00:00Z",
        startedAt: "2024-01-01T00:00:10Z",
        completedAt: "2024-01-01T00:01:00Z",
      };

      mockFetchInsights.mockResolvedValue({ insights: [], count: 0 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockTriggerInsightRun.mockResolvedValue(completedRun);

      const { result } = renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.runInsights();
      });

      expect(mockTriggerInsightRun).toHaveBeenCalledWith("manual", undefined, "project-1");
      expect(result.current.latestRun?.status).toBe("completed");
      expect(result.current.isRunInFlight).toBe(false);
      expect(mockFetchInsights.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockFetchInsightRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should surface failed run errors from triggerInsightRun response", async () => {
      const failedRun = {
        id: "RUN-1",
        projectId: "project-1",
        trigger: "manual" as const,
        status: "failed" as const,
        summary: null,
        error: "No working memory to analyze",
        insightsCreated: 0,
        insightsUpdated: 0,
        inputMetadata: {},
        outputMetadata: {},
        createdAt: "2024-01-01T00:00:00Z",
        startedAt: "2024-01-01T00:00:10Z",
        completedAt: "2024-01-01T00:01:00Z",
      };

      mockFetchInsights.mockResolvedValue({ insights: [], count: 0 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockTriggerInsightRun.mockResolvedValue(failedRun);

      const { result } = renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.runInsights();
      });

      expect(result.current.runError).toBe("No working memory to analyze");
      expect(result.current.isRunInFlight).toBe(false);
      // Initial load only; failed run should not trigger refresh.
      expect(mockFetchInsights).toHaveBeenCalledTimes(1);
    });

    it("should propagate trigger errors and always clear in-flight state", async () => {
      mockFetchInsights.mockResolvedValue({ insights: [], count: 0 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockTriggerInsightRun.mockRejectedValue(new Error("Run failed"));

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      let thrown: unknown = null;
      await act(async () => {
        try {
          await result.current.runInsights();
        } catch (error) {
          thrown = error;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("Run failed");
      expect(result.current.runError).toBe("Run failed");
      expect(result.current.isRunInFlight).toBe(false);
    });
  });

  describe("dismiss", () => {
    it("should remove dismissed insight from local state", async () => {
      const mockInsights = [
        {
          id: "INS-1",
          projectId: "project-1",
          title: "Test Insight",
          content: "Content",
          category: "features",
          status: "generated",
          fingerprint: "fp1",
          provenance: { trigger: "manual" },
          lastRunId: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ];

      mockFetchInsights.mockResolvedValue({ insights: mockInsights, count: 1 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockDismissInsight.mockResolvedValue({ ...mockInsights[0], status: "dismissed" });

      const { result } = renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.dismiss("INS-1");
      });

      expect(mockDismissInsight).toHaveBeenCalledWith("INS-1", "project-1");

      const featuresSection = result.current.sections.find((s) => s.category === "features");
      expect(featuresSection?.items).toHaveLength(0);
    });

    it("should set error state on dismiss failure", async () => {
      mockFetchInsights.mockResolvedValue({
        insights: [
          {
            id: "INS-1",
            projectId: "project-1",
            title: "Test",
            content: "Content",
            category: "features",
            status: "generated",
            fingerprint: "fp1",
            provenance: { trigger: "manual" },
            lastRunId: null,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ],
        count: 1,
      });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockDismissInsight.mockRejectedValue(new Error("Dismiss failed"));

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Test that dismiss throws
      await expect(result.current.dismiss("INS-1")).rejects.toThrow("Dismiss failed");
    });
  });

  describe("createTask", () => {
    it("should return task data from insight", async () => {
      const mockInsight = {
        id: "INS-1",
        projectId: "project-1",
        title: "Implement Feature X",
        content: "Detailed description of the feature",
        category: "features" as const,
        status: "generated" as const,
        fingerprint: "fp1",
        provenance: { trigger: "manual" },
        lastRunId: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };

      mockFetchInsights.mockResolvedValue({ insights: [mockInsight], count: 1 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockGetInsightCreateTaskData.mockResolvedValue({
        success: true,
        insight: mockInsight,
        suggestedTitle: "Implement Feature X",
        suggestedDescription: "Detailed description of the feature",
      });

      const { result } = renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      let taskData: { title: string; description: string } | null = null;
      await act(async () => {
        taskData = await result.current.createTask("INS-1");
      });

      expect(mockGetInsightCreateTaskData).toHaveBeenCalledWith("INS-1", "project-1");
      expect(taskData).toEqual({
        title: "Implement Feature X",
        description: "Detailed description of the feature",
      });
    });

    it("should set error state on createTask failure", async () => {
      mockFetchInsights.mockResolvedValue({
        insights: [
          {
            id: "INS-1",
            projectId: "project-1",
            title: "Test",
            content: "Content",
            category: "features",
            status: "generated",
            fingerprint: "fp1",
            provenance: { trigger: "manual" },
            lastRunId: null,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ],
        count: 1,
      });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockGetInsightCreateTaskData.mockRejectedValue(new Error("Create task failed"));

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Test that createTask throws
      await expect(result.current.createTask("INS-1")).rejects.toThrow("Create task failed");
    });
  });

  describe("refresh", () => {
    it("should reload insights data", async () => {
      mockFetchInsights
        .mockResolvedValueOnce({ insights: [], count: 0 })
        .mockResolvedValueOnce({ insights: [], count: 0 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });

      const { result } = renderHook(() => useInsights());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Update mock for refresh
      mockFetchInsights.mockResolvedValueOnce({
        insights: [
          {
            id: "INS-1",
            projectId: "project-1",
            title: "New Insight",
            content: "Content",
            category: "features",
            status: "generated",
            fingerprint: "fp1",
            provenance: { trigger: "manual" },
            lastRunId: null,
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ],
        count: 1,
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockFetchInsights).toHaveBeenCalledTimes(2);
    });
  });
});

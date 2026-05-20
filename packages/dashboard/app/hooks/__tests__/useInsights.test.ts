/**
 * useInsights Hook Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useInsights, INSIGHT_CATEGORIES } from "../useInsights";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";
import type { InsightCategory, InsightStatus } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchInsights: vi.fn(),
  dismissInsight: vi.fn(),
  archiveInsight: vi.fn(),
  unarchiveInsight: vi.fn(),
  triggerInsightRun: vi.fn(),
  fetchInsightRun: vi.fn(),
  fetchInsightRuns: vi.fn(),
  getInsightCreateTaskData: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    details?: Record<string, unknown>;

    constructor(message: string, status: number, details?: Record<string, unknown>) {
      super(message);
      this.name = "ApiRequestError";
      this.status = status;
      this.details = details;
    }
  },
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
  archiveInsight,
  unarchiveInsight,
  triggerInsightRun,
  fetchInsightRun,
  fetchInsightRuns,
  getInsightCreateTaskData,
  ApiRequestError,
} from "../../api";

const mockFetchInsights = vi.mocked(fetchInsights);
const mockDismissInsight = vi.mocked(dismissInsight);
const mockArchiveInsight = vi.mocked(archiveInsight);
const mockUnarchiveInsight = vi.mocked(unarchiveInsight);
const mockTriggerInsightRun = vi.mocked(triggerInsightRun);
const mockFetchInsightRun = vi.mocked(fetchInsightRun);
const mockFetchInsightRuns = vi.mocked(fetchInsightRuns);
const mockGetInsightCreateTaskData = vi.mocked(getInsightCreateTaskData);

describe("useInsights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initial state", () => {
    it("hydrates cached insights without loading", () => {
      localStorage.setItem(
        `${SWR_CACHE_KEYS.INSIGHTS_PREFIX}project-1`,
        JSON.stringify({
          savedAt: Date.now(),
          data: [
            {
              id: "INS-C",
              projectId: "project-1",
              title: "Cached",
              content: "cached",
              category: "features",
              status: "generated",
              fingerprint: "fp-c",
              provenance: { trigger: "manual" },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
        }),
      );
      mockFetchInsights.mockImplementation(() => new Promise(() => {}));
      mockFetchInsightRuns.mockImplementation(() => new Promise(() => {}));

      const { result } = renderHook(() => useInsights("project-1"));

      expect(result.current.loading).toBe(false);
      expect(result.current.totalCount).toBe(1);
    });

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
          category: "features" as InsightCategory,
          status: "generated" as InsightStatus,
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
          category: "architecture" as InsightCategory,
          status: "confirmed" as InsightStatus,
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

      const envelope = JSON.parse(localStorage.getItem(`${SWR_CACHE_KEYS.INSIGHTS_PREFIX}project-1`) ?? "{}");
      expect(envelope).toMatchObject({ savedAt: expect.any(Number) });
      const cached = envelope.data;
      expect(cached?.[0]?.id).toBe("INS-1");
      expect(cached).not.toHaveProperty("dismissStates");
    });

    it("caps persisted insight cache at 500", async () => {
      const oversized = Array.from({ length: 610 }, (_, index) => ({
        id: `INS-${index}`,
        projectId: "project-1",
        title: `Insight ${index}`,
        content: "c",
        category: "features" as InsightCategory,
        status: "generated" as InsightStatus,
        fingerprint: `fp-${index}`,
        provenance: { trigger: "manual" },
        lastRunId: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      }));
      mockFetchInsights.mockResolvedValue({ insights: oversized, count: oversized.length });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });

      renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        const envelope = JSON.parse(localStorage.getItem(`${SWR_CACHE_KEYS.INSIGHTS_PREFIX}project-1`) ?? "{}");
        expect(envelope).toMatchObject({ savedAt: expect.any(Number) });
        const cached = envelope.data;
        expect(cached).toHaveLength(500);
      });
    });

    it("isolates cache by project", () => {
      localStorage.setItem(
        `${SWR_CACHE_KEYS.INSIGHTS_PREFIX}project-1`,
        JSON.stringify({ savedAt: Date.now(), data: [{ id: "INS-P1", projectId: "project-1", title: "P1", content: "", category: "features", status: "generated", fingerprint: "fp1", provenance: { trigger: "manual" }, lastRunId: null, createdAt: "", updatedAt: "" }] }),
      );
      localStorage.setItem(
        `${SWR_CACHE_KEYS.INSIGHTS_PREFIX}project-2`,
        JSON.stringify({ savedAt: Date.now(), data: [{ id: "INS-P2", projectId: "project-2", title: "P2", content: "", category: "features", status: "generated", fingerprint: "fp2", provenance: { trigger: "manual" }, lastRunId: null, createdAt: "", updatedAt: "" }] }),
      );
      mockFetchInsights.mockImplementation(() => new Promise(() => {}));
      mockFetchInsightRuns.mockImplementation(() => new Promise(() => {}));

      const { result, rerender } = renderHook(({ projectId }) => useInsights(projectId), { initialProps: { projectId: "project-1" } });
      expect(result.current.sections.find((s) => s.category === "features")?.items[0]?.id).toBe("INS-P1");
      rerender({ projectId: "project-2" });
      expect(result.current.sections.find((s) => s.category === "features")?.items[0]?.id).toBe("INS-P2");
    });

    it("should filter out dismissed insights", async () => {
      const mockInsights = [
        {
          id: "INS-1",
          projectId: "project-1",
          title: "Active Insight",
          content: "Content",
          category: "features" as InsightCategory,
          status: "generated" as InsightStatus,
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
          category: "features" as InsightCategory,
          status: "dismissed" as InsightStatus,
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
    it("should set latestRun from the newest run returned by fetchInsightRuns during refresh", async () => {
      mockFetchInsights.mockResolvedValue({ insights: [], count: 0 });
      mockFetchInsightRuns.mockResolvedValue({
        runs: [
          {
            id: "RUN-2",
            projectId: "project-1",
            trigger: "manual" as const,
            status: "running" as const,
            summary: null,
            error: null,
            insightsCreated: 0,
            insightsUpdated: 0,
            inputMetadata: {},
            outputMetadata: {},
            createdAt: "2024-01-01T00:00:00Z",
            startedAt: "2024-01-01T00:00:05Z",
            completedAt: null,
          },
          {
            id: "RUN-1",
            projectId: "project-1",
            trigger: "manual" as const,
            status: "completed" as const,
            summary: "done",
            error: null,
            insightsCreated: 1,
            insightsUpdated: 0,
            inputMetadata: {},
            outputMetadata: {},
            createdAt: "2024-01-01T00:00:00Z",
            startedAt: "2024-01-01T00:00:01Z",
            completedAt: "2024-01-01T00:00:10Z",
          },
        ],
      });

      const { result } = renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.latestRun?.id).toBe("RUN-2");
      expect(result.current.latestRun?.status).toBe("running");
    });

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

      expect(mockTriggerInsightRun).toHaveBeenCalledWith("manual", undefined, "project-1", undefined, undefined);
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

    it("should hydrate latestRun and set friendly error on structured active-run conflict", async () => {
      mockFetchInsights.mockResolvedValue({ insights: [], count: 0 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockFetchInsightRun.mockResolvedValue({
        id: "RUN-2",
        projectId: "project-1",
        trigger: "manual",
        status: "running",
        summary: null,
        error: null,
        insightsCreated: 0,
        insightsUpdated: 0,
        inputMetadata: {},
        outputMetadata: {},
        createdAt: "2024-01-01T00:00:00Z",
        startedAt: "2024-01-01T00:00:01Z",
        completedAt: null,
      });
      mockTriggerInsightRun.mockRejectedValue(
        new ApiRequestError("backend raw conflict", 409, {
          code: "ACTIVE_RUN_CONFLICT",
          activeRunId: "RUN-2",
          activeRunStatus: "running",
        }),
      );

      const { result } = renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await expect(result.current.runInsights()).rejects.toBeInstanceOf(Error);
      });

      expect(mockFetchInsightRun).toHaveBeenCalledWith("RUN-2", "project-1");
      expect(result.current.latestRun?.id).toBe("RUN-2");
      expect(result.current.runError).toBe("Insight generation is already running");
      expect(result.current.isRunInFlight).toBe(false);
    });

    it("should clear stale runError on orphan-recovery success path", async () => {
      mockFetchInsights.mockResolvedValue({ insights: [], count: 0 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockTriggerInsightRun
        .mockRejectedValueOnce(new Error("Previous failure"))
        .mockResolvedValueOnce({
          id: "RUN-3",
          projectId: "project-1",
          trigger: "manual",
          status: "completed",
          summary: "Recovered and completed",
          error: null,
          insightsCreated: 1,
          insightsUpdated: 0,
          inputMetadata: {},
          outputMetadata: {},
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
        });

      const { result } = renderHook(() => useInsights("project-1"));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await expect(result.current.runInsights()).rejects.toThrow("Previous failure");
      });
      expect(result.current.runError).toBe("Previous failure");

      await act(async () => {
        await result.current.runInsights();
      });

      expect(result.current.latestRun?.id).toBe("RUN-3");
      expect(result.current.runError).toBeNull();
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
          category: "features" as InsightCategory,
          status: "generated" as InsightStatus,
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
            category: "features" as InsightCategory,
            status: "generated" as InsightStatus,
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
      expect(mockArchiveInsight).toHaveBeenCalledWith("INS-1", "project-1");
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
            category: "features" as InsightCategory,
            status: "generated" as InsightStatus,
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

  describe("archive lifecycle", () => {
    it("archives and unarchives an insight", async () => {
      const insight = {
        id: "INS-1",
        projectId: "project-1",
        title: "Keep me",
        content: "Content",
        category: "features" as InsightCategory,
        status: "confirmed" as InsightStatus,
        fingerprint: "fp1",
        provenance: { trigger: "manual" },
        lastRunId: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      mockFetchInsights.mockResolvedValue({ insights: [insight], count: 1 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });
      mockArchiveInsight.mockResolvedValue({ ...insight, status: "archived" as InsightStatus });
      mockUnarchiveInsight.mockResolvedValue({ ...insight, status: "confirmed" as InsightStatus });

      const { result } = renderHook(() => useInsights("project-1"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.archive("INS-1");
      });
      expect(mockArchiveInsight).toHaveBeenCalledWith("INS-1", "project-1");
      expect(result.current.archivedCount).toBe(1);

      await act(async () => {
        await result.current.unarchive("INS-1");
      });
      expect(mockUnarchiveInsight).toHaveBeenCalledWith("INS-1", "project-1");
      expect(result.current.archivedCount).toBe(0);
    });

    it("toggleShowArchived hides and shows archived insights", async () => {
      const archivedInsight = {
        id: "INS-A",
        projectId: "project-1",
        title: "Archived insight",
        content: "Hidden by default",
        category: "features" as InsightCategory,
        status: "archived" as InsightStatus,
        fingerprint: "fpA",
        provenance: { trigger: "manual" },
        lastRunId: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };
      mockFetchInsights.mockResolvedValue({ insights: [archivedInsight], count: 1 });
      mockFetchInsightRuns.mockResolvedValue({ runs: [] });

      const { result } = renderHook(() => useInsights("project-1"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.archivedCount).toBe(1);
      expect(result.current.totalCount).toBe(0);

      act(() => {
        result.current.toggleShowArchived();
      });

      expect(result.current.showArchived).toBe(true);
      expect(result.current.totalCount).toBe(1);
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
            category: "features" as InsightCategory,
            status: "generated" as InsightStatus,
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

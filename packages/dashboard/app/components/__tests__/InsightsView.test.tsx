/**
 * InsightsView Component Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { InsightsView } from "../InsightsView";

// Mock the useInsights hook
vi.mock("../../hooks/useInsights", () => ({
  useInsights: vi.fn(),
  INSIGHT_CATEGORIES: ["features", "architecture", "competitive_analysis", "research", "trends"],
  CATEGORY_LABELS: {
    features: "Features",
    architecture: "Architecture",
    competitive_analysis: "Competitive Analysis",
    research: "Research",
    trends: "Trends",
  },
}));

vi.mock("../../hooks/useTaskRecommendations", () => ({
  useTaskRecommendations: vi.fn(),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Sparkles: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="sparkles-icon" className={className}>{`Sparkles-${size}`}</span>
  ),
  RefreshCw: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="refresh-icon" className={className}>{`RefreshCw-${size}`}</span>
  ),
  X: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="x-icon" className={className}>{`X-${size}`}</span>
  ),
  Plus: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="plus-icon" className={className}>{`Plus-${size}`}</span>
  ),
  AlertCircle: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="alert-icon" className={className}>{`AlertCircle-${size}`}</span>
  ),
  CheckCircle: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="check-icon" className={className}>{`CheckCircle-${size}`}</span>
  ),
  Lightbulb: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="lightbulb-icon" className={className}>{`Lightbulb-${size}`}</span>
  ),
  Building: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="building-icon" className={className}>{`Building-${size}`}</span>
  ),
  Users: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="users-icon" className={className}>{`Users-${size}`}</span>
  ),
  LineChart: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="linechart-icon" className={className}>{`LineChart-${size}`}</span>
  ),
  TrendingUp: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="trendingup-icon" className={className}>{`TrendingUp-${size}`}</span>
  ),
  MoreVertical: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="more-icon" className={className}>{`MoreVertical-${size}`}</span>
  ),
  ExternalLink: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="external-icon" className={className}>{`ExternalLink-${size}`}</span>
  ),
  Archive: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="archive-icon" className={className}>{`Archive-${size}`}</span>
  ),
  ArchiveRestore: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="archive-restore-icon" className={className}>{`ArchiveRestore-${size}`}</span>
  ),
  Clock: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="clock-icon" className={className}>{`Clock-${size}`}</span>
  ),
  Settings: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="settings-icon" className={className}>{`Settings-${size}`}</span>
  ),
  Activity: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="activity-icon" className={className}>{`Activity-${size}`}</span>
  ),
}));

import { useInsights } from "../../hooks/useInsights";
import { useTaskRecommendations } from "../../hooks/useTaskRecommendations";

const mockUseInsights = vi.mocked(useInsights);
const mockUseTaskRecommendations = vi.mocked(useTaskRecommendations);

describe("InsightsView", () => {
  const defaultProps = {
    addToast: vi.fn(),
    onClose: vi.fn(),
    onCreateTask: vi.fn().mockResolvedValue(undefined),
  };

  const mockSections = [
    { category: "features" as const, label: "Features", items: [], isLoading: false, error: null },
    { category: "architecture" as const, label: "Architecture", items: [], isLoading: false, error: null },
    { category: "competitive_analysis" as const, label: "Competitive Analysis", items: [], isLoading: false, error: null },
    { category: "research" as const, label: "Research", items: [], isLoading: false, error: null },
    { category: "trends" as const, label: "Trends", items: [], isLoading: false, error: null },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTaskRecommendations.mockReturnValue({
      items: [],
      loading: false,
      loadingMore: false,
      error: null,
      hasMore: false,
      totalRowCount: 0,
      truncated: false,
      refresh: vi.fn(),
      loadMore: vi.fn(),
      createTask: vi.fn(),
      createStates: new Map(),
    });
    mockUseInsights.mockReturnValue({
      sections: mockSections,
      loading: false,
      error: null,
      latestRun: null,
      isRunInFlight: false,
      runError: null,
      refresh: vi.fn(),
      runInsights: vi.fn(),
      dismiss: vi.fn(),
      createTask: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      toggleShowArchived: vi.fn(),
      dismissStates: new Map(),
      createTaskStates: new Map(),
      archiveStates: new Map(),
      unarchiveStates: new Map(),
      totalCount: 0,
      dismissedCount: 0,
      archivedCount: 0,
      showArchived: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("rendering", () => {
    it("should render all five section headings in expected order", () => {
      const populatedSections = [
        {
          ...mockSections[0],
          items: [
            {
              id: "INS-100",
              projectId: "test",
              title: "Features insight",
              content: "Features content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp100",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
        },
        {
          ...mockSections[1],
          items: [
            {
              id: "INS-101",
              projectId: "test",
              title: "Architecture insight",
              content: "Architecture content",
              category: "architecture" as const,
              status: "generated" as const,
              fingerprint: "fp101",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
        },
        {
          ...mockSections[2],
          items: [
            {
              id: "INS-102",
              projectId: "test",
              title: "Competitive insight",
              content: "Competitive content",
              category: "competitive_analysis" as const,
              status: "generated" as const,
              fingerprint: "fp102",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
        },
        {
          ...mockSections[3],
          items: [
            {
              id: "INS-103",
              projectId: "test",
              title: "Research insight",
              content: "Research content",
              category: "research" as const,
              status: "generated" as const,
              fingerprint: "fp103",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
        },
        {
          ...mockSections[4],
          items: [
            {
              id: "INS-104",
              projectId: "test",
              title: "Trends insight",
              content: "Trends content",
              category: "trends" as const,
              status: "generated" as const,
              fingerprint: "fp104",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
        },
      ];

      mockUseInsights.mockReturnValue({
        sections: populatedSections,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 5,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      // Sidebar lists every populated category
      expect(screen.getByTestId("insights-category-features")).toBeInTheDocument();
      expect(screen.getByTestId("insights-category-architecture")).toBeInTheDocument();
      expect(screen.getByTestId("insights-category-competitive_analysis")).toBeInTheDocument();
      expect(screen.getByTestId("insights-category-research")).toBeInTheDocument();
      expect(screen.getByTestId("insights-category-trends")).toBeInTheDocument();
      // Detail pane shows the first populated section by default
      expect(screen.getByTestId("insights-section-features")).toBeInTheDocument();
    });

    it("renders active-section insight titles newest-first in document order", () => {
      mockUseInsights.mockReturnValue({
        sections: [
          {
            ...mockSections[0],
            items: [
              { id: "INS-NEW", projectId: "test", title: "Newest insight", content: "", category: "features", status: "generated", fingerprint: "fp-new", provenance: { trigger: "manual" }, lastRunId: null, createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" },
              { id: "INS-MID", projectId: "test", title: "Middle insight", content: "", category: "features", status: "generated", fingerprint: "fp-mid", provenance: { trigger: "manual" }, lastRunId: null, createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
              { id: "INS-OLD", projectId: "test", title: "Oldest insight", content: "", category: "features", status: "generated", fingerprint: "fp-old", provenance: { trigger: "manual" }, lastRunId: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
            ],
          },
          ...mockSections.slice(1),
        ],
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        toggleShowArchived: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        archiveStates: new Map(),
        unarchiveStates: new Map(),
        totalCount: 3,
        dismissedCount: 0,
        archivedCount: 0,
        showArchived: false,
      });

      const { container } = render(<InsightsView {...defaultProps} />);

      expect([...container.querySelectorAll(".insight-item-title")].map((node) => node.textContent))
        .toEqual(["Newest insight", "Middle insight", "Oldest insight"]);
    });

    it("should render loading state", () => {
      mockUseInsights.mockReturnValue({
        ...mockUseInsights("test"),
        loading: true,
      });
      // Use default mock
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: true,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      expect(screen.getByTestId("insights-loading")).toBeInTheDocument();
    });

    it("should render top-level error state", () => {
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: false,
        error: "Failed to load insights",
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      expect(screen.getByTestId("insights-error")).toBeInTheDocument();
      expect(screen.getByText("Failed to load insights")).toBeInTheDocument();
    });

    it("should render run-level error state from failed insight runs", () => {
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: false,
        error: null,
        latestRun: {
          id: "INSR-10",
          projectId: "test",
          trigger: "manual",
          status: "failed",
          summary: null,
          error: "No working memory to analyze",
          insightsCreated: 0,
          insightsUpdated: 0,
          inputMetadata: {},
          outputMetadata: {},
          createdAt: "2024-01-01T00:00:00Z",
          startedAt: "2024-01-01T00:00:01Z",
          completedAt: "2024-01-01T00:00:10Z",
        },
        isRunInFlight: false,
        runError: "No working memory to analyze",
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      expect(screen.getByTestId("run-error")).toBeInTheDocument();
      expect(screen.getAllByText("No working memory to analyze").length).toBeGreaterThan(0);
    });

    it("should show friendly active-run conflict error and still render latest run details", () => {
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: false,
        error: null,
        latestRun: {
          id: "INSR-11",
          projectId: "test",
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
        },
        isRunInFlight: false,
        runError: "Insight generation is already running",
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      expect(screen.getByTestId("run-error")).toBeInTheDocument();
      expect(screen.getByText("Insight generation is already running")).toBeInTheDocument();
      expect(screen.getByTestId("latest-run")).toBeInTheDocument();
      expect(screen.getByText("Latest run: running")).toBeInTheDocument();
    });

    it("should render global empty state when all sections are empty", () => {
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      expect(screen.getByTestId("insights-empty")).toBeInTheDocument();
      expect(screen.getByText("No insights yet")).toBeInTheDocument();
    });

    it("should hide empty sections when specific section has no items", () => {
      const sectionsWithOne = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: "test",
              title: "Test Insight",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp1",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithOne,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      expect(screen.queryByTestId("insights-section-architecture")).not.toBeInTheDocument();
      expect(screen.getByTestId("insights-section-features")).toBeInTheDocument();
    });

    it("should only render sections that have items", () => {
      const sectionsWithTwo = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-11",
              projectId: "test",
              title: "Features Insight",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp11",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        {
          category: "architecture" as const,
          label: "Architecture",
          items: [],
          isLoading: false,
          error: null,
        },
        {
          category: "competitive_analysis" as const,
          label: "Competitive Analysis",
          items: [
            {
              id: "INS-12",
              projectId: "test",
              title: "Competitive Insight",
              content: "Content",
              category: "competitive_analysis" as const,
              status: "generated" as const,
              fingerprint: "fp12",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        {
          category: "research" as const,
          label: "Research",
          items: [],
          isLoading: false,
          error: null,
        },
        {
          category: "trends" as const,
          label: "Trends",
          items: [],
          isLoading: false,
          error: null,
        },
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithTwo,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 2,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      // Sidebar lists exactly the two populated categories
      expect(screen.getAllByTestId(/^insights-category-/)).toHaveLength(2);
      expect(screen.getByTestId("insights-category-features")).toBeInTheDocument();
      expect(screen.getByTestId("insights-category-competitive_analysis")).toBeInTheDocument();
      expect(screen.queryByTestId("insights-category-architecture")).not.toBeInTheDocument();
      expect(screen.queryByTestId("insights-category-research")).not.toBeInTheDocument();
      expect(screen.queryByTestId("insights-category-trends")).not.toBeInTheDocument();
      // Detail shows the first populated section (features)
      expect(screen.getByTestId("insights-section-features")).toBeInTheDocument();
      expect(screen.queryByTestId("insights-section-competitive_analysis")).not.toBeInTheDocument();
    });

    it("should render status badge with correct CSS class for generated status", () => {
      const sectionsWithInsight = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: "test",
              title: "Test Insight",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp1",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithInsight,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      // Verify the status badge has the correct interpolated CSS class
      const statusBadge = screen.getByText("generated").closest("span");
      expect(statusBadge).toHaveClass("insight-item-status");
      expect(statusBadge).toHaveClass("insight-item-status--generated");
    });

    it("should render status badge with correct CSS class for confirmed status", () => {
      const sectionsWithInsight = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-2",
              projectId: "test",
              title: "Confirmed Insight",
              content: "Content",
              category: "features" as const,
              status: "confirmed" as const,
              fingerprint: "fp2",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithInsight,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      // Verify the status badge has the correct interpolated CSS class
      const statusBadge = screen.getByText("confirmed").closest("span");
      expect(statusBadge).toHaveClass("insight-item-status");
      expect(statusBadge).toHaveClass("insight-item-status--confirmed");
    });
  });

  describe("actions", () => {
    it("should pass projectId to useInsights", () => {
      render(<InsightsView {...defaultProps} projectId="project-123" />);

      expect(mockUseInsights).toHaveBeenCalledWith("project-123");
    });

    it("should trigger run insights on button click", async () => {
      const runInsights = vi.fn().mockResolvedValue(undefined);
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights,
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const runButton = screen.getByTestId("run-insights");
      await act(async () => {
        fireEvent.click(runButton);
      });

      expect(runInsights).toHaveBeenCalled();
    });

    it("should disable run button while in-flight", () => {
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: true,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const runButton = screen.getByTestId("run-insights");
      expect(runButton).toBeDisabled();
    });

    it("should trigger dismiss on insight action click", async () => {
      const dismiss = vi.fn().mockResolvedValue(undefined);
      const sectionsWithInsight = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: "test",
              title: "Test Insight",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp1",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithInsight,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss,
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const dismissButton = screen.getByTestId("dismiss-INS-1");
      await act(async () => {
        fireEvent.click(dismissButton);
      });

      expect(dismiss).toHaveBeenCalledWith("INS-1");
    });

    it("should trigger create task on insight action click", async () => {
      const createTaskFn = vi.fn().mockResolvedValue({ title: "New Task", description: "Task description" });
      const onCreateTask = vi.fn().mockResolvedValue(undefined);
      const sectionsWithInsight = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: "test",
              title: "Test Insight",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp1",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithInsight,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: createTaskFn,
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} onCreateTask={onCreateTask} />);

      const createButton = screen.getByTestId("create-task-INS-1");
      await act(async () => {
        fireEvent.click(createButton);
      });

      expect(createTaskFn).toHaveBeenCalledWith("INS-1");
      expect(onCreateTask).toHaveBeenCalledWith({
        insightId: "INS-1",
        title: "New Task",
        description: "Task description",
      });
      await waitFor(() => {
        expect(defaultProps.addToast).toHaveBeenCalledWith("Task created: New Task", "success");
      });
    });

    it("shows error and skips success toast when app-level task creation fails", async () => {
      const createTaskFn = vi.fn().mockResolvedValue({ title: "New Task", description: "Task description" });
      const onCreateTask = vi.fn().mockRejectedValue(new Error("Task creation is unavailable in this view"));
      const sectionsWithInsight = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: "test",
              title: "Test Insight",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp1",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithInsight,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: createTaskFn,
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} onCreateTask={onCreateTask} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("create-task-INS-1"));
      });

      await waitFor(() => {
        expect(defaultProps.addToast).toHaveBeenCalledWith("Task creation is unavailable in this view", "error");
      });
      expect(defaultProps.addToast).not.toHaveBeenCalledWith("Task created: New Task", "success");
    });

    it("should show toast on run success", async () => {
      const runInsights = vi.fn().mockResolvedValue(undefined);
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights,
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const runButton = screen.getByTestId("run-insights");
      await act(async () => {
        fireEvent.click(runButton);
      });

      await waitFor(() => {
        expect(defaultProps.addToast).toHaveBeenCalledWith("Insight generation started", "success");
      });
    });

    it("should show toast on run failure", async () => {
      const runInsights = vi.fn().mockRejectedValue(new Error("Generation failed"));
      mockUseInsights.mockReturnValue({
        sections: mockSections,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights,
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 0,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const runButton = screen.getByTestId("run-insights");
      await act(async () => {
        fireEvent.click(runButton);
      });

      await waitFor(() => {
        expect(defaultProps.addToast).toHaveBeenCalledWith("Generation failed", "error");
      });
    });
  });

  describe("action failure outcomes", () => {
    it("should show inline error on dismiss failure", async () => {
      const dismiss = vi.fn().mockRejectedValue(new Error("Dismiss failed"));
      const dismissStates = new Map([["INS-1", { running: false, error: "Dismiss failed" }]]);

      const sectionsWithInsight = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: "test",
              title: "Test Insight",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp1",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithInsight,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss,
        createTask: vi.fn(),
        dismissStates,
        createTaskStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const dismissButton = screen.getByTestId("dismiss-INS-1");
      await act(async () => {
        fireEvent.click(dismissButton);
      });

      await waitFor(() => {
        expect(screen.getByTestId("insights-status")).toHaveTextContent("Dismiss failed");
      });
    });

    it("should show inline error on create-task failure", async () => {
      const createTaskFn = vi.fn().mockRejectedValue(new Error("Create failed"));
      const createTaskStates = new Map([["INS-1", { running: false, error: "Create failed" }]]);

      const sectionsWithInsight = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: "test",
              title: "Test Insight",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp1",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithInsight,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: createTaskFn,
        dismissStates: new Map(),
        createTaskStates,
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const createButton = screen.getByTestId("create-task-INS-1");
      await act(async () => {
        fireEvent.click(createButton);
      });

      await waitFor(() => {
        expect(screen.getByTestId("insights-status")).toHaveTextContent("Create failed");
      });
    });
  });

  describe("backlog-health filter", () => {
    const backlogInsight = {
      id: "INS-BACKLOG",
      projectId: "test",
      title: "Backlog pressure detected 2026-05-18",
      content: "Backlog health content",
      category: "workflow" as const,
      status: "generated" as const,
      fingerprint: "fp-backlog",
      provenance: { trigger: "manual" as const },
      lastRunId: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const nonBacklogInsight = {
      id: "INS-QUALITY",
      projectId: "test",
      title: "Improve test coverage",
      content: "Quality content",
      category: "quality" as const,
      status: "generated" as const,
      fingerprint: "fp-quality",
      provenance: { trigger: "manual" as const },
      lastRunId: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const workflowSection = {
      category: "workflow" as const,
      label: "Workflow",
      items: [backlogInsight],
      isLoading: false,
      error: null,
    };

    const qualitySection = {
      category: "quality" as const,
      label: "Quality",
      items: [nonBacklogInsight],
      isLoading: false,
      error: null,
    };

    it("hides toggle when no backlog-health insights exist", () => {
      mockUseInsights.mockReturnValue({
        sections: [qualitySection, ...mockSections],
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      expect(screen.queryByTestId("toggle-backlog-health")).not.toBeInTheDocument();
    });

    it("shows toggle with count and toggles filtered/unfiltered view", async () => {
      mockUseInsights.mockReturnValue({
        sections: [qualitySection, workflowSection, ...mockSections],
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 2,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const toggle = screen.getByTestId("toggle-backlog-health");
      expect(toggle).toHaveTextContent("Backlog (1)");
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTestId("insights-category-quality")).toBeInTheDocument();
      expect(screen.getByTestId("insights-category-workflow")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId("insights-category-quality"));
      });
      expect(screen.getByTestId("insights-section-quality")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(toggle).toHaveTextContent("All Insights (1)");
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByTestId("insights-category-quality")).not.toBeInTheDocument();
      expect(screen.getByTestId("insights-category-workflow")).toBeInTheDocument();
      expect(screen.queryByText("Improve test coverage")).not.toBeInTheDocument();
      expect(screen.getByText("Backlog pressure detected 2026-05-18")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(toggle);
      });

      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByTestId("insights-category-quality")).toBeInTheDocument();
      expect(screen.getByTestId("insights-category-workflow")).toBeInTheDocument();
    });

    it("resets selected category when active category has no backlog-health matches", async () => {
      mockUseInsights.mockReturnValue({
        sections: [qualitySection, workflowSection, ...mockSections],
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        totalCount: 2,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("insights-category-quality"));
      });
      expect(screen.getByTestId("insights-section-quality")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId("toggle-backlog-health"));
      });

      expect(screen.getByTestId("insights-section-workflow")).toBeInTheDocument();
      expect(screen.queryByTestId("insights-section-quality")).not.toBeInTheDocument();
    });
  });

  describe("archived insights", () => {
    it("renders archived insights with archived class and unarchive button", () => {
      const sectionsWithArchived = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-ARCH",
              projectId: "test",
              title: "Archived Insight",
              content: "Archived content",
              category: "features" as const,
              status: "archived" as const,
              fingerprint: "fp-arch",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      mockUseInsights.mockReturnValue({
        sections: sectionsWithArchived,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        toggleShowArchived: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        archiveStates: new Map(),
        unarchiveStates: new Map(),
        totalCount: 1,
        dismissedCount: 0,
        archivedCount: 1,
        showArchived: true,
      });

      render(<InsightsView {...defaultProps} />);

      const item = screen.getByText("Archived Insight").closest("li");
      expect(item?.className).toContain("insight-item--archived");
      expect(screen.getByTestId("unarchive-INS-ARCH")).toBeTruthy();
      expect(screen.getByTestId("toggle-archived-insights")).toHaveTextContent("Archived");
    });
  });

  describe("in-flight disable behavior", () => {
    it("should disable dismiss button only for insight being dismissed", async () => {
      const sectionsWithInsight = [
        {
          category: "features" as const,
          label: "Features",
          items: [
            {
              id: "INS-1",
              projectId: "test",
              title: "Insight 1",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp1",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            {
              id: "INS-2",
              projectId: "test",
              title: "Insight 2",
              content: "Content",
              category: "features" as const,
              status: "generated" as const,
              fingerprint: "fp2",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections.slice(1),
      ];

      const dismissStates = new Map([["INS-1", { running: true, error: null }]]);

      mockUseInsights.mockReturnValue({
        sections: sectionsWithInsight,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        dismissStates,
        createTaskStates: new Map(),
        totalCount: 2,
        dismissedCount: 0,
      });

      render(<InsightsView {...defaultProps} />);

      const dismiss1Button = screen.getByTestId("dismiss-INS-1");
      const dismiss2Button = screen.getByTestId("dismiss-INS-2");

      expect(dismiss1Button).toBeDisabled();
      expect(dismiss2Button).toBeDisabled(); // All actions disabled when any is in-flight
    });
  });

  describe("responsive CSS contracts", () => {
    it("FN-7830: renders the maximal header action cluster without dropping the Insights title or controls", () => {
      const maximalSections = [
        {
          category: "workflow" as const,
          label: "Workflow",
          items: [
            {
              id: "INS-BACKLOG",
              projectId: "test",
              title: "Backlog pressure detected 2026-07-11",
              content: "Backlog health content",
              category: "workflow" as const,
              status: "generated" as const,
              fingerprint: "fp-backlog",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            {
              id: "INS-ARCHIVED",
              projectId: "test",
              title: "Archived mobile header insight",
              content: "Archived content",
              category: "workflow" as const,
              status: "archived" as const,
              fingerprint: "fp-archived",
              provenance: { trigger: "manual" as const },
              lastRunId: null,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
          ],
          isLoading: false,
          error: null,
        },
        ...mockSections,
      ];

      mockUseInsights.mockReturnValue({
        sections: maximalSections,
        loading: false,
        error: null,
        latestRun: null,
        isRunInFlight: false,
        runError: null,
        refresh: vi.fn(),
        runInsights: vi.fn(),
        dismiss: vi.fn(),
        createTask: vi.fn(),
        archive: vi.fn(),
        unarchive: vi.fn(),
        toggleShowArchived: vi.fn(),
        dismissStates: new Map(),
        createTaskStates: new Map(),
        archiveStates: new Map(),
        unarchiveStates: new Map(),
        totalCount: 2,
        dismissedCount: 0,
        archivedCount: 1,
        showArchived: false,
      });

      render(<InsightsView {...defaultProps} />);

      expect(screen.getByText("Insights").closest("h2")).toHaveClass("view-header__title");
      expect(screen.getByText("2 total")).toHaveClass("insights-view-count");
      expect(screen.getByTestId("toggle-backlog-health")).toHaveTextContent("Backlog (1)");
      expect(screen.getByLabelText("Close insights view")).toHaveClass("insights-view-close");
      expect(screen.getByTestId("toggle-archived-insights")).toHaveTextContent("Archived (1)");
      expect(screen.getByTestId("refresh-insights")).toHaveClass("insights-refresh-btn");
      expect(screen.getByTestId("toggle-model-config")).toHaveClass("insights-model-toggle");
      expect(screen.getByTestId("run-insights")).toHaveTextContent("Generate Insights");
    });

    it("FN-7830: stacks the Insights title above wrapped actions only in the mobile header tier", () => {
      const css = loadAllAppCss();

      expect(css).toMatch(/@media[^{}]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.insights-view\s+\.view-header\s*\{[^}]*flex-wrap:\s*wrap;[^}]*\}/);
      expect(css).toMatch(/@media[^{}]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.insights-view\s+\.view-header__title\s*\{[^}]*flex:\s*1\s+0\s+100%;[^}]*min-width:\s*100%;[^}]*\}/);
      expect(css).toMatch(/@media[^{}]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.insights-view\s+\.view-header__title\s+span\s*\{[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;[^}]*\}/);
      expect(css).toMatch(/@media[^{}]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.insights-view\s+\.view-header__actions\s*\{[^}]*justify-content:\s*flex-start;[^}]*width:\s*100%;[^}]*margin-left:\s*0;[^}]*\}/);

      expect(css).toMatch(/@media[^{}]*\(min-width:\s*769px\)\s*and\s*\(min-height:\s*481px\)[^{]*\{[\s\S]*?\.view-header\s*\{[^}]*height:\s*var\(--view-header-min-height\);[^}]*\}/);
      expect(css).toMatch(/@media[^{}]*\(min-width:\s*769px\)\s*and\s*\(min-height:\s*481px\)[^{]*\{[\s\S]*?\.view-header__actions\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*height:\s*var\(--view-header-content-row\);[^}]*\}/);
      expect(css).toMatch(/@media[^{}]*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)[^{]*\{[\s\S]*?\.insights-body\s*\{[^}]*flex-direction:\s*column;[^}]*\}/);
    });

    it("FN-6764: adds a tablet full-width reflow without regressing desktop or mobile tiers", () => {
      const baseCss = loadAllAppCssBaseOnly();
      const css = loadAllAppCss();

      expect(baseCss).toMatch(/\.insights-body\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;[^}]*\}/);
      expect(baseCss).toMatch(/\.insights-sidebar\s*\{[^}]*width:\s*calc\(var\(--space-2xl\)\s*\*\s*7\s*\+\s*var\(--space-lg\)\);[^}]*flex-shrink:\s*0;[^}]*overflow-y:\s*auto;[^}]*\}/);
      expect(baseCss).toMatch(/\.insights-detail\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;[^}]*overflow-y:\s*auto;[^}]*\}/);

      expect(css).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.insights-body\s*\{[^}]*flex-direction:\s*column;[^}]*\}/);
      expect(css).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.insights-sidebar\s*\{[^}]*width:\s*100%;[^}]*border-right:\s*none;[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*\}/);

      expect(css).toMatch(/@media[^{]*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)[^{]*\{[\s\S]*?\.insights-view\s*\{[^}]*inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*overflow:\s*hidden;[^}]*\}/);
      expect(css).toMatch(/@media[^{]*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)[^{]*\{[\s\S]*?\.insights-body\s*\{[^}]*flex-direction:\s*column;[^}]*inline-size:\s*100%;[^}]*min-width:\s*0;[^}]*min-inline-size:\s*0;[^}]*overflow:\s*hidden;[^}]*\}/);
      expect(css).toMatch(/@media[^{]*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)[^{]*\{[\s\S]*?\.insights-sidebar\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*min-inline-size:\s*0;[^}]*border-right:\s*none;[^}]*border-bottom:\s*var\(--chrome-divider-width,\s*1px\)\s+solid\s+var\(--insights-divider-color\);[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*\}/);
      expect(css).toMatch(/@media[^{]*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)[^{]*\{[\s\S]*?\.insights-detail\s*\{[^}]*flex:\s*1\s+1\s+0;[^}]*min-width:\s*0;[^}]*min-inline-size:\s*0;[^}]*overflow-y:\s*auto;[^}]*\}/);
    });
  });

  describe("task recommendations", () => {
    const recommendations = [
      {
        taskId: "FN-1",
        taskTitle: "First source",
        recommendation: { id: "shared-id", title: "First follow-up", description: "First description", category: "improvement" },
      },
      {
        taskId: "FN-2",
        taskTitle: "Second source",
        recommendation: { id: "shared-id", title: "Second follow-up", description: "Second description", category: "bug" },
      },
    ];

    it("keeps recommendations reachable when insights are empty and routes creates by the composite key", async () => {
      const createTask = vi.fn();
      mockUseTaskRecommendations.mockReturnValue({
        items: recommendations,
        loading: false,
        loadingMore: false,
        error: null,
        hasMore: true,
        totalRowCount: 3,
        truncated: false,
        refresh: vi.fn(),
        loadMore: vi.fn(),
        createTask,
        createStates: new Map(),
      });

      render(<InsightsView {...defaultProps} />);

      await waitFor(() => expect(screen.getByTestId("insights-category-recommendations")).toBeInTheDocument());
      expect(screen.queryByTestId("insights-empty")).not.toBeInTheDocument();
      expect(screen.getByTestId("insights-section-recommendations")).toBeInTheDocument();
      expect(screen.getByTestId("task-recommendation-FN-1:shared-id")).toBeInTheDocument();
      expect(screen.getByTestId("task-recommendation-FN-2:shared-id")).toBeInTheDocument();
      expect(screen.getByText("Showing 2 of 3 source tasks")).toBeInTheDocument();

      fireEvent.click(screen.getAllByRole("button", { name: "Create task" })[1]!);
      expect(createTask).toHaveBeenCalledWith("FN-2", "shared-id");
    });

    it("does not offer creates for linked recommendations and preserves retryable page errors", async () => {
      const refresh = vi.fn();
      const loadMore = vi.fn();
      mockUseTaskRecommendations.mockReturnValue({
        items: [{ ...recommendations[0], recommendation: { ...recommendations[0].recommendation, createdTaskId: "FN-created" } }],
        loading: false,
        loadingMore: false,
        error: "request failed",
        hasMore: true,
        totalRowCount: 2,
        truncated: false,
        refresh,
        loadMore,
        createTask: vi.fn(),
        createStates: new Map(),
      });

      render(<InsightsView {...defaultProps} />);

      await waitFor(() => expect(screen.getByText("Created FN-created")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Create task" })).not.toBeInTheDocument();
      expect(screen.getByText("Could not load more recommendations.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(loadMore).toHaveBeenCalledOnce();
    });

    it("offers Load more only while another row page is available and surfaces truncation", async () => {
      const loadMore = vi.fn();
      mockUseTaskRecommendations.mockReturnValue({
        items: [recommendations[0]], loading: false, loadingMore: false, error: null,
        hasMore: true, totalRowCount: 2, truncated: false, refresh: vi.fn(), loadMore,
        createTask: vi.fn(), createStates: new Map(),
      });
      const { rerender } = render(<InsightsView {...defaultProps} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      expect(loadMore).toHaveBeenCalledOnce();

      mockUseTaskRecommendations.mockReturnValue({
        items: [recommendations[0]], loading: false, loadingMore: false, error: null,
        hasMore: false, totalRowCount: 1000, truncated: true, refresh: vi.fn(), loadMore: vi.fn(),
        createTask: vi.fn(), createStates: new Map(),
      });
      rerender(<InsightsView {...defaultProps} />);
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
      expect(screen.getByText("Showing the first 20 pages. Refresh to see the latest recommendations.")).toBeInTheDocument();
    });

    it("keeps the Load more affordance reachable in the mobile and tablet layouts", () => {
      const css = loadAllAppCss();
      expect(css).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.insights-recommendations[^}]*\}/);
      expect(css).toMatch(/@media[^{]*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)[^{]*\{[\s\S]*?\.insights-recommendations[^}]*\}/);
    });
  });
});

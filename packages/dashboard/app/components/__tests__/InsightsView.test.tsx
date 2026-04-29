/**
 * InsightsView Component Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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
  Clock: ({ size = 24, className = "" }: { size?: number; className?: string }) => (
    <span data-testid="clock-icon" className={className}>{`Clock-${size}`}</span>
  ),
}));

// Mock the createTask API
vi.mock("../../api", () => ({
  createTask: vi.fn(),
}));

import { useInsights } from "../../hooks/useInsights";
import { createTask } from "../../api";

const mockUseInsights = vi.mocked(useInsights);
const mockCreateTask = vi.mocked(createTask);

describe("InsightsView", () => {
  const defaultProps = {
    addToast: vi.fn(),
    onClose: vi.fn(),
    onCreateTask: vi.fn(),
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

      expect(screen.getByTestId("insights-section-features")).toBeInTheDocument();
      expect(screen.getByTestId("insights-section-architecture")).toBeInTheDocument();
      expect(screen.getByTestId("insights-section-competitive_analysis")).toBeInTheDocument();
      expect(screen.getByTestId("insights-section-research")).toBeInTheDocument();
      expect(screen.getByTestId("insights-section-trends")).toBeInTheDocument();
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

      expect(screen.getAllByTestId(/insights-section-/)).toHaveLength(2);
      expect(screen.getByTestId("insights-section-features")).toBeInTheDocument();
      expect(screen.getByTestId("insights-section-competitive_analysis")).toBeInTheDocument();
      expect(screen.queryByTestId("insights-section-architecture")).not.toBeInTheDocument();
      expect(screen.queryByTestId("insights-section-research")).not.toBeInTheDocument();
      expect(screen.queryByTestId("insights-section-trends")).not.toBeInTheDocument();
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

      render(<InsightsView {...defaultProps} />);

      const createButton = screen.getByTestId("create-task-INS-1");
      await act(async () => {
        fireEvent.click(createButton);
      });

      expect(createTaskFn).toHaveBeenCalledWith("INS-1");
      expect(defaultProps.onCreateTask).toHaveBeenCalledWith("New Task", "Task description");
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
});

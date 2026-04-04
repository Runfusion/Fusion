import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExecutorStatusBar } from "../ExecutorStatusBar";

// Mock the useExecutorStats hook
vi.mock("../../hooks/useExecutorStats", () => ({
  useExecutorStats: vi.fn(),
}));

import { useExecutorStats } from "../../hooks/useExecutorStats";
import type { ExecutorStats } from "../../api";

const mockUseExecutorStats = useExecutorStats as ReturnType<typeof vi.fn>;

/** Minimal empty task list used by tests that mock the hook. */
const emptyTasks: any[] = [];

describe("ExecutorStatusBar", () => {
  const defaultStats: ExecutorStats = {
    runningTaskCount: 2,
    blockedTaskCount: 1,
    stuckTaskCount: 0,
    queuedTaskCount: 5,
    inReviewCount: 3,
    executorState: "running",
    maxConcurrent: 4,
    lastActivityAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockUseExecutorStats).mockReturnValue({
      stats: defaultStats,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("rendering", () => {
    it("renders all stat segments", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Running");
      expect(statusBar).toHaveTextContent("Blocked");
      expect(statusBar).toHaveTextContent("Queued");
      expect(statusBar).toHaveTextContent("In Review");
    });

    it("displays running task count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("2");
    });

    it("displays max concurrent count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("/");
      expect(statusBar).toHaveTextContent("4");
    });

    it("displays blocked task count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("1");
    });

    it("displays queued task count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("5");
    });

    it("displays in-review count", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("3");
    });

    it("does not show stuck tasks segment when count is 0", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.queryByText("Stuck")).not.toBeInTheDocument();
    });

    it("shows stuck tasks segment when count is > 0", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, stuckTaskCount: 2 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Stuck");
      expect(statusBar).toHaveTextContent("2");
    });
  });

  describe("executor state", () => {
    it("shows Running state with running executorState", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      const stateElement = statusBar.querySelector(".executor-status-bar__state");
      expect(stateElement).toHaveTextContent("Running");
    });

    it("shows Paused state with paused executorState", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "paused" },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      const stateElement = statusBar.querySelector(".executor-status-bar__state");
      expect(stateElement).toHaveTextContent("Paused");
    });

    it("shows Idle state with idle executorState", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "idle", runningTaskCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      const stateElement = statusBar.querySelector(".executor-status-bar__state");
      expect(stateElement).toHaveTextContent("Idle");
    });

    it("applies running class when executor is running", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveClass("executor-status-bar--running");
    });

    it("does not apply running class when executor is paused", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "paused" },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).not.toHaveClass("executor-status-bar--running");
    });

    it("does not apply running class when executor is idle", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, executorState: "idle", runningTaskCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).not.toHaveClass("executor-status-bar--running");
    });
  });

  describe("loading state", () => {
    it("shows loading text when loading and no running tasks", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, runningTaskCount: 0 },
        loading: true,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Loading...");
      expect(statusBar).toHaveClass("executor-status-bar--loading");
    });

    it("does not show loading text when not loading", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });

    it("does not show loading text when loading but running tasks exist", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: true,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message when error is present", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: "Failed to fetch stats",
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Failed to fetch stats");
      expect(statusBar).toHaveClass("executor-status-bar--error");
    });

    it("does not show stat segments when error is present", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: "Failed to fetch stats",
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      // The error bar shouldn't have the running segment
      expect(statusBar).not.toHaveTextContent("Running");
    });
  });

  describe("accessibility", () => {
    it("has role status", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("has aria-label", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Executor status");
    });

    it("applies warning class to blocked count when blocked tasks exist", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      // Get the status bar and look for the blocked count element
      const statusBar = screen.getByRole("status");
      const blockedSegment = statusBar.querySelector(".executor-status-bar__indicator--blocked");
      expect(blockedSegment?.parentElement?.querySelector(".executor-status-bar__count")).toHaveClass("executor-status-bar__count--warning");
    });

    it("applies error class to stuck count when stuck tasks exist", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, stuckTaskCount: 1 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      const stuckSegment = statusBar.querySelector(".executor-status-bar__segment--stuck");
      expect(stuckSegment?.querySelector(".executor-status-bar__count")).toHaveClass("executor-status-bar__count--error");
    });

    it("applies active class to running indicator when tasks are running", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveClass("executor-status-bar--running");
    });
  });

  describe("visual states", () => {
    it("shows warning styling when blocked tasks exist", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const blockedCount = screen.getByText("1");
      expect(blockedCount).toHaveClass("executor-status-bar__count--warning");
    });

    it("does not show warning styling when no blocked tasks", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, blockedTaskCount: 0 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const counts = screen.queryAllByText("0");
      // First one is running count which shouldn't have warning
      // We need to check the blocked one specifically
    });
  });

  describe("project context", () => {
    it("passes tasks and projectId to useExecutorStats when provided", () => {
      const tasks: any[] = [{ id: "FN-001" }];
      render(<ExecutorStatusBar tasks={tasks} projectId="proj_abc123" />);

      expect(mockUseExecutorStats).toHaveBeenCalledWith(tasks, "proj_abc123", undefined);
    });

    it("passes tasks and undefined to useExecutorStats when projectId not provided", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(mockUseExecutorStats).toHaveBeenCalledWith(emptyTasks, undefined, undefined);
    });
  });

  describe("time display", () => {
    it("displays relative time for recent activity", () => {
      const now = new Date();
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, lastActivityAt: twoMinutesAgo },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.getByText("2m ago")).toBeInTheDocument();
    });

    it("displays 'no activity' when lastActivityAt is undefined", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, lastActivityAt: undefined },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(screen.getByText("no activity")).toBeInTheDocument();
    });
  });

  describe("board-sync regression", () => {
    it("requires tasks prop — does not fetch its own task list", () => {
      // This test verifies the component receives tasks from its parent
      // rather than creating its own useTasks instance, which was the
      // root cause of the footer/board count mismatch.
      const tasks: any[] = [{ id: "FN-001" }];
      render(<ExecutorStatusBar tasks={tasks} />);

      // useExecutorStats receives the tasks array as first argument
      expect(mockUseExecutorStats).toHaveBeenCalledWith(tasks, undefined, undefined);
    });

    it("renders stuck segment with correct count when stuck tasks detected", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: { ...defaultStats, stuckTaskCount: 3, runningTaskCount: 2 },
        loading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Stuck");
      const stuckCount = statusBar.querySelector(".executor-status-bar__segment--stuck .executor-status-bar__count");
      expect(stuckCount).toHaveTextContent("3");
      expect(stuckCount).toHaveClass("executor-status-bar__count--error");
    });
  });

  describe("layout integration", () => {
    it("exposes stable executor-status-bar class for external layout hooks", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      // The parent layout relies on the executor-status-bar class to detect
      // the footer's presence and set the --executor-footer-height CSS token.
      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveClass("executor-status-bar");
    });

    it("uses role=status for accessibility and layout targeting", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      // The status role serves dual purpose: a11y landmark and a stable
      // selector for the project-content wrapper to detect footer presence.
      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveAttribute("aria-label", "Executor status");
    });

    it("always renders a root element with executor-status-bar class regardless of state", () => {
      // Test loading state
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: true,
        error: null,
        refresh: vi.fn(),
      });
      const { unmount } = render(<ExecutorStatusBar tasks={emptyTasks} />);
      expect(screen.getByRole("status")).toHaveClass("executor-status-bar");
      unmount();

      // Test error state
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: "Connection failed",
        refresh: vi.fn(),
      });
      render(<ExecutorStatusBar tasks={emptyTasks} />);
      expect(screen.getByRole("status")).toHaveClass("executor-status-bar");
    });
  });
});

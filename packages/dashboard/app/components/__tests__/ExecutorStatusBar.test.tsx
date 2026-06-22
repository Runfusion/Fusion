import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExecutorStatusBar } from "../ExecutorStatusBar";

const viewportModeMock = vi.hoisted(() => ({ value: "desktop" as "desktop" | "tablet" | "mobile" }));
const mockFetchScripts = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => viewportModeMock.value,
}));

vi.mock("../../api", () => ({
  fetchScripts: (...args: unknown[]) => mockFetchScripts(...args),
}));

// Mock the useExecutorStats hook
vi.mock("../../hooks/useExecutorStats", () => ({
  useExecutorStats: vi.fn(),
}));

vi.mock("../EngineControlMenu", async () => {
  const React = await import("react");
  return {
    EngineControlMenu: React.forwardRef(function MockEngineControlMenu(_props: unknown, ref) {
      const [open, setOpen] = React.useState(false);
      React.useImperativeHandle(ref, () => ({
        open: () => setOpen(true),
        close: () => setOpen(false),
        toggle: () => setOpen((current) => !current),
      }));
      return (
        <div>
          <button type="button" data-testid="engine-control-menu-trigger" onClick={() => setOpen((current) => !current)}>Engine controls</button>
          {open ? <div role="menu" data-testid="engine-control-menu">Engine menu</div> : null}
        </div>
      );
    }),
  };
});

import { useExecutorStats } from "../../hooks/useExecutorStats";
import type { ExecutorStats } from "../../api";

const mockUseExecutorStats = useExecutorStats as ReturnType<typeof vi.fn>;

/** Minimal empty task list used by tests that mock the hook. */
const emptyTasks: any[] = [];

function makeTask(id: string, column: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    description: `Task ${id}`,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

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
    viewportModeMock.value = "desktop";
    mockFetchScripts.mockResolvedValue({ build: "pnpm build" });
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
      expect(statusBar).not.toHaveTextContent("Escalated");
    });

    it("shows overlap bottleneck summary with stable tie-break ordering", () => {
      const tasks = [
        makeTask("FN-010", "in-progress", { columnMovedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
        makeTask("FN-002", "in-review", { columnMovedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
        makeTask("FN-101", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-102", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-103", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-104", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-105", "todo", { blockedBy: "FN-010" }),
        makeTask("FN-201", "todo", { blockedBy: "FN-002" }),
        makeTask("FN-202", "todo", { blockedBy: "FN-002" }),
        makeTask("FN-203", "todo", { blockedBy: "FN-002" }),
        makeTask("FN-204", "todo", { blockedBy: "FN-002" }),
        makeTask("FN-205", "todo", { blockedBy: "FN-002" }),
      ];

      render(
        <ExecutorStatusBar
          tasks={tasks}
          staleHighFanoutBlockerAgeThresholdMs={60 * 60 * 1000}
        />,
      );

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Overlap queue");
      expect(statusBar).toHaveTextContent("FN-002 · 5 todo");
    });

    it("does not show overlap queue summary for ordinary chains below threshold", () => {
      const tasks = [
        makeTask("FN-500", "in-progress"),
        makeTask("FN-501", "todo", { dependencies: ["FN-500"] }),
        makeTask("FN-502", "todo", { dependencies: ["FN-500"] }),
        makeTask("FN-503", "todo", { dependencies: ["FN-500"] }),
        makeTask("FN-504", "todo", { dependencies: ["FN-500"] }),
      ];

      render(<ExecutorStatusBar tasks={tasks} />);

      expect(screen.getByRole("status")).not.toHaveTextContent("Escalated");
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

    it("renders the terminal launcher in the footer on desktop and opens terminal from the preserved toggle test id", async () => {
      const user = userEvent.setup();
      const onToggleTerminal = vi.fn();
      render(<ExecutorStatusBar tasks={emptyTasks} onToggleTerminal={onToggleTerminal} onOpenScripts={vi.fn()} onRunScript={vi.fn()} />);

      expect(screen.getByTestId("executor-terminal-launcher-segment")).toBeInTheDocument();
      await user.click(screen.getByTestId("terminal-toggle-btn"));

      expect(onToggleTerminal).toHaveBeenCalledTimes(1);
      await user.click(screen.getByTestId("scripts-btn"));

      expect(screen.getByTestId("scripts-btn")).toBeInTheDocument();
      expect(await screen.findByTestId("quick-scripts-dropdown")).toBeInTheDocument();
      await waitFor(() => expect(mockFetchScripts).toHaveBeenCalledWith(undefined));
    });

    it("renders the terminal launcher in the footer on tablet", () => {
      viewportModeMock.value = "tablet";

      render(<ExecutorStatusBar tasks={emptyTasks} onToggleTerminal={vi.fn()} onOpenScripts={vi.fn()} onRunScript={vi.fn()} />);

      expect(screen.getByTestId("executor-terminal-launcher-segment")).toBeInTheDocument();
      expect(screen.getByTestId("terminal-toggle-btn")).toBeInTheDocument();
    });

    it("renders the Quick Chat footer launcher beside Terminal when footer mode is enabled", async () => {
      const user = userEvent.setup();
      const onOpenQuickChat = vi.fn();

      render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          onToggleTerminal={vi.fn()}
          onOpenScripts={vi.fn()}
          onRunScript={vi.fn()}
          quickChatButtonMode="footer"
          onOpenQuickChat={onOpenQuickChat}
        />,
      );

      expect(screen.getByTestId("executor-quick-chat-launcher-segment")).toBeInTheDocument();
      expect(screen.getByTestId("executor-terminal-launcher-segment")).toBeInTheDocument();
      await user.click(screen.getByTestId("executor-quick-chat-launcher"));

      expect(onOpenQuickChat).toHaveBeenCalledTimes(1);
    });

    it("omits the Quick Chat footer launcher for floating, off, and mobile modes", () => {
      const { rerender } = render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          quickChatButtonMode="floating"
          onOpenQuickChat={vi.fn()}
        />,
      );

      expect(screen.queryByTestId("executor-quick-chat-launcher-segment")).toBeNull();

      rerender(
        <ExecutorStatusBar
          tasks={emptyTasks}
          quickChatButtonMode="off"
          onOpenQuickChat={vi.fn()}
        />,
      );
      expect(screen.queryByTestId("executor-quick-chat-launcher-segment")).toBeNull();

      viewportModeMock.value = "mobile";
      rerender(
        <ExecutorStatusBar
          tasks={emptyTasks}
          quickChatButtonMode="footer"
          onOpenQuickChat={vi.fn()}
        />,
      );
      expect(screen.queryByTestId("executor-quick-chat-launcher-segment")).toBeNull();
    });

    it("omits the terminal launcher from the footer on mobile", () => {
      viewportModeMock.value = "mobile";

      render(<ExecutorStatusBar tasks={emptyTasks} onToggleTerminal={vi.fn()} onOpenScripts={vi.fn()} onRunScript={vi.fn()} />);

      expect(screen.queryByTestId("executor-terminal-launcher-segment")).toBeNull();
      expect(screen.queryByTestId("terminal-toggle-btn")).toBeNull();
      expect(screen.queryByTestId("scripts-btn")).toBeNull();
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

    it("renders footer engine controls next to Running state and opens from the small trigger", async () => {
      const user = userEvent.setup();
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar.querySelector(".executor-status-bar__segment--engine-controls")).toHaveTextContent("Running");
      await user.click(screen.getByTestId("engine-control-menu-trigger"));

      expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
    });

    it("opens footer engine controls from the executor state text", async () => {
      const user = userEvent.setup();
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      await user.click(screen.getByTestId("executor-state-engine-control-trigger"));

      expect(screen.getByTestId("engine-control-menu")).toBeInTheDocument();
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

      const statusBar = screen.getByLabelText("Executor status");
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
        error: "Stats unavailable",
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Stats unavailable");
      expect(statusBar).toHaveClass("executor-status-bar--error");
    });

    it("shows connecting state instead of suspension error text", () => {
      vi.mocked(mockUseExecutorStats).mockReturnValue({
        stats: defaultStats,
        loading: false,
        error: "Failed to fetch",
        refresh: vi.fn(),
      });

      render(<ExecutorStatusBar tasks={emptyTasks} />);

      const statusBar = screen.getByRole("status");
      expect(statusBar).toHaveTextContent("Connecting…");
      expect(statusBar).not.toHaveTextContent("Failed to fetch");
      expect(statusBar).toHaveClass("executor-status-bar--connecting");
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

      expect(mockUseExecutorStats).toHaveBeenCalledWith(tasks, "proj_abc123", undefined, undefined);
    });

    it("passes tasks and undefined to useExecutorStats when projectId not provided", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} />);

      expect(mockUseExecutorStats).toHaveBeenCalledWith(emptyTasks, undefined, undefined, undefined);
    });
  });

  describe("project directory toggle", () => {
    it("reveals and hides the project path when the folder toggle is clicked", async () => {
      const user = userEvent.setup();
      render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          currentProjectPath="/workspace/project"
          onOpenProjectDirectory={vi.fn()}
        />
      );

      expect(screen.queryByTestId("executor-project-path-link")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("executor-project-path-toggle"));
      expect(screen.getByTestId("executor-project-path-link")).toHaveTextContent("/workspace/project");

      await user.click(screen.getByTestId("executor-project-path-toggle"));
      expect(screen.queryByTestId("executor-project-path-link")).not.toBeInTheDocument();
    });

    it("calls onOpenProjectDirectory when the visible project path is clicked", async () => {
      const user = userEvent.setup();
      const onOpenProjectDirectory = vi.fn();

      render(
        <ExecutorStatusBar
          tasks={emptyTasks}
          currentProjectPath="/workspace/project"
          onOpenProjectDirectory={onOpenProjectDirectory}
        />
      );

      await user.click(screen.getByTestId("executor-project-path-toggle"));
      await user.click(screen.getByTestId("executor-project-path-link"));

      expect(onOpenProjectDirectory).toHaveBeenCalledTimes(1);
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
      expect(mockUseExecutorStats).toHaveBeenCalledWith(tasks, undefined, undefined, undefined);
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

  describe("mobile keyboard behavior", () => {
    it("hides bar when hideWhenKeyboardOpen is true", () => {
      const { container } = render(<ExecutorStatusBar tasks={emptyTasks} hideWhenKeyboardOpen={true} />);
      expect(container.firstChild).toBeNull();
    });

    it("applies keyboard-open class when keyboardOpen is true", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} keyboardOpen={true} />);
      expect(screen.getByRole("status")).toHaveClass("executor-status-bar--keyboard-open");
    });

    it("does not apply keyboard-open class and remains rendered when keyboardOpen is false", () => {
      render(<ExecutorStatusBar tasks={emptyTasks} keyboardOpen={false} />);
      const status = screen.getByRole("status");
      expect(status).toBeInTheDocument();
      expect(status).not.toHaveClass("executor-status-bar--keyboard-open");
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

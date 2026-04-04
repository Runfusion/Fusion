import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActivityLogModal } from "../ActivityLogModal";
import * as apiModule from "../../api";
import type { ActivityLogEntry } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchActivityFeed: vi.fn(),
  fetchActivityLog: vi.fn(),
  clearActivityLog: vi.fn(),
}));

const mockFetchActivityFeed = vi.mocked(apiModule.fetchActivityFeed);
const mockFetchActivityLog = vi.mocked(apiModule.fetchActivityLog);
const mockClearActivityLog = vi.mocked(apiModule.clearActivityLog);

describe("ActivityLogModal", () => {
  const mockOnClose = vi.fn();
  const mockOnOpenTaskDetail = vi.fn();

  const mockTasks = [
    { id: "FN-001", title: "Test Task 1", column: "todo" as const },
    { id: "FN-002", title: "Test Task 2", column: "in-progress" as const },
  ];

  /** Create entries that match both ActivityLogEntry and the ActivityFeedEntry shape */
  const mockActivityEntries: ActivityLogEntry[] = [
    {
      id: "1",
      timestamp: new Date().toISOString(),
      type: "task:created",
      taskId: "FN-001",
      taskTitle: "Test Task 1",
      details: "Task FN-001 created",
    },
    {
      id: "2",
      timestamp: new Date(Date.now() - 60000).toISOString(),
      type: "task:moved",
      taskId: "FN-001",
      taskTitle: "Test Task 1",
      details: "Task FN-001 moved: todo → in-progress",
      metadata: { from: "todo", to: "in-progress" },
    },
    {
      id: "3",
      timestamp: new Date(Date.now() - 120000).toISOString(),
      type: "task:failed",
      taskId: "FN-002",
      taskTitle: "Test Task 2",
      details: "Task FN-002 failed: Something went wrong",
      metadata: { error: "Something went wrong" },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: per-project log returns entries (single-project mode)
    mockFetchActivityLog.mockResolvedValue(mockActivityEntries);
    // Unified feed also returns entries for multi-project mode tests
    mockFetchActivityFeed.mockResolvedValue(
      mockActivityEntries.map((e) => ({
        ...e,
        projectId: "proj_1",
        projectName: "Test Project",
      })),
    );
    mockClearActivityLog.mockResolvedValue({ success: true });
  });

  it("renders without crashing when open", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("activity-log-modal")).toBeTruthy();
    });
  });

  it("does not render when closed", () => {
    const { container } = render(
      <ActivityLogModal
        isOpen={false}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("displays activity entries correctly", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      const entries = screen.getAllByTestId("activity-entry");
      expect(entries).toHaveLength(3);
    });
  });

  it("calls onClose when close button clicked", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    const closeButton = await screen.findByTestId("activity-close");
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it("calls per-project API on initial load in single-project mode", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      // Single-project mode: uses fetchActivityLog (not fetchActivityFeed)
      expect(mockFetchActivityLog).toHaveBeenCalled();
    });
  });

  it("calls unified feed API when projects are provided but no currentProject (overview mode)", async () => {
    const mockProjects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        projects={mockProjects}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      // Overview mode (no currentProject): uses fetchActivityFeed
      expect(mockFetchActivityFeed).toHaveBeenCalled();
    });
  });

  // ── Regression Tests for FN-820 ────────────────────────────────────
  // The bug was that the modal used the unified central feed whenever projects
  // existed, even in normal project view where per-project activity log should be used.

  it("uses per-project log when currentProject is set even with multiple projects registered", async () => {
    const mockProjects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    const mockCurrentProject = { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        projects={mockProjects}
        currentProject={mockCurrentProject}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      // Project view (currentProject set): uses per-project log even with multiple projects
      expect(mockFetchActivityLog).toHaveBeenCalled();
      expect(mockFetchActivityFeed).not.toHaveBeenCalled();
    });
  });

  it("uses per-project log when currentProject is set and projects list is empty", async () => {
    const mockCurrentProject = { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" };

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        currentProject={mockCurrentProject}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      // Project view: uses per-project log
      expect(mockFetchActivityLog).toHaveBeenCalled();
      expect(mockFetchActivityFeed).not.toHaveBeenCalled();
    });
  });

  it("uses unified feed in overview mode with multiple projects but no currentProject", async () => {
    const mockProjects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        projects={mockProjects}
        // No currentProject - overview mode
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      // Overview mode: uses unified feed
      expect(mockFetchActivityFeed).toHaveBeenCalled();
      expect(mockFetchActivityLog).not.toHaveBeenCalled();
    });
  });

  it("uses per-project log by default when only projectId is passed (backward compatible)", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        projectId="proj_1"
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      // Default behavior without projects: uses per-project log
      expect(mockFetchActivityLog).toHaveBeenCalled();
      expect(mockFetchActivityFeed).not.toHaveBeenCalled();
    });
  });

  it("filters by type when dropdown changed", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    const filterSelect = await screen.findByTestId("activity-filter");
    fireEvent.change(filterSelect, { target: { value: "task:created" } });

    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task:created" }),
      );
    });
  });

  it("calls refresh when refresh button clicked", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    // Wait for initial load
    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledTimes(1);
    });

    const refreshButton = screen.getByTestId("activity-refresh");
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(mockFetchActivityLog).toHaveBeenCalledTimes(2);
    });
  });

  it("shows empty state when no entries", async () => {
    mockFetchActivityLog.mockResolvedValue([]);

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("activity-empty")).toBeTruthy();
    });
  });

  it("shows error state when API fails", async () => {
    mockFetchActivityLog.mockRejectedValue(new Error("API Error"));

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("activity-error")).toBeTruthy();
    });
  });

  it("opens task detail when task link clicked", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      const taskLinks = screen.getAllByTestId("activity-task-link");
      expect(taskLinks.length).toBeGreaterThan(0);
    });

    const taskLink = screen.getAllByTestId("activity-task-link")[0];
    fireEvent.click(taskLink);

    expect(mockOnOpenTaskDetail).toHaveBeenCalled();
  });

  it("shows confirmation dialog when clear clicked", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("activity-clear")).toBeTruthy();
    });

    const clearButton = screen.getByTestId("activity-clear");
    fireEvent.click(clearButton);

    // Check that confirmation dialog appears
    expect(screen.getByText(/Clear Activity Log/i)).toBeTruthy();
  });

  // ── Project Filter Tests ─────────────────────────────────────────

  it("shows project filter when projects provided", async () => {
    const mockProjects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
      { id: "proj_2", name: "Project Two", path: "/path/2", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        projects={mockProjects}
      />
    );

    const projectFilter = await screen.findByTestId("activity-project-filter");
    expect(projectFilter).toBeTruthy();

    // Should have "All Projects" option
    expect(screen.getByText("All Projects")).toBeDefined();
    // Should have project options
    expect(screen.getByText("Project One")).toBeDefined();
    expect(screen.getByText("Project Two")).toBeDefined();
  });

  it("does not show project filter when no projects provided", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("activity-filter")).toBeTruthy();
    });

    // Project filter should not exist
    expect(screen.queryByTestId("activity-project-filter")).toBeNull();
  });

  it("calls onProjectFilterChange when project filter changed", async () => {
    const mockProjects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];
    const onProjectFilterChange = vi.fn();

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        projects={mockProjects}
        onProjectFilterChange={onProjectFilterChange}
      />
    );

    const projectFilter = await screen.findByTestId("activity-project-filter");
    fireEvent.change(projectFilter, { target: { value: "proj_1" } });

    expect(onProjectFilterChange).toHaveBeenCalledWith("proj_1");
  });

  it("shows empty state message mentioning filters when filter is active", async () => {
    mockFetchActivityLog.mockResolvedValue([]);
    mockFetchActivityFeed.mockResolvedValue([]);
    const mockProjects = [
      { id: "proj_1", name: "Project One", path: "/path/1", status: "active" as const, isolationMode: "in-process" as const, createdAt: "", updatedAt: "" },
    ];

    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        projects={mockProjects}
      />
    );

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByTestId("activity-empty")).toBeTruthy();
    });

    // Change the filter to trigger filtered empty state
    const projectFilter = screen.getByTestId("activity-project-filter");
    fireEvent.change(projectFilter, { target: { value: "proj_1" } });

    // Should show filter-specific message
    await waitFor(() => {
      expect(screen.getByText(/No activity matches the current filters/)).toBeTruthy();
    });
  });

  // ── Responsive Layout Regression Tests ───────────────────────────

  it("renders all mobile-responsive CSS classes on the modal structure", async () => {
    const { container } = render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("activity-log-modal")).toBeTruthy();
    });

    // Verify key structural classes that the mobile CSS targets
    const modal = container.querySelector(".activity-log-modal");
    expect(modal).toBeTruthy();
    expect(modal!.querySelector(".activity-log-header")).toBeTruthy();
    expect(modal!.querySelector(".activity-log-title")).toBeTruthy();
    expect(modal!.querySelector(".activity-log-actions")).toBeTruthy();
    expect(modal!.querySelector(".activity-log-content")).toBeTruthy();
    expect(modal!.querySelector(".activity-log-list")).toBeTruthy();
    expect(modal!.querySelector(".activity-log-entry")).toBeTruthy();
  });

  it("renders entry header and details within each entry for mobile reflow", async () => {
    const { container } = render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("activity-entry")).toHaveLength(3);
    });

    // Each entry should have the inner structure that mobile CSS reflows
    const entries = container.querySelectorAll(".activity-log-entry");
    for (const entry of entries) {
      expect(entry.querySelector(".activity-log-entry-icon")).toBeTruthy();
      expect(entry.querySelector(".activity-log-entry-content")).toBeTruthy();
      expect(entry.querySelector(".activity-log-entry-header")).toBeTruthy();
      expect(entry.querySelector(".activity-log-entry-type")).toBeTruthy();
      expect(entry.querySelector(".activity-log-entry-time")).toBeTruthy();
      expect(entry.querySelector(".activity-log-entry-details")).toBeTruthy();
    }
  });

  it("renders active-filters bar with correct classes when filter is active", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    // Apply a type filter to show the active-filters bar
    const filterSelect = await screen.findByTestId("activity-filter");
    fireEvent.change(filterSelect, { target: { value: "task:created" } });

    await waitFor(() => {
      const activeFilters = document.querySelector(".activity-log-active-filters");
      expect(activeFilters).toBeTruthy();
      expect(activeFilters!.querySelector(".activity-log-filter-label")).toBeTruthy();
      expect(activeFilters!.querySelector(".activity-log-filter-badge")).toBeTruthy();
      expect(activeFilters!.querySelector(".activity-log-clear-filters")).toBeTruthy();
    });
  });

  it("renders clear-confirmation dialog with stacked action classes", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("activity-clear")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("activity-clear"));

    // Confirm dialog has the structure that mobile CSS stacks
    const overlay = document.querySelector(".activity-log-confirm-overlay");
    expect(overlay).toBeTruthy();
    const dialog = overlay!.querySelector(".activity-log-confirm-dialog");
    expect(dialog).toBeTruthy();
    const actions = dialog!.querySelector(".activity-log-confirm-actions");
    expect(actions).toBeTruthy();
    expect(actions!.querySelector(".activity-log-confirm-cancel")).toBeTruthy();
    expect(actions!.querySelector(".activity-log-confirm-clear")).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActivityLogModal } from "../ActivityLogModal";
import * as apiModule from "../../api";
import type { ActivityLogEntry } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchActivityFeed: vi.fn(),
  clearActivityLog: vi.fn(),
}));

const mockFetchActivityFeed = vi.mocked(apiModule.fetchActivityFeed);
const mockClearActivityLog = vi.mocked(apiModule.clearActivityLog);

describe("ActivityLogModal", () => {
  const mockOnClose = vi.fn();
  const mockOnOpenTaskDetail = vi.fn();

  const mockTasks = [
    { id: "FN-001", title: "Test Task 1", column: "todo" as const },
    { id: "FN-002", title: "Test Task 2", column: "in-progress" as const },
  ];

  const mockActivityEntries: ActivityLogEntry[] = [
    {
      id: "1",
      timestamp: new Date().toISOString(),
      type: "task:created",
      taskId: "FN-001",
      taskTitle: "Test Task 1",
      details: "Task KB-001 created",
    },
    {
      id: "2",
      timestamp: new Date(Date.now() - 60000).toISOString(),
      type: "task:moved",
      taskId: "FN-001",
      taskTitle: "Test Task 1",
      details: "Task KB-001 moved: todo → in-progress",
      metadata: { from: "todo", to: "in-progress" },
    },
    {
      id: "3",
      timestamp: new Date(Date.now() - 120000).toISOString(),
      type: "task:failed",
      taskId: "FN-002",
      taskTitle: "Test Task 2",
      details: "Task KB-002 failed: Something went wrong",
      metadata: { error: "Something went wrong" },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchActivityFeed.mockResolvedValue(mockActivityEntries);
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

  it("calls API on initial load", async () => {
    render(
      <ActivityLogModal
        isOpen={true}
        onClose={mockOnClose}
        tasks={mockTasks}
        onOpenTaskDetail={mockOnOpenTaskDetail}
      />
    );

    await waitFor(() => {
      expect(mockFetchActivityFeed).toHaveBeenCalled();
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
      expect(mockFetchActivityFeed).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task:created" })
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
      expect(mockFetchActivityFeed).toHaveBeenCalledTimes(1);
    });

    const refreshButton = screen.getByTestId("activity-refresh");
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(mockFetchActivityFeed).toHaveBeenCalledTimes(2);
    });
  });

  it("shows empty state when no entries", async () => {
    mockFetchActivityFeed.mockResolvedValue([]);

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
    mockFetchActivityFeed.mockRejectedValue(new Error("API Error"));

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
});

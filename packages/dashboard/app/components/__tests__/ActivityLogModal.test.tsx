import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActivityLogModal } from "../ActivityLogModal";
import * as apiModule from "../../api";
import type { ActivityLogEntry } from "@kb/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchActivityLog: vi.fn(),
  clearActivityLog: vi.fn(),
}));

const mockFetchActivityLog = vi.mocked(apiModule.fetchActivityLog);
const mockClearActivityLog = vi.mocked(apiModule.clearActivityLog);

describe("ActivityLogModal", () => {
  const mockOnClose = vi.fn();
  const mockOnOpenTaskDetail = vi.fn();

  const mockTasks = [
    { id: "KB-001", title: "Test Task 1", column: "todo" as const },
    { id: "KB-002", title: "Test Task 2", column: "in-progress" as const },
  ];

  const mockActivityEntries: ActivityLogEntry[] = [
    {
      id: "1",
      timestamp: new Date().toISOString(),
      type: "task:created",
      taskId: "KB-001",
      taskTitle: "Test Task 1",
      details: "Task KB-001 created",
    },
    {
      id: "2",
      timestamp: new Date(Date.now() - 60000).toISOString(),
      type: "task:moved",
      taskId: "KB-001",
      taskTitle: "Test Task 1",
      details: "Task KB-001 moved: todo → in-progress",
      metadata: { from: "todo", to: "in-progress" },
    },
    {
      id: "3",
      timestamp: new Date(Date.now() - 120000).toISOString(),
      type: "task:failed",
      taskId: "KB-002",
      taskTitle: "Test Task 2",
      details: "Task KB-002 failed: Something went wrong",
      metadata: { error: "Something went wrong" },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchActivityLog.mockResolvedValue(mockActivityEntries);
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
      expect(mockFetchActivityLog).toHaveBeenCalled();
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
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduledTasksModal } from "../ScheduledTasksModal";
import type { ScheduledTask, AutomationRunResult } from "@kb/core";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus">+</span>,
  Clock: (props: any) => <span data-testid="icon-clock" style={props.strokeWidth ? {} : {}}>🕐</span>,
  Play: () => <span data-testid="icon-play">▶</span>,
  Pause: () => <span data-testid="icon-pause">⏸</span>,
  Pencil: () => <span data-testid="icon-pencil">✎</span>,
  Trash2: () => <span data-testid="icon-trash">🗑</span>,
  CheckCircle: () => <span data-testid="icon-check">✓</span>,
  XCircle: () => <span data-testid="icon-x">✗</span>,
  ChevronDown: () => <span data-testid="icon-down">▼</span>,
  ChevronUp: () => <span data-testid="icon-up">▲</span>,
}));

// Mock @kb/core (no runtime values needed — ScheduleForm inlines presets)
vi.mock("@kb/core", () => ({}));

// Mock the API module
const mockFetchAutomations = vi.fn();
const mockCreateAutomation = vi.fn();
const mockUpdateAutomation = vi.fn();
const mockDeleteAutomation = vi.fn();
const mockRunAutomation = vi.fn();
const mockToggleAutomation = vi.fn();

vi.mock("../../api", () => ({
  fetchAutomations: (...args: any[]) => mockFetchAutomations(...args),
  createAutomation: (...args: any[]) => mockCreateAutomation(...args),
  updateAutomation: (...args: any[]) => mockUpdateAutomation(...args),
  deleteAutomation: (...args: any[]) => mockDeleteAutomation(...args),
  runAutomation: (...args: any[]) => mockRunAutomation(...args),
  toggleAutomation: (...args: any[]) => mockToggleAutomation(...args),
}));

function makeSchedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sched-1",
    name: "Test Schedule",
    description: "A test",
    scheduleType: "daily",
    cronExpression: "0 0 * * *",
    command: "echo hello",
    enabled: true,
    runCount: 0,
    runHistory: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScheduledTasksModal", () => {
  const onClose = vi.fn();
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAutomations.mockResolvedValue([]);
  });

  it("renders modal with title", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    expect(screen.getByText("Scheduled Tasks")).toBeDefined();
  });

  it("has role=dialog and aria-labelledby", () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute("aria-labelledby")).toBe("schedules-modal-title");
  });

  it("shows loading state initially", () => {
    mockFetchAutomations.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    expect(screen.getByText("Loading schedules…")).toBeDefined();
  });

  it("shows empty state when no schedules", async () => {
    mockFetchAutomations.mockResolvedValue([]);
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => {
      expect(screen.getByText("No scheduled tasks yet")).toBeDefined();
    });
    expect(screen.getByText("Create your first schedule")).toBeDefined();
  });

  it("shows schedule cards when schedules exist", async () => {
    mockFetchAutomations.mockResolvedValue([makeSchedule({ name: "My Job" })]);
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => {
      expect(screen.getByText("My Job")).toBeDefined();
    });
  });

  it("shows New Schedule button when schedules exist", async () => {
    mockFetchAutomations.mockResolvedValue([makeSchedule()]);
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => {
      expect(screen.getByText("New Schedule")).toBeDefined();
    });
  });

  it("calls onClose when close button is clicked", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when overlay is clicked", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    const overlay = screen.getByRole("dialog").parentElement!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape when in list view", async () => {
    render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
    await waitFor(() => {
      expect(screen.getByText("No scheduled tasks yet")).toBeDefined();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  describe("create flow", () => {
    it("shows create form when clicking New Schedule", async () => {
      mockFetchAutomations.mockResolvedValue([makeSchedule()]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("New Schedule")).toBeDefined();
      });
      fireEvent.click(screen.getByText("New Schedule"));
      expect(screen.getByText("New Schedule", { selector: "h4" })).toBeDefined();
      expect(screen.getByLabelText("Name")).toBeDefined();
    });

    it("shows create form from empty state CTA button", async () => {
      mockFetchAutomations.mockResolvedValue([]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("Create your first schedule")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Create your first schedule"));
      expect(screen.getByLabelText("Name")).toBeDefined();
    });

    it("goes back to list on Escape from create form", async () => {
      mockFetchAutomations.mockResolvedValue([makeSchedule()]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("New Schedule")).toBeDefined();
      });
      fireEvent.click(screen.getByText("New Schedule"));
      expect(screen.getByLabelText("Name")).toBeDefined();
      fireEvent.keyDown(document, { key: "Escape" });
      // Should not close the modal, just go back to list
      expect(onClose).not.toHaveBeenCalled();
    });

    it("creates schedule and returns to list on success", async () => {
      const created = makeSchedule({ name: "New Job" });
      mockFetchAutomations
        .mockResolvedValueOnce([]) // initial load
        .mockResolvedValueOnce([created]); // after create
      mockCreateAutomation.mockResolvedValue(created);

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("Create your first schedule")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Create your first schedule"));

      // Fill form
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Job" } });
      fireEvent.change(screen.getByLabelText("Command"), { target: { value: "echo test" } });
      fireEvent.click(screen.getByText("Create Schedule"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Schedule created", "success");
      });
    });
  });

  describe("toggle", () => {
    it("calls toggleAutomation and shows toast", async () => {
      const schedule = makeSchedule({ name: "My Job", enabled: true });
      mockFetchAutomations.mockResolvedValue([schedule]);
      mockToggleAutomation.mockResolvedValue({ ...schedule, enabled: false });

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("My Job")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Disable My Job"));

      await waitFor(() => {
        expect(mockToggleAutomation).toHaveBeenCalledWith("sched-1");
        expect(addToast).toHaveBeenCalledWith('"My Job" disabled', "success");
      });
    });
  });

  describe("delete", () => {
    it("calls deleteAutomation after confirm", async () => {
      const schedule = makeSchedule({ name: "My Job" });
      mockFetchAutomations.mockResolvedValue([schedule]);
      mockDeleteAutomation.mockResolvedValue(schedule);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("My Job")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Delete My Job"));

      await waitFor(() => {
        expect(mockDeleteAutomation).toHaveBeenCalledWith("sched-1");
        expect(addToast).toHaveBeenCalledWith('Deleted "My Job"', "success");
      });

      confirmSpy.mockRestore();
    });
  });

  describe("manual run", () => {
    it("calls runAutomation and shows success toast", async () => {
      const schedule = makeSchedule({ name: "My Job" });
      mockFetchAutomations.mockResolvedValue([schedule]);
      const result: AutomationRunResult = {
        success: true,
        output: "ok",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      };
      mockRunAutomation.mockResolvedValue({ schedule, result });

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("My Job")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Run My Job now"));

      await waitFor(() => {
        expect(mockRunAutomation).toHaveBeenCalledWith("sched-1");
        expect(addToast).toHaveBeenCalledWith('"My Job" completed successfully', "success");
      });
    });

    it("shows error toast when run fails", async () => {
      const schedule = makeSchedule({ name: "My Job" });
      mockFetchAutomations.mockResolvedValue([schedule]);
      const result: AutomationRunResult = {
        success: false,
        output: "",
        error: "Command not found",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      };
      mockRunAutomation.mockResolvedValue({ schedule, result });

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("My Job")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Run My Job now"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.stringContaining("Command not found"),
          "error",
        );
      });
    });
  });

  describe("error handling", () => {
    it("shows error toast when loading fails", async () => {
      mockFetchAutomations.mockRejectedValue(new Error("Network error"));
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Network error", "error");
      });
    });
  });
});

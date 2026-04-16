import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduledTasksModal } from "../ScheduledTasksModal";
import type { ScheduledTask, AutomationRunResult, Routine } from "@fusion/core";

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
  Calendar: () => <span data-testid="icon-calendar">📅</span>,
  Webhook: () => <span data-testid="icon-webhook">🔗</span>,
  Code: () => <span data-testid="icon-code">💻</span>,
  Zap: () => <span data-testid="icon-zap">⚡</span>,
  Globe: () => <span data-testid="icon-globe">🌍</span>,
  Folder: () => <span data-testid="icon-folder">📁</span>,
}));

// Mock @fusion/core (no runtime values needed — ScheduleForm inlines presets)
vi.mock("@fusion/core", () => ({}));

// Mock the API module
const mockFetchAutomations = vi.fn();
const mockCreateAutomation = vi.fn();
const mockUpdateAutomation = vi.fn();
const mockDeleteAutomation = vi.fn();
const mockRunAutomation = vi.fn();
const mockToggleAutomation = vi.fn();
const mockFetchRoutines = vi.fn();
const mockCreateRoutine = vi.fn();
const mockUpdateRoutine = vi.fn();
const mockDeleteRoutine = vi.fn();
const mockRunRoutine = vi.fn();

vi.mock("../../api", () => ({
  fetchAutomations: (...args: any[]) => mockFetchAutomations(...args),
  createAutomation: (...args: any[]) => mockCreateAutomation(...args),
  updateAutomation: (...args: any[]) => mockUpdateAutomation(...args),
  deleteAutomation: (...args: any[]) => mockDeleteAutomation(...args),
  runAutomation: (...args: any[]) => mockRunAutomation(...args),
  toggleAutomation: (...args: any[]) => mockToggleAutomation(...args),
  fetchRoutines: (...args: any[]) => mockFetchRoutines(...args),
  createRoutine: (...args: any[]) => mockCreateRoutine(...args),
  updateRoutine: (...args: any[]) => mockUpdateRoutine(...args),
  deleteRoutine: (...args: any[]) => mockDeleteRoutine(...args),
  runRoutine: (...args: any[]) => mockRunRoutine(...args),
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
  }),
}));

// Mock CustomModelDropdown
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, disabled, models }: any) => (
    <select
      data-testid="model-dropdown"
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      <option value="">Use default</option>
      {models?.map((m: any) => (
        <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
          {m.name}
        </option>
      ))}
    </select>
  ),
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

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-001",
    name: "Test Routine",
    description: "A test routine",
    trigger: { type: "cron", cronExpression: "0 * * * *" },
    executionPolicy: "queue",
    catchUpPolicy: "run_one",
    enabled: true,
    runCount: 0,
    runHistory: [],
    createdAt: "2026-04-07T00:00:00.000Z",
    updatedAt: "2026-04-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScheduledTasksModal", () => {
  const onClose = vi.fn();
  const addToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAutomations.mockResolvedValue([]);
    mockFetchRoutines.mockResolvedValue([]);
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

  describe("Scope behavior", () => {
    it("defaults to global scope when no projectId provided", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("No scheduled tasks yet")).toBeDefined();
      });
      // Verify fetchAutomations was called with global scope
      expect(mockFetchAutomations).toHaveBeenCalledWith({ scope: "global" });
    });

    it("defaults to project scope when projectId is provided", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} projectId="proj-123" />);
      await waitFor(() => {
        expect(screen.getByText("No scheduled tasks yet")).toBeDefined();
      });
      // Verify fetchAutomations was called with project scope and projectId
      expect(mockFetchAutomations).toHaveBeenCalledWith({ scope: "project", projectId: "proj-123" });
    });

    it("forwards projectId to fetchRoutines when projectId is provided", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} projectId="proj-456" />);
      await waitFor(() => {
        expect(screen.getByText("No scheduled tasks yet")).toBeDefined();
      });
      // Verify fetchRoutines was called with project scope and projectId
      expect(mockFetchRoutines).toHaveBeenCalledWith({ scope: "project", projectId: "proj-456" });
    });

    it("can switch from global to project scope and reloads data", async () => {
      mockFetchAutomations.mockResolvedValue([makeSchedule({ name: "Test Job" })]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} projectId="proj-789" />);
      
      // Initial load with project scope
      await waitFor(() => {
        expect(mockFetchAutomations).toHaveBeenCalledWith({ scope: "project", projectId: "proj-789" });
      });
      
      // Clear mocks to track the reload after scope switch
      mockFetchAutomations.mockClear();
      
      // Click the global scope button
      const globalBtn = screen.getByRole("button", { name: /global/i });
      fireEvent.click(globalBtn);
      
      // Should reload with global scope
      await waitFor(() => {
        expect(mockFetchAutomations).toHaveBeenCalledWith({ scope: "global" });
      });
    });

    it("switches from project to global scope and reloads data", async () => {
      mockFetchAutomations.mockResolvedValue([makeSchedule({ name: "Test Job" })]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      
      // Initial load with global scope
      await waitFor(() => {
        expect(mockFetchAutomations).toHaveBeenCalledWith({ scope: "global" });
      });
      
      // Clear mocks to track the reload after scope switch
      mockFetchAutomations.mockClear();
      
      // Click the project scope button
      const projectBtn = screen.getByRole("button", { name: /project/i });
      fireEvent.click(projectBtn);
      
      // Should reload with project scope (but no projectId available, so falls back to global)
      await waitFor(() => {
        expect(mockFetchAutomations).toHaveBeenCalledWith({ scope: "project" });
      });
    });

    it("resets view to list when switching scope", async () => {
      mockFetchAutomations.mockResolvedValue([makeSchedule({ name: "Test Job" })]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      
      await waitFor(() => {
        expect(screen.getByText("New Schedule")).toBeDefined();
      });
      
      // Open create form
      fireEvent.click(screen.getByText("New Schedule"));
      await waitFor(() => {
        expect(screen.getByText("New Schedule", { selector: "h4" })).toBeDefined();
      });
      
      // Clear mocks
      mockFetchAutomations.mockClear();
      
      // Switch scope - should reset to list view
      const globalBtn = screen.getByRole("button", { name: /global/i });
      fireEvent.click(globalBtn);
      
      await waitFor(() => {
        // Should be back to list view, not create form
        expect(screen.queryByText("New Schedule", { selector: "h4" })).toBeNull();
        expect(screen.getByText("Test Job")).toBeDefined();
      });
    });
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

    it("changing scope in create form updates modal's activeScope and reloads data", async () => {
      const schedule = makeSchedule({ name: "Test Job" });
      mockFetchAutomations
        .mockResolvedValueOnce([schedule]) // initial load with project scope
        .mockResolvedValueOnce([]); // reload with global scope after scope switch
      mockCreateAutomation.mockResolvedValue(schedule);

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} projectId="proj-123" />);
      
      // Initial load with project scope
      await waitFor(() => {
        expect(mockFetchAutomations).toHaveBeenCalledWith({ scope: "project", projectId: "proj-123" });
        expect(screen.getByText("Test Job")).toBeDefined();
      });
      
      // Open create form
      fireEvent.click(screen.getByText("New Schedule"));
      await waitFor(() => {
        expect(screen.getByText("New Schedule", { selector: "h4" })).toBeDefined();
      });
      
      // Clear mocks to track reload
      mockFetchAutomations.mockClear();
      
      // Click Global scope button in the form (note: icon chars in accessible name)
      const globalBtn = screen.getByRole("radio", { name: "🌍Global" });
      fireEvent.click(globalBtn);
      
      // Modal should reload with global scope
      await waitFor(() => {
        expect(mockFetchAutomations).toHaveBeenCalledWith({ scope: "global" });
      });
      
      // Should be back in list view
      await waitFor(() => {
        expect(screen.queryByText("New Schedule", { selector: "h4" })).toBeNull();
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
        expect(mockToggleAutomation).toHaveBeenCalledWith("sched-1", { scope: "global" });
        expect(addToast).toHaveBeenCalledWith('"My Job" disabled', "success");
      });
    });

    it("forwards projectId when projectId is provided", async () => {
      const schedule = makeSchedule({ name: "My Job", enabled: true });
      mockFetchAutomations.mockResolvedValue([schedule]);
      mockToggleAutomation.mockResolvedValue({ ...schedule, enabled: false });

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} projectId="proj-123" />);
      await waitFor(() => {
        expect(screen.getByText("My Job")).toBeDefined();
      });

      fireEvent.click(screen.getByLabelText("Disable My Job"));

      await waitFor(() => {
        expect(mockToggleAutomation).toHaveBeenCalledWith("sched-1", { scope: "project", projectId: "proj-123" });
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
        expect(mockDeleteAutomation).toHaveBeenCalledWith("sched-1", { scope: "global" });
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
        expect(mockRunAutomation).toHaveBeenCalledWith("sched-1", { scope: "global" });
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

  // ── Routine Tab Tests ─────────────────────────────────────────────────────

  describe("Tab navigation", () => {
    it("shows both Schedules and Routines tabs", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("Schedules")).toBeDefined();
        expect(screen.getByText("Routines")).toBeDefined();
      });
    });

    it("defaults to Schedules tab", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("No scheduled tasks yet")).toBeDefined();
      });
    });

    it("clicking Routines tab switches to routines view", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("Schedules")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("No routines yet")).toBeDefined();
      });
    });

    it("clicking Schedules tab switches back to schedules view", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      // Switch to Routines
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("No routines yet")).toBeDefined();
      });
      // Switch back to Schedules
      fireEvent.click(screen.getByText("Schedules"));
      await waitFor(() => {
        expect(screen.getByText("No scheduled tasks yet")).toBeDefined();
      });
    });

    it("switching tabs resets sub-views", async () => {
      mockFetchAutomations.mockResolvedValue([makeSchedule()]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      await waitFor(() => {
        expect(screen.getByText("New Schedule")).toBeDefined();
      });

      // Open create form
      fireEvent.click(screen.getByText("New Schedule"));
      expect(screen.getByText("New Schedule", { selector: "h4" })).toBeDefined();

      // Switch to Routines tab
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("No routines yet")).toBeDefined();
      });

      // Switch back to Schedules - should be in list view, not create
      fireEvent.click(screen.getByText("Schedules"));
      await waitFor(() => {
        expect(screen.queryByText("New Schedule", { selector: "h4" })).toBeNull();
        expect(screen.getByText("New Schedule")).toBeDefined(); // The button
      });
    });
  });

  describe("Routines list", () => {
    it("shows empty state when no routines exist", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("No routines yet")).toBeDefined();
        expect(screen.getByText("Create your first routine")).toBeDefined();
      });
    });

    it("shows routine cards when routines exist", async () => {
      mockFetchRoutines.mockResolvedValue([makeRoutine({ name: "My Routine" })]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("My Routine")).toBeDefined();
      });
    });

    it('shows "New Routine" button when routines exist', async () => {
      mockFetchRoutines.mockResolvedValue([makeRoutine()]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("New Routine")).toBeDefined();
      });
    });
  });

  describe("Routines create flow", () => {
    it('shows RoutineEditor when clicking "New Routine"', async () => {
      mockFetchRoutines.mockResolvedValue([makeRoutine()]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("New Routine")).toBeDefined();
      });
      fireEvent.click(screen.getByText("New Routine"));
      await waitFor(() => {
        expect(screen.getByText("New Routine", { selector: "h4" })).toBeDefined();
      });
    });

    it("shows RoutineEditor from empty state CTA", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("Create your first routine")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Create your first routine"));
      await waitFor(() => {
        expect(screen.getByText("New Routine", { selector: "h4" })).toBeDefined();
      });
    });

    it("returns to list on Escape from create form", async () => {
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("Create your first routine")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Create your first routine"));
      expect(screen.getByText("New Routine", { selector: "h4" })).toBeDefined();
      fireEvent.keyDown(document, { key: "Escape" });
      // Should not close the modal, just go back to list
      expect(onClose).not.toHaveBeenCalled();
    });

    it("creates routine and returns to list on success", async () => {
      const created = makeRoutine({ name: "New Routine" });
      mockFetchRoutines
        .mockResolvedValueOnce([]) // initial load
        .mockResolvedValueOnce([created]); // after create
      mockCreateRoutine.mockResolvedValue(created);

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("Create your first routine")).toBeDefined();
      });
      fireEvent.click(screen.getByText("Create your first routine"));

      // Fill form
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Routine" } });
      fireEvent.click(screen.getByText("Create Routine"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Routine created", "success");
      });
    });
  });

  describe("Routines edit flow", () => {
    it("shows RoutineEditor with pre-filled data when editing", async () => {
      const routine = makeRoutine({ name: "My Routine" });
      mockFetchRoutines.mockResolvedValue([routine]);
      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("My Routine")).toBeDefined();
      });
      fireEvent.click(screen.getByLabelText("Edit My Routine"));
      await waitFor(() => {
        expect(screen.getByText("Edit Routine", { selector: "h4" })).toBeDefined();
        expect(screen.getByLabelText("Name")).toHaveValue("My Routine");
      });
    });

    it("updates routine and returns to list on success", async () => {
      const routine = makeRoutine({ name: "My Routine" });
      const updated = { ...routine, name: "Updated Routine" };
      mockFetchRoutines
        .mockResolvedValueOnce([routine]) // initial load
        .mockResolvedValueOnce([updated]); // after update
      mockUpdateRoutine.mockResolvedValue(updated);

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("My Routine")).toBeDefined();
      });
      fireEvent.click(screen.getByLabelText("Edit My Routine"));
      await waitFor(() => {
        expect(screen.getByLabelText("Name")).toHaveValue("My Routine");
      });
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Updated Routine" } });
      fireEvent.click(screen.getByText("Save Changes"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith("Routine updated", "success");
      });
    });
  });

  describe("Routines run", () => {
    it("calls runRoutine and shows success toast", async () => {
      const routine = makeRoutine({ name: "My Routine" });
      mockFetchRoutines.mockResolvedValue([routine]);
      const result = {
        routineId: routine.id,
        success: true,
        output: "Done",
        startedAt: "2026-04-08T00:00:00.000Z",
        completedAt: "2026-04-08T00:01:00.000Z",
      };
      mockRunRoutine.mockResolvedValue({ result });

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("My Routine")).toBeDefined();
      });
      fireEvent.click(screen.getByLabelText("Run My Routine now"));

      await waitFor(() => {
        expect(mockRunRoutine).toHaveBeenCalledWith("routine-001", { scope: "global" });
        expect(addToast).toHaveBeenCalledWith('"My Routine" completed successfully', "success");
      });
    });

    it("shows error toast when run fails", async () => {
      const routine = makeRoutine({ name: "My Routine" });
      mockFetchRoutines.mockResolvedValue([routine]);
      const result = {
        routineId: routine.id,
        success: false,
        error: "Failed",
        startedAt: "2026-04-08T00:00:00.000Z",
        completedAt: "2026-04-08T00:01:00.000Z",
      };
      mockRunRoutine.mockResolvedValue({ result });

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("My Routine")).toBeDefined();
      });
      fireEvent.click(screen.getByLabelText("Run My Routine now"));

      await waitFor(() => {
        expect(addToast).toHaveBeenCalledWith(
          expect.stringContaining("Failed"),
          "error",
        );
      });
    });
  });

  describe("Routines delete", () => {
    it("calls deleteRoutine after confirm dialog", async () => {
      const routine = makeRoutine({ name: "My Routine" });
      mockFetchRoutines.mockResolvedValue([routine]);
      mockDeleteRoutine.mockResolvedValue(undefined);
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("My Routine")).toBeDefined();
      });
      fireEvent.click(screen.getByLabelText("Delete My Routine"));

      await waitFor(() => {
        expect(mockDeleteRoutine).toHaveBeenCalledWith("routine-001", { scope: "global" });
        expect(addToast).toHaveBeenCalledWith('Deleted "My Routine"', "success");
      });

      confirmSpy.mockRestore();
    });
  });

  describe("Routines toggle", () => {
    it("calls updateRoutine with flipped enabled state", async () => {
      const routine = makeRoutine({ name: "My Routine", enabled: true });
      const updated = { ...routine, enabled: false };
      mockFetchRoutines.mockResolvedValue([routine]);
      mockUpdateRoutine.mockResolvedValue(updated);

      render(<ScheduledTasksModal onClose={onClose} addToast={addToast} />);
      fireEvent.click(screen.getByText("Routines"));
      await waitFor(() => {
        expect(screen.getByText("My Routine")).toBeDefined();
      });
      fireEvent.click(screen.getByLabelText("Disable My Routine"));

      await waitFor(() => {
        expect(mockUpdateRoutine).toHaveBeenCalledWith("routine-001", { enabled: false }, { scope: "global" });
        expect(addToast).toHaveBeenCalledWith('"My Routine" disabled', "success");
      });
    });
  });
});
